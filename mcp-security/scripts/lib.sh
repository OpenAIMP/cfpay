#!/usr/bin/env bash
# =============================================================================
# lib.sh — Shared functions for MCP Portal security setup
# =============================================================================
# Sourced by all other scripts. Handles env loading, API calls, and output.

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
error() { echo -e "${RED}✗${NC}  $*" >&2; }

# --- Load environment ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

load_env() {
  local env_file="${SCRIPT_DIR}/../.env"
  if [[ -f "$env_file" ]]; then
    # shellcheck disable=SC1090
    source "$env_file"
    ok "Loaded .env"
  else
    warn "No .env file found at $env_file — using environment variables"
  fi

  # Validate required vars
  : "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
  : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
  : "${CF_TEAM_NAME:?CF_TEAM_NAME is required}"
  : "${ZONE_NAME:=openaimp.com}"
  : "${PORTAL_HOSTNAME:=mcp.openaimp.com}"
  : "${UPSTREAM_MCP_URL:=https://pay.openaimp.com/mcp}"
  # Derived defaults, so a .env holding only the required three values still
  # works. PORTAL_SUBDOMAIN feeds the DNS record name; the two names are the
  # display names used when creating the portal and registering the server.
  : "${PORTAL_SUBDOMAIN:=${PORTAL_HOSTNAME%%.*}}"
  : "${PORTAL_NAME:=OpenAIMP MCP Portal}"
  : "${MCP_SERVER_NAME:=OpenAIMP Pay Server}"
  : "${ALLOWED_EMAILS:=openaimp@openaimp.com}"
  : "${SYNC_TIMEOUT:=120}"
}

# --- Cloudflare API helper ---
cf_api() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local url="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}${path}"

  local -a curl_args=(
    --request "$method"
    --url "$url"
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    --header "Content-Type: application/json"
    --silent
    --show-error
  )

  if [[ -n "$data" ]]; then
    curl_args+=(--json "$data")
  fi

  curl "${curl_args[@]}"
}

# Zone-scoped API (for DNS records)
cf_zone_api() {
  local method="$1"
  local path="$2"
  local data="${3:-}"

  # Resolve zone ID from zone name
  if [[ -z "${ZONE_ID:-}" ]]; then
    ZONE_ID=$(curl --silent --show-error \
      --url "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}" \
      --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      --header "X-Cf-Account-Id: ${CLOUDFLARE_ACCOUNT_ID}" \
      | jq -r '.result[0].id')
    [[ -n "$ZONE_ID" && "$ZONE_ID" != "null" ]] || {
      error "Zone '${ZONE_NAME}' not found in this account"
      exit 1
    }
  fi

  local url="https://api.cloudflare.com/client/v4/zones/${ZONE_ID}${path}"
  local -a curl_args=(
    --request "$method"
    --url "$url"
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
    --header "Content-Type: application/json"
    --silent
    --show-error
  )

  if [[ -n "$data" ]]; then
    curl_args+=(--json "$data")
  fi

  curl "${curl_args[@]}"
}

# Check API result for success
check_result() {
  local response="$1"
  local success
  success=$(echo "$response" | jq -r '.success')
  if [[ "$success" != "true" ]]; then
    error "API call failed:"
    echo "$response" | jq '.errors' >&2
    return 1
  fi
  return 0
}

# Extract result field
get_result() {
  echo "$1" | jq -r "$2"
}

# Wait for user confirmation in interactive mode
confirm() {
  if [[ "${CI:-}" == "true" ]]; then
    return 0
  fi
  echo -n "${YELLOW}Proceed? [y/N] ${NC}"
  read -r response
  [[ "$response" =~ ^[yY] ]]
}
