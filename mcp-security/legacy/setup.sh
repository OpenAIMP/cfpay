#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# MASTER SETUP SCRIPT — Secure pay.openaimp.com/mcp with MCP Portal + OAuth
# ═══════════════════════════════════════════════════════════════════════════════
# Run this script to execute all steps in order.
#
# Prerequisites:
#   export CLOUDFLARE_API_TOKEN="your-token"
#   # Token needs: Access: Apps and Policies Write, Account Zero Trust Write
#
# What this does:
#   1. Registers your existing MCP server (pay.openaimp.com/mcp) in Zero Trust
#   2. Creates an MCP portal at mcp.openaimp.com/mcp
#   3. Verifies Managed OAuth (PKCE + DCR) is enabled
#   4. Creates an Access policy to allow your email domain
#   5. (Optional) Blocks direct access to the unsecured URL
#
# Your MCP server code is NOT modified. Zero changes to pay.openaimp.com/mcp.

set -e

echo "╔══════════════════════════════════════════════════════════════════════════╗"
echo "║  Securing pay.openaimp.com/mcp with MCP Portal + Managed OAuth          ║"
echo "║  No code changes to your MCP server                                     ║"
echo "╚══════════════════════════════════════════════════════════════════════════╝"
echo ""

# Check prerequisites
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "✗ CLOUDFLARE_API_TOKEN is not set."
  echo "  export CLOUDFLARE_API_TOKEN=\"your-token\""
  exit 1
fi

export ACCOUNT_ID="${ACCOUNT_ID:-1e7e9bb45eca8d59ec86bbd6dac9b900}"

echo "Account ID: ${ACCOUNT_ID}"
echo "MCP Server:  https://pay.openaimp.com/mcp (unchanged)"
echo "Portal URL:  https://mcp.openaimp.com/mcp (new, secured)"
echo ""
read -p "Continue? (y/N) " confirm
if [ "${confirm}" != "y" ] && [ "${confirm}" != "Y" ]; then
  echo "Aborted."
  exit 0
fi
echo ""

# Step 1: Register MCP server
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "STEP 1: Register MCP server"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bash "$(dirname "$0")/01-register-mcp-server.sh"
echo ""

# Step 2: Create MCP portal
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "STEP 2: Create MCP portal"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bash "$(dirname "$0")/02-create-mcp-portal.sh"
echo ""

# Step 3: Verify managed OAuth
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "STEP 3: Verify Managed OAuth"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bash "$(dirname "$0")/03-verify-managed-oauth.sh"
echo ""

# Step 4: Configure Access policy
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "STEP 4: Configure Access policy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bash "$(dirname "$0")/06-configure-access-policy.sh"
echo ""

# Step 5: Optional — protect direct URL
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "STEP 5 (optional): Block direct access to pay.openaimp.com/mcp"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
read -p "Block direct access to pay.openaimp.com/mcp? (y/N) " block_direct
if [ "${block_direct}" = "y" ] || [ "${block_direct}" = "Y" ]; then
  bash "$(dirname "$0")/04-protect-direct-url.sh"
else
  echo "Skipped. Direct URL remains open. Run 04-protect-direct-url.sh later."
fi
echo ""

# Done
echo "╔══════════════════════════════════════════════════════════════════════════╗"
echo "║  ✓ Setup complete!                                                      ║"
echo "╠══════════════════════════════════════════════════════════════════════════╣"
echo "║  Portal:  https://mcp.openaimp.com/mcp                                  ║"
echo "║  Homepage: https://mcp.openaimp.com/                                     ║"
echo "║  Discovery: https://mcp.openaimp.com/.well-known/oauth-authorization-server ║"
echo "║                                                                          ║"
echo "║  Test the discovery endpoint:                                            ║"
echo "║    curl -s https://mcp.openaimp.com/.well-known/oauth-authorization-server | jq . ║"
echo "║                                                                          ║"
echo "║  Connect from Claude Desktop / Cursor / Windsurf:                        ║"
echo "║    See 05-mcp-client-config.json                                         ║"
echo "║                                                                          ║"
echo "║  MCP server (unchanged): https://pay.openaimp.com/mcp                    ║"
echo "╚══════════════════════════════════════════════════════════════════════════╝"
