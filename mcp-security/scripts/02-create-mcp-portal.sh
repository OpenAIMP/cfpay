#!/usr/bin/env bash
# =============================================================================
# 02-create-mcp-portal.sh
# =============================================================================
# Creates the MCP server portal that fronts the upstream MCP server:
#   - DNS CNAME mcp.openaimp.com -> gateway.agents.cloudflare.com (proxied)
#   - Registers the upstream server (auth_type "none" while it is unauthenticated)
#   - Creates the portal and ASSOCIATES the server with it
#   - Triggers a capability sync, and waits until the server reports Ready
#   - Saves .portal-state for the later steps
#
# Idempotent: every object is looked up by name before being created, so a re-run
# reconciles rather than duplicating.
#
# Synthesised from two earlier revisions. The association and the readiness wait
# come from the concise revision, which created them at portal-creation time; the
# named DNS record, the "server may already exist" recovery and the device flow
# header come from the longer one.
#
# Ordering note: the DNS record deliberately precedes portal creation, because
# the portal cannot serve until its hostname resolves.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"

load_env

# Load IdP IDs recorded by step 1, so the portal can advertise only the
# providers that actually exist.
IDP_FILE="${SCRIPT_DIR}/../.idp-ids"
if [[ -f "$IDP_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$IDP_FILE"
fi

echo ""
info "=== Step 2: Create MCP Server Portal ==="
echo ""

# ---------------------------------------------------------------------------
# 2a. DNS CNAME for the portal hostname
#     Portal hostnames must CNAME to gateway.agents.cloudflare.com.
#     CF_ACCOUNT_ID is sent so this works for both account-scoped and
#     zone-scoped tokens.
# ---------------------------------------------------------------------------
info "Creating DNS CNAME record for ${PORTAL_HOSTNAME}..."

EXISTING_DNS=$(cf_zone_api GET "/dns_records?name=${PORTAL_HOSTNAME}&type=CNAME")
EXISTING_DNS_ID=$(echo "$EXISTING_DNS" | jq -r '.result[0].id // empty')

if [[ -n "$EXISTING_DNS_ID" ]]; then
  ok "DNS CNAME already exists for ${PORTAL_HOSTNAME} (ID: ${EXISTING_DNS_ID})"
else
  DNS_RESPONSE=$(cf_zone_api POST /dns_records '{
    "type": "CNAME",
    "name": "'"${PORTAL_SUBDOMAIN}"'",
    "content": "gateway.agents.cloudflare.com",
    "proxied": true,
    "comment": "MCP Portal endpoint"
  }')

  if check_result "$DNS_RESPONSE"; then
    ok "DNS CNAME created: ${PORTAL_HOSTNAME} -> gateway.agents.cloudflare.com (proxied)"
  else
    error "Failed to create DNS CNAME record"
    exit 1
  fi
fi

echo ""

# ---------------------------------------------------------------------------
# 2b. Register the upstream MCP server
#     auth_type "none" because the upstream is currently unauthenticated;
#     Cloudflare Access is what adds authentication in front of it.
# ---------------------------------------------------------------------------
info "Registering upstream MCP server: ${MCP_SERVER_NAME}..."

SERVER_RESPONSE=$(cf_api POST /access/ai-controls/mcp/servers '{
  "name": "'"${MCP_SERVER_NAME}"'",
  "url": "'"${UPSTREAM_MCP_URL}"'",
  "auth_type": "none"
}')

if check_result "$SERVER_RESPONSE"; then
  MCP_SERVER_ID=$(get_result "$SERVER_RESPONSE" '.result.id')
  ok "MCP server registered (ID: ${MCP_SERVER_ID})"
else
  warn "Server may already exist, looking it up..."
  EXISTING_SERVERS=$(cf_api GET /access/ai-controls/mcp/servers)
  MCP_SERVER_ID=$(echo "$EXISTING_SERVERS" | jq -r --arg name "$MCP_SERVER_NAME" \
    '.result[] | select(.name==$name) | .id' | head -1)
  if [[ -n "$MCP_SERVER_ID" ]]; then
    ok "MCP server already exists (ID: ${MCP_SERVER_ID})"
  else
    error "Failed to register MCP server"
    echo "$SERVER_RESPONSE" | jq '.errors' >&2
    exit 1
  fi
fi

echo ""

# ---------------------------------------------------------------------------
# 2c. Create the portal and associate the server with it
#     The server is attached in the create call: a portal with no servers
#     exposes nothing, and clients see an empty tool list.
# ---------------------------------------------------------------------------
info "Creating MCP portal: ${PORTAL_NAME}..."

# Advertise only the IdPs that step 1 actually configured. An empty list means
# "whatever the organisation has", which is the right default for a fresh setup.
ALLOWED_IDPS="[]"
for idp_id in "${OTP_IDP_ID:-}" "${CF_IDP_ID:-}" "${GOOGLE_IDP_ID:-}" "${GITHUB_IDP_ID:-}" "${OKTA_IDP_ID:-}"; do
  if [[ -n "$idp_id" ]]; then
    ALLOWED_IDPS=$(echo "$ALLOWED_IDPS" | jq --arg id "$idp_id" '. + [$id]')
  fi
done

if [[ "$ALLOWED_IDPS" == "[]" ]]; then
  warn "No specific IdPs configured - portal will use all available IdPs"
fi

PORTAL_BODY=$(jq -n \
  --arg name "$PORTAL_NAME" \
  --arg hostname "$PORTAL_HOSTNAME" \
  --argjson idps "$ALLOWED_IDPS" \
  --arg server_id "$MCP_SERVER_ID" \
  '{
    name: $name,
    hostname: $hostname,
    code_mode: "opt_in",
    secure_web_gateway: false,
    servers: [{ server_id: $server_id }]
  } + (if ($idps | length) > 0 then { allowed_idps: $idps } else {} end)')

PORTAL_RESPONSE=$(cf_api POST /access/ai-controls/mcp/portals "$PORTAL_BODY")

if check_result "$PORTAL_RESPONSE"; then
  PORTAL_ID=$(get_result "$PORTAL_RESPONSE" '.result.id')
  ok "MCP portal created (ID: ${PORTAL_ID})"
else
  warn "Portal may already exist, looking it up..."
  EXISTING_PORTALS=$(cf_api GET /access/ai-controls/mcp/portals)
  PORTAL_ID=$(echo "$EXISTING_PORTALS" | jq -r --arg name "$PORTAL_NAME" \
    '.result[] | select(.name==$name) | .id' | head -1)
  if [[ -n "$PORTAL_ID" ]]; then
    ok "Portal already exists (ID: ${PORTAL_ID})"
    # Re-assert the association: an existing portal may predate the server.
    info "Ensuring the server is associated with the portal..."
    UPDATE_RESPONSE=$(cf_api PUT "/access/ai-controls/mcp/portals/${PORTAL_ID}" "$PORTAL_BODY")
    if check_result "$UPDATE_RESPONSE"; then
      ok "Portal updated - server ${MCP_SERVER_ID} associated"
    else
      warn "Could not update portal association; check the dashboard:"
      echo "$UPDATE_RESPONSE" | jq '.errors' >&2
    fi
  else
    error "Failed to create portal"
    echo "$PORTAL_RESPONSE" | jq '.errors' >&2
    exit 1
  fi
fi

echo ""

# ---------------------------------------------------------------------------
# 2d. Trigger a capability sync and wait for Ready
#     The first sync fetches tools and prompts from the upstream. Clients see
#     an empty tool list until this reports Ready.
# ---------------------------------------------------------------------------
info "Syncing MCP server capabilities (tools, prompts)..."

SYNC_DEADLINE=$(( SECONDS + ${SYNC_TIMEOUT:-120} ))
SERVER_STATUS="unknown"

while (( SECONDS < SYNC_DEADLINE )); do
  SYNC_RESPONSE=$(cf_api POST "/access/ai-controls/mcp/servers/${MCP_SERVER_ID}/sync" \
    -H "X-Cf-Access-Device-Flow: true")

  SERVER_DETAIL=$(cf_api GET "/access/ai-controls/mcp/servers/${MCP_SERVER_ID}")
  SERVER_STATUS=$(echo "$SERVER_DETAIL" | jq -r '.result.status // "unknown"' | tr '[:upper:]' '[:lower:]')

  if [[ "$SERVER_STATUS" == "ready" ]]; then
    TOOL_COUNT=$(echo "$SERVER_DETAIL" | jq -r '.result.tools | length' 2>/dev/null || echo "0")
    ok "Server is Ready (${TOOL_COUNT} tool(s) available)"
    break
  fi

  if [[ "$SERVER_STATUS" == "error" ]]; then
    error "Server reported an error during sync:"
    echo "$SERVER_DETAIL" | jq '.result.error_details // .result' >&2
    break
  fi

  info "Status: ${SERVER_STATUS} - waiting..."
  sleep 5
done

if [[ "$SERVER_STATUS" != "ready" ]]; then
  warn "Server not Ready after ${SYNC_TIMEOUT:-120}s (last status: ${SERVER_STATUS})."
  warn "Sync often completes in the background; re-check with scripts/04-verify-portal.sh"
  warn "or force it with scripts/06-sync-server.sh."
fi

echo ""

# ---------------------------------------------------------------------------
# 2e. Save state for the later steps
# ---------------------------------------------------------------------------
STATE_FILE="${SCRIPT_DIR}/../.portal-state"
cat > "$STATE_FILE" <<EOF
PORTAL_ID=${PORTAL_ID}
MCP_SERVER_ID=${MCP_SERVER_ID}
PORTAL_HOSTNAME=${PORTAL_HOSTNAME}
UPSTREAM_MCP_URL=${UPSTREAM_MCP_URL}
EOF
ok "Portal state saved to .portal-state"

echo ""
ok "=== Portal Created ==="
echo "  Portal URL:      https://${PORTAL_HOSTNAME}/mcp"
echo "  Upstream:        ${UPSTREAM_MCP_URL}"
echo "  Portal ID:       ${PORTAL_ID}"
echo "  Server ID:       ${MCP_SERVER_ID}"
echo ""
info "Next: Run scripts/03-configure-access-policies.sh to set up Access policies"
echo ""
