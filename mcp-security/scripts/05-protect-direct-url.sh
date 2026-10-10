#!/usr/bin/env bash
set -euo pipefail

# Step 4 (OPTIONAL): Protect the direct URL pay.openaimp.com/mcp.
# By default, the MCP portal secures the PORTAL URL (mcp.openaimp.com/mcp)
# but the direct URL (pay.openaimp.com/mcp) remains publicly accessible.
# This script creates a WAF custom rule that blocks direct access to /mcp.

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
export ACCOUNT_ID="${ACCOUNT_ID:-1e7e9bb45eca8d59ec86bbd6dac9b900}"
export ZONE_ID="703d62121e5ab3ae3d82ece30dc460d3"

echo "=== Creating WAF custom rule to block direct access to pay.openaimp.com/mcp ==="
echo ""

RULESETS_RESPONSE=$(curl -sS \
  --request GET \
  --url "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_custom/entrypoint" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")

echo "Current zone-level custom firewall ruleset:"
echo "${RULESETS_RESPONSE}" | jq '{id: .result.id, name: .result.name, rules: [.result.rules[]? | {id, expression, action}]}' 2>/dev/null || echo "${RULESETS_RESPONSE}" | jq .

RULESET_ID=$(echo "${RULESETS_RESPONSE}" | jq -r '.result.id // empty')

if [ -z "${RULESET_ID}" ]; then
  echo "⚠ No zone-level custom firewall ruleset found. Creating one..."
  curl -sS \
    --request POST \
    --url "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets" \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header "Content-Type: application/json" \
    --data '{
      "name": "MCP Direct Access Protection",
      "phase": "http_request_firewall_custom",
      "kind": "zone",
      "rules": [
        {
          "expression": "(http.host eq \"pay.openaimp.com\" and starts_with(http.request.uri.path, \"/mcp\"))",
          "action": "block",
          "description": "Block direct access to pay.openaimp.com/mcp — use mcp.openaimp.com/mcp portal instead"
        }
      ]
    }' | jq .
else
  echo "Adding rule to existing ruleset ${RULESET_ID}..."
  EXISTING_RULES=$(echo "${RULESETS_RESPONSE}" | jq '.result.rules // []')
  NEW_RULE='{"expression": "(http.host eq \"pay.openaimp.com\" and starts_with(http.request.uri.path, \"/mcp\"))", "action": "block", "description": "Block direct access to pay.openaimp.com/mcp — use mcp.openaimp.com/mcp portal instead"}'
  UPDATED_RULES=$(echo "[${EXISTING_RULES}, ${NEW_RULE}]" | jq -c 'flatten')

  curl -sS \
    --request PUT \
    --url "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets/${RULESET_ID}" \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header "Content-Type: application/json" \
    --data "$(jq -n --argjson rules "${UPDATED_RULES}" '{rules: $rules}')" | jq .
fi

echo ""
echo "=== WAF rule created ==="
echo "    Direct access to https://pay.openaimp.com/mcp is now blocked."
echo "    Users must connect via https://mcp.openaimp.com/mcp (the portal)."
echo ""
echo "⚠ IMPORTANT: Test that the MCP portal can still reach the upstream server."
echo "   If the portal proxy is also blocked, you may need to add an exception."
