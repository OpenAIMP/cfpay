#!/usr/bin/env bash
# =============================================================================
# 05-sync-server.sh
# =============================================================================
# Force-syncs the upstream MCP server to retrieve the latest tools and prompts.
# Run this after deploying changes to the upstream MCP server.
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
  # Try to find the server by listing
  warn "Portal state not found, searching for MCP servers..."
  SERVERS=$(cf_api GET /access/ai-controls/mcp/servers)
  MCP_SERVER_ID=$(echo "$SERVERS" | jq -r --arg name "${MCP_SERVER_NAME:-OpenAIMP Pay Server}" \
    '.result[] | select(.name==$name) | .id' | head -1)
  if [[ -z "$MCP_SERVER_ID" ]]; then
    error "Could not find MCP server. Run scripts/02-create-mcp-portal.sh first."
    exit 1
  fi
fi

echo ""
info "Force-syncing MCP server ${MCP_SERVER_ID}..."

SYNC_RESPONSE=$(cf_api POST "/access/ai-controls/mcp/servers/${MCP_SERVER_ID}/sync")

if check_result "$SYNC_RESPONSE"; then
  ok "Sync triggered successfully"
  info "Tools and prompts will be updated shortly"
else
  error "Sync failed"
  echo "$SYNC_RESPONSE" | jq '.errors' >&2
fi

echo ""
