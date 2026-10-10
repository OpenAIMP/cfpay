#!/usr/bin/env bash
set -euo pipefail

# Step 2: Create the MCP server portal.
# The portal sits in front of your MCP server at mcp.openaimp.com/mcp.
# Cloudflare Access automatically creates an Access application for the portal.
# Managed OAuth is enabled by DEFAULT on new portals — this gives you:
#   - OAuth 2.0 Authorization Code flow with PKCE (S256)
#   - Dynamic Client Registration (DCR)
#   - RFC 8414 / RFC 9728 discovery endpoints
#   - Opaque access tokens (not JWTs)

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
export ACCOUNT_ID="${ACCOUNT_ID:-1e7e9bb45eca8d59ec86bbd6dac9b900}"

PORTAL_ID="openaimp-mcp-portal"
PORTAL_NAME="OpenAIMP MCP Portal"
PORTAL_HOSTNAME="mcp.openaimp.com"
MCP_SERVER_ID="pay-mcp-server"

echo "=== Creating MCP portal: ${PORTAL_ID} ==="
echo "    Hostname: ${PORTAL_HOSTNAME}"
echo "    MCP endpoint will be: https://${PORTAL_HOSTNAME}/mcp"
echo ""

RESPONSE=$(curl -sS \
  --request POST \
  --url "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/portals" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header "Content-Type: application/json" \
  --data @- <<EOF
{
  "id": "${PORTAL_ID}",
  "name": "${PORTAL_NAME}",
  "hostname": "${PORTAL_HOSTNAME}",
  "code_mode": "opt_in",
  "servers": [
    {
      "server_id": "${MCP_SERVER_ID}"
    }
  ]
}
EOF
)

echo "${RESPONSE}" | jq .

echo ""
echo "=== Portal created ==="
echo "    Portal URL: https://${PORTAL_HOSTNAME}/mcp"
echo "    Homepage:   https://${PORTAL_HOSTNAME}/"
echo ""
echo "Next: Run 03-verify-managed-oauth.sh to confirm Managed OAuth is enabled"
