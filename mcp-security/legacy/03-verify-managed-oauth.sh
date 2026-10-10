#!/usr/bin/env bash
set -euo pipefail

# Step 3: Verify Managed OAuth is enabled on the portal's Access application.
# Managed OAuth is enabled by default on new MCP portals. This script:
#   1. Finds the Access application auto-created for the portal
#   2. Checks if oauth_configuration.enabled is true
#   3. If not, enables it with DCR and custom settings

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
export ACCOUNT_ID="${ACCOUNT_ID:-1e7e9bb45eca8d59ec86bbd6dac9b900}"

PORTAL_ID="openaimp-mcp-portal"
PORTAL_HOSTNAME="mcp.openaimp.com"

echo "=== Finding Access application for portal: ${PORTAL_ID} ==="

PORTAL_RESPONSE=$(curl -sS \
  --request GET \
  --url "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/portals/${PORTAL_ID}" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

ACCESS_APP_ID=$(echo "${PORTAL_RESPONSE}" | jq -r '.result.access_app_id // empty')

if [ -z "${ACCESS_APP_ID}" ]; then
  echo "⚠ Could not find access_app_id. Listing all Access apps..."
  curl -sS \
    --request GET \
    --url "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps" \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '.result[] | {id, name, domain, type}'
  exit 1
fi

echo "    Access App ID: ${ACCESS_APP_ID}"
echo ""

echo "=== Checking current OAuth configuration ==="
APP_CONFIG=$(curl -sS \
  --request GET \
  --url "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps/${ACCESS_APP_ID}" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

OAUTH_ENABLED=$(echo "${APP_CONFIG}" | jq -r '.result.oauth_configuration.enabled // false')

if [ "${OAUTH_ENABLED}" = "true" ]; then
  echo "✓ Managed OAuth is already enabled!"
  echo "${APP_CONFIG}" | jq '.result.oauth_configuration'
else
  echo "✗ Managed OAuth is NOT enabled. Enabling now..."
  echo ""

  UPDATED_CONFIG=$(echo "${APP_CONFIG}" | jq '.result | .oauth_configuration = {
    "enabled": true,
    "dynamic_client_registration": {
      "enabled": true,
      "allow_any_on_localhost": true,
      "allow_any_on_loopback": true,
      "allowed_uris": [
        "https://playground.ai.cloudflare.com/*"
      ]
    },
    "grant": {
      "access_token_lifetime": "5m",
      "session_duration": "24h"
    }
  }')

  curl -sS \
    --request PUT \
    --url "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps/${ACCESS_APP_ID}" \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "${UPDATED_CONFIG}" | jq '{success, oauth_configuration: .result.oauth_configuration}'
fi

echo ""
echo "=== Verification ==="
echo "    Portal URL: https://${PORTAL_HOSTNAME}/mcp"
echo "    Discovery:  https://${PORTAL_HOSTNAME}/.well-known/oauth-authorization-server"
echo ""
echo "To test the discovery endpoint:"
echo "  curl -s https://${PORTAL_HOSTNAME}/.well-known/oauth-authorization-server | jq ."
