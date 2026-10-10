#!/usr/bin/env bash
# =============================================================================
# 04-verify-portal.sh
# =============================================================================
# Verifies the MCP portal setup by:
#   1. Checking DNS resolution
#   2. Checking that the portal endpoint responds with 401 (auth required)
#   3. Checking OAuth discovery endpoints
#   4. Listing registered MCP servers
#   5. Checking server sync status
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"

load_env

# Load portal state
STATE_FILE="${SCRIPT_DIR}/../.portal-state"
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
else
  error "Portal state not found. Run scripts/02-create-mcp-portal.sh first."
  exit 1
fi

echo ""
info "=== Step 4: Verify MCP Portal ==="
echo ""

# ---------------------------------------------------------------------------
# 4a. Check DNS
# ---------------------------------------------------------------------------
info "Checking DNS for ${PORTAL_HOSTNAME}..."

DNS_RESULT=$(dig +short "${PORTAL_HOSTNAME}" CNAME 2>/dev/null || echo "")
if [[ "$DNS_RESULT" == *"gateway.agents.cloudflare.com"* ]]; then
  ok "DNS CNAME correctly points to gateway.agents.cloudflare.com"
else
  warn "DNS CNAME not found or not pointing to gateway.agents.cloudflare.com"
  warn "Current: ${DNS_RESULT:-empty}"
  warn "DNS propagation may take a few minutes. Retry later."
fi
echo ""

# ---------------------------------------------------------------------------
# 4b. Check portal endpoint (should return 401 — auth required)
# ---------------------------------------------------------------------------
info "Checking portal endpoint https://${PORTAL_HOSTNAME}/mcp..."

HTTP_CODE=$(curl --silent --output /dev/null --write-out "%{http_code}" \
  "https://${PORTAL_HOSTNAME}/mcp" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" == "401" ]]; then
  ok "Portal returns 401 — authentication is required (correct!)"
elif [[ "$HTTP_CODE" == "403" ]]; then
  ok "Portal returns 403 — access denied (auth is working)"
elif [[ "$HTTP_CODE" == "000" ]]; then
  warn "Could not reach portal — DNS may not have propagated yet"
else
  warn "Portal returned HTTP ${HTTP_CODE} (expected 401 or 403)"
fi
echo ""

# ---------------------------------------------------------------------------
# 4c. Check OAuth discovery endpoints
# ---------------------------------------------------------------------------
info "Checking OAuth discovery endpoints..."

# The OAuth discovery URL for Access
OAUTH_DISCOVERY_URL="https://${CF_TEAM_NAME}.cloudflareaccess.com/cdn-cgi/access/sso/oidc/"

# Try the well-known endpoint for the protected resource
WELL_KNOWN_URL="https://${PORTAL_HOSTNAME}/.well-known/oauth-protected-resource"
WK_RESPONSE=$(curl --silent --show-error "$WELL_KNOWN_URL" 2>/dev/null || echo "")

if [[ -n "$WK_RESPONSE" && "$WK_RESPONSE" != "" ]]; then
  # Check if it has expected fields
  if echo "$WK_RESPONSE" | jq -e '.resource // .authorization_servers // empty' >/dev/null 2>&1; then
    ok "OAuth protected resource metadata is available"
  else
    info "Protected resource metadata endpoint responded (may still be propagating)"
  fi
else
  warn "Protected resource metadata not yet available (propagation in progress)"
fi

# Check OAuth authorization server metadata
AS_WELL_KNOWN="https://${PORTAL_HOSTNAME}/.well-known/oauth-authorization-server"
AS_RESPONSE=$(curl --silent --show-error "$AS_WELL_KNOWN" 2>/dev/null || echo "")

if [[ -n "$AS_RESPONSE" ]] && echo "$AS_RESPONSE" | jq -e '.issuer // .authorization_endpoint // empty' >/dev/null 2>&1; then
  ok "OAuth authorization server metadata is available"
  echo "  Issuer:             $(echo "$AS_RESPONSE" | jq -r '.issuer // "N/A"')"
  echo "  Auth endpoint:      $(echo "$AS_RESPONSE" | jq -r '.authorization_endpoint // "N/A"')"
  echo "  Token endpoint:     $(echo "$AS_RESPONSE" | jq -r '.token_endpoint // "N/A"')"
  echo "  Registration:       $(echo "$AS_RESPONSE" | jq -r '.registration_endpoint // "N/A"')"
  echo "  PKCE supported:      $(echo "$AS_RESPONSE" | jq -r '.code_challenge_methods_supported // ["none"] | join(", ")')"
else
  warn "OAuth authorization server metadata not yet available (propagation in progress)"
fi
echo ""

# ---------------------------------------------------------------------------
# 4d. List registered MCP servers
# ---------------------------------------------------------------------------
info "Listing registered MCP servers..."

SERVERS_RESPONSE=$(cf_api GET /access/ai-controls/mcp/servers)

if check_result "$SERVERS_RESPONSE"; then
  SERVER_COUNT=$(echo "$SERVERS_RESPONSE" | jq -r '.result | length')
  ok "Found ${SERVER_COUNT} MCP server(s) registered:"

  echo "$SERVERS_RESPONSE" | jq -r '.result[] | "  - \(.name) (ID: \(.id), Status: \(.status // \"unknown\"))"'
else
  warn "Could not list MCP servers"
fi
echo ""

# ---------------------------------------------------------------------------
# 4e. Check server sync status
# ---------------------------------------------------------------------------
if [[ -n "${MCP_SERVER_ID:-}" ]]; then
  info "Checking server sync status..."

  SERVER_DETAIL=$(cf_api GET "/access/ai-controls/mcp/servers/${MCP_SERVER_ID}")

  if check_result "$SERVER_DETAIL"; then
    SERVER_STATUS=$(echo "$SERVER_DETAIL" | jq -r '.result.status // "unknown"')
    SERVER_URL=$(echo "$SERVER_DETAIL" | jq -r '.result.url // "N/A"')
    TOOL_COUNT=$(echo "$SERVER_DETAIL" | jq -r '.result.tools | length')

    ok "Server status: ${SERVER_STATUS}"
    echo "  URL:    ${SERVER_URL}"
    echo "  Tools:  ${TOOL_COUNT}"

    if [[ "$SERVER_STATUS" != "ready" && "$SERVER_STATUS" != "Ready" ]]; then
      warn "Server is not yet 'Ready' — sync may still be in progress"
      info "You can force a sync with: scripts/05-sync-server.sh"
    fi
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 4f. List portals
# ---------------------------------------------------------------------------
info "Listing MCP portals..."

PORTALS_RESPONSE=$(cf_api GET /access/ai-controls/mcp/portals)

if check_result "$PORTALS_RESPONSE"; then
  PORTAL_COUNT=$(echo "$PORTALS_RESPONSE" | jq -r '.result | length')
  ok "Found ${PORTAL_COUNT} portal(s):"

  echo "$PORTALS_RESPONSE" | jq -r '.result[] | "  - \(.name) (ID: \(.id), Host: \(.hostname))"'
else
  warn "Could not list portals"
fi

echo ""
ok "=== Verification Complete ==="
echo ""
info "To test with an MCP client, connect to:"
info "  https://${PORTAL_HOSTNAME}/mcp"
echo ""
info "The client will be prompted to authenticate through your configured IdPs."
info "For non-browser clients, the OAuth 2.0 flow (PKCE/DCR) will be used."
echo ""
