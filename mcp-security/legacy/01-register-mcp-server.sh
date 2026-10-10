#!/usr/bin/env bash
set -euo pipefail

# Step 1: Register the existing unauthenticated MCP server in Cloudflare Access.
# No changes are made to the server itself — this is just a registration in Zero Trust.
# The server is registered as "unauthenticated" because your MCP server has
# no OAuth endpoint of its own. The portal will handle auth on the front end.

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
export ACCOUNT_ID="${ACCOUNT_ID:-1e7e9bb45eca8d59ec86bbd6dac9b900}"

MCP_SERVER_ID="pay-mcp-server"
MCP_SERVER_NAME="Pay MCP Server"
MCP_SERVER_URL="https://pay.openaimp.com/mcp"

echo "=== Registering MCP server: ${MCP_SERVER_ID} ==="
echo "    URL: ${MCP_SERVER_URL}"
echo "    Auth: unauthenticated (portal handles auth)"
echo ""

RESPONSE=$(curl -sS \
  --request POST \
  --url "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/servers" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header "Content-Type: application/json" \
  --data @- <<EOF
{
  "id": "${MCP_SERVER_ID}",
  "name": "${MCP_SERVER_NAME}",
  "hostname": "${MCP_SERVER_URL}",
  "auth_type": "unauthenticated",
  "description": "Existing unauthenticated MCP server at pay.openaimp.com/mcp — secured via MCP portal"
}
EOF
)

echo "${RESPONSE}" | jq .

echo ""
echo "=== Checking server status ==="
sleep 3
curl -sS \
  --request GET \
  --url "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/servers/${MCP_SERVER_ID}" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq '{status: .result.status, name: .result.name, hostname: .result.hostname}'
