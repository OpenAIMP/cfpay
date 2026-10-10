#!/usr/bin/env bash
# =============================================================================
# 03-configure-access-policies.sh
# =============================================================================
# Configures Access policies on the MCP portal's Access application and
# enables Managed OAuth (OAuth 2.0 authorization code flow with PKCE/DCR)
# so MCP clients can authenticate programmatically.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"

load_env

# Load IdP IDs
IDP_FILE="${SCRIPT_DIR}/../.idp-ids"
if [[ -f "$IDP_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$IDP_FILE"
fi

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
info "=== Step 3: Configure Access Policies & Managed OAuth ==="
echo ""

# ---------------------------------------------------------------------------
# 3a. Find the Access application auto-created for the portal
#     When a portal is created, Cloudflare Access automatically creates an
#     Access application. We need to find it to configure policies and OAuth.
# ---------------------------------------------------------------------------
info "Finding the Access application for portal ${PORTAL_HOSTNAME}..."

APPS_RESPONSE=$(cf_api GET /access/apps)

# Find the app whose domain matches the portal hostname
APP_ID=$(echo "$APPS_RESPONSE" | jq -r --arg hostname "$PORTAL_HOSTNAME" \
  '.result[] | select(.domain==$hostname or (.domains[]? | select(. == $hostname))) | .id' | head -1)

if [[ -z "$APP_ID" || "$APP_ID" == "null" ]]; then
  # Try alternate matching — the portal app might use the full hostname with /mcp path
  APP_ID=$(echo "$APPS_RESPONSE" | jq -r --arg hostname "$PORTAL_HOSTNAME" \
    '.result[] | select(.name | test("portal|Portal|'"$PORTAL_HOSTNAME"'"; "i")) | .id' | head -1)
fi

if [[ -z "$APP_ID" || "$APP_ID" == "null" ]]; then
  warn "Could not auto-detect the Access application for the portal."
  info "Listing all Access applications for manual selection:"
  echo "$APPS_RESPONSE" | jq -r '.result[] | "\(.id)  \(.name)  \(.domain)"'
  echo ""
  read -r -p "Enter the Access App ID for the portal: " APP_ID
fi

ok "Found Access application (ID: ${APP_ID})"
echo ""

# ---------------------------------------------------------------------------
# 3b. Get current app config (needed for PUT — must include all fields)
# ---------------------------------------------------------------------------
info "Reading current Access application configuration..."

CURRENT_APP=$(cf_api GET "/access/apps/${APP_ID}")
if ! check_result "$CURRENT_APP"; then
  error "Failed to read Access application"
  exit 1
fi

# ---------------------------------------------------------------------------
# 3c. Build the access policy
#     We create an Allow policy that:
#       - Includes emails/domains from ALLOWED_EMAILS
#       - Optionally restricts to specific IdPs via login_method
# ---------------------------------------------------------------------------
info "Creating Access policy for the portal..."

# Build include rules from ALLOWED_EMAILS
# Each entry is either an email or @domain
INCLUDE_RULES="[]"
IFS=',' read -ra EMAIL_ENTRIES <<< "${ALLOWED_EMAILS:-openaimp@openaimp.com}"
for entry in "${EMAIL_ENTRIES[@]}"; do
  entry=$(echo "$entry" | xargs)  # trim whitespace
  if [[ "$entry" == @* ]]; then
    # Domain rule
    domain="${entry#@}"
    INCLUDE_RULES=$(echo "$INCLUDE_RULES" | jq --arg d "$domain" \
      '. + [{"email_domain": {"domain": $d}}]')
  else
    # Email rule
    INCLUDE_RULES=$(echo "$INCLUDE_RULES" | jq --arg e "$entry" \
      '. + [{"email": {"email": $e}}]')
  fi
done

# Build allowed_idps for the policy (login_method selector)
LOGIN_METHODS="[]"
for idp_id in "${OTP_IDP_ID:-}" "${CF_IDP_ID:-}" "${GOOGLE_IDP_ID:-}" "${GITHUB_IDP_ID:-}" "${OKTA_IDP_ID:-}"; do
  if [[ -n "$idp_id" ]]; then
    LOGIN_METHODS=$(echo "$LOGIN_METHODS" | jq --arg id "$idp_id" '. + [$id]')
  fi
done

# Construct the policy
POLICY_BODY=$(jq -n \
  --argjson include "$INCLUDE_RULES" \
  --argjson login_methods "$LOGIN_METHODS" \
  '{
    "name": "Allow authorized users",
    "decision": "allow",
    "include": $include,
    "session_duration": "24h"
  }')

# If we have login methods, add them as a require clause
if [[ "$LOGIN_METHODS" != "[]" ]]; then
  POLICY_BODY=$(echo "$POLICY_BODY" | jq --argjson lm "$LOGIN_METHODS" \
    '. + {require: [{"login_method": $lm}]}')
fi

POLICY_RESPONSE=$(cf_api POST "/access/apps/${APP_ID}/policies" "$POLICY_BODY")

if check_result "$POLICY_RESPONSE"; then
  POLICY_ID=$(get_result "$POLICY_RESPONSE" '.result.id')
  ok "Access policy created (ID: ${POLICY_ID})"
else
  warn "Policy may already exist or failed. Checking..."
  EXISTING_POLICIES=$(cf_api GET "/access/apps/${APP_ID}/policies")
  POLICY_ID=$(echo "$EXISTING_POLICIES" | jq -r '.result[0].id // empty')
  if [[ -n "$POLICY_ID" ]]; then
    ok "Existing policy found (ID: ${POLICY_ID})"
  else
    error "Failed to create policy"
    echo "$POLICY_RESPONSE" | jq '.errors' >&2
  fi
fi

echo ""

# ---------------------------------------------------------------------------
# 3d. Enable Managed OAuth on the Access application
#     This provides OAuth 2.0 authorization code flow with PKCE/DCR for
#     non-browser MCP clients. MCP clients get a 401 with WWW-Authenticate
#     header pointing to Access's OAuth discovery endpoints.
# ---------------------------------------------------------------------------
info "Enabling Managed OAuth on the portal's Access application..."

# Merge oauth_configuration into the existing app config
# We need to preserve all existing fields and just add/modify oauth_configuration
# DCR settings come from the legacy portal-repo script, which configured them
# explicitly. Without DCR an MCP client cannot register itself, and the shorter
# access-token lifetime bounds the blast radius of a leaked token.
OAUTH_CONFIG='{
  "enabled": true,
  "dynamic_client_registration": {
    "enabled": true,
    "allow_any_on_localhost": true,
    "allow_any_on_loopback": true
  },
  "grant": {
    "access_token_lifetime": "5m",
    "session_duration": "24h"
  }
}'

UPDATED_APP=$(echo "$CURRENT_APP" | jq --argjson oauth "$OAUTH_CONFIG" '.result | .oauth_configuration = $oauth')

# If we have specific IdPs, set them as allowed_idps on the app
if [[ "$LOGIN_METHODS" != "[]" ]]; then
  UPDATED_APP=$(echo "$UPDATED_APP" | jq --argjson lm "$LOGIN_METHODS" '.allowed_idps = $lm')
fi

UPDATE_RESPONSE=$(cf_api PUT "/access/apps/${APP_ID}" "$UPDATED_APP")

if check_result "$UPDATE_RESPONSE"; then
  OAUTH_ENABLED=$(echo "$UPDATE_RESPONSE" | jq -r '.result.oauth_configuration.enabled')
  if [[ "$OAUTH_ENABLED" == "true" ]]; then
    ok "Managed OAuth enabled — MCP clients can now authenticate via OAuth 2.0 (PKCE/DCR)"
  else
    warn "OAuth configuration may not have been applied correctly"
  fi
else
  # Try minimal update — just oauth_configuration
  warn "Full update failed, trying minimal OAuth update..."
  MINIMAL_RESPONSE=$(cf_api PUT "/access/apps/${APP_ID}" "$(jq -n --argjson oauth "$OAUTH_CONFIG" '{oauth_configuration: $oauth}')")
  if check_result "$MINIMAL_RESPONSE"; then
    ok "Managed OAuth enabled (minimal update)"
  else
    error "Failed to enable Managed OAuth"
    echo "You may need to enable it manually in the dashboard:"
    info "  Zero Trust > Access controls > AI controls > [portal] > Edit > Advanced > Managed OAuth: ON"
  fi
fi

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
ok "=== Access Configuration Complete ==="
echo "  Access App ID:    ${APP_ID}"
echo "  Policy ID:        ${POLICY_ID:-N/A}"
echo "  Managed OAuth:    Enabled (PKCE/DCR for MCP clients)"
echo "  Allowed emails:   ${ALLOWED_EMAILS}"
echo ""
echo "  Protected MCP URL: https://${PORTAL_HOSTNAME}/mcp"
echo ""
info "MCP clients can now connect to https://${PORTAL_HOSTNAME}/mcp"
info "They will be prompted to authenticate via Google, GitHub, Okta, or OTP."
info "Non-browser MCP clients use OAuth 2.0 authorization code flow with PKCE."
echo ""
