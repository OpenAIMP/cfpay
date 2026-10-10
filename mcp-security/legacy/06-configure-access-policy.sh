#!/usr/bin/env bash
set -euo pipefail

# Step 5: Configure Access policies for the portal.
# The portal's Access application needs at least one Allow policy.
# This script creates a policy that allows the openaimp.com email domain.

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
export ACCOUNT_ID="${ACCOUNT_ID:-1e7e9bb45eca8d59ec86bbd6dac9b900}"

PORTAL_ID="openaimp-mcp-portal"

PORTAL_RESPONSE=$(curl -sS \
  --request GET \
  --url "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/portals/${PORTAL_ID}" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

ACCESS_APP_ID=$(echo "${PORTAL_RESPONSE}" | jq -r '.result.access_app_id // empty')

if [ -z "${ACCESS_APP_ID}" ]; then
  echo "✗ Could not find Access app ID for portal ${PORTAL_ID}"
  echo "Make sure you ran 02-create-mcp-portal.sh first."
  exit 1
fi

echo "=== Portal Access App ID: ${ACCESS_APP_ID} ==="
echo ""
echo "=== Creating Allow policy for @openaimp.com email domain ==="
echo ""

curl -sS \
  --request POST \
  --url "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/apps/${ACCESS_APP_ID}/policies" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header "Content-Type: application/json" \
  --data @- <<EOF
{
  "name": "Allow MCP Portal Users",
  "decision": "allow",
  "include": [
    {
      "email": {
        "email_domain": "openaimp.com"
      }
    }
  ]
}
EOF
echo ""
echo "=== Policy created ==="
