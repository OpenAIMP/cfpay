#!/usr/bin/env bash
# =============================================================================
# run-all.sh - Run the complete MCP portal security setup
# =============================================================================
# Steps, in order:
#   1  identity providers        (OTP, Cloudflare, Google, GitHub, Okta)
#   2  portal                    (DNS + server registration + portal + sync)
#   3  access policies           (Allow policy + Managed OAuth)
#   4  verify                    (read-only checks)
#   5  protect direct URL        (optional: WAF rule on the upstream host)
#   6  sync server               (optional: re-sync after upstream changes)
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "MCP Portal Security - full setup"
echo "  upstream (unchanged): https://pay.openaimp.com/mcp"
echo "  protected endpoint:   https://mcp.openaimp.com/mcp"
echo ""

# Step 2 reads the IdP IDs that step 1 writes, and writes the portal IDs that
# steps 3, 4 and 6 read. The order below is load-bearing.
bash "${SCRIPT_DIR}/01-setup-identity-providers.sh"
echo ""
bash "${SCRIPT_DIR}/02-create-mcp-portal.sh"
echo ""
bash "${SCRIPT_DIR}/03-configure-access-policies.sh"
echo ""
bash "${SCRIPT_DIR}/04-verify-portal.sh"
echo ""

echo "Setup complete."
echo ""
echo "  Protected MCP endpoint: https://mcp.openaimp.com/mcp"
echo "  Upstream (unchanged):   https://pay.openaimp.com/mcp"
echo ""
echo "Optional follow-ups:"
echo "  scripts/05-protect-direct-url.sh   block direct access to the upstream host"
echo "  scripts/06-sync-server.sh          re-sync tools after an upstream change"
echo ""