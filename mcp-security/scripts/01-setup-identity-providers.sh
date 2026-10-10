#!/usr/bin/env bash
# =============================================================================
# 01-setup-identity-providers.sh
# =============================================================================
# Sets up identity providers in Cloudflare Zero Trust:
#   - One-time PIN (OTP) — always enabled, no config needed
#   - Cloudflare (account-member login) — always enabled
#   - Google (consumer) — if GOOGLE_CLIENT_ID is set
#   - GitHub — if GITHUB_CLIENT_ID is set
#   - Okta — if OKTA_CLIENT_ID is set
#
# Prerequisites:
#   1. A Zero Trust organization must exist (free plan is fine).
#   2. For Google: create OAuth credentials at
#      https://console.cloud.google.com/apis/credentials
#      Redirect URI: https://<CF_TEAM_NAME>.cloudflareaccess.com/cdn-cgi/access/callback
#   3. For GitHub: create an OAuth App at
#      https://github.com/settings/developers
#      Redirect URI: https://<CF_TEAM_NAME>.cloudflareaccess.com/cdn-cgi/access/callback
#   4. For Okta: sign up for free Developer Edition at
#      https://developer.okta.com/signup/
#      Create an OIDC app integration.
#      Redirect URI: https://<CF_TEAM_NAME>.cloudflareaccess.com/cdn-cgi/access/callback
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "${SCRIPT_DIR}/lib.sh"

load_env

echo ""
info "=== Step 1: Identity Provider Setup ==="
echo ""

# ---------------------------------------------------------------------------
# 1a. One-time PIN (OTP) — always enable
# ---------------------------------------------------------------------------
info "Setting up One-time PIN (OTP) identity provider..."

OTP_RESPONSE=$(cf_api POST /access/identity_providers '{
  "name": "One-time PIN login",
  "type": "onetimepin",
  "config": {}
}')

if check_result "$OTP_RESPONSE"; then
  OTP_ID=$(get_result "$OTP_RESPONSE" '.result.id')
  ok "One-time PIN enabled (ID: ${OTP_ID})"
else
  # Might already exist — list and find it
  warn "OTP may already exist, checking..."
  EXISTING_OTP=$(cf_api GET /access/identity_providers)
  OTP_ID=$(echo "$EXISTING_OTP" | jq -r '.result[] | select(.type=="onetimepin") | .id' | head -1)
  if [[ -n "$OTP_ID" ]]; then
    ok "One-time PIN already exists (ID: ${OTP_ID})"
  else
    error "Failed to set up OTP"
  fi
fi

# ---------------------------------------------------------------------------
# 1b. Cloudflare identity provider — always enable
# ---------------------------------------------------------------------------
info "Setting up Cloudflare identity provider..."

CF_IDP_RESPONSE=$(cf_api POST /access/identity_providers '{
  "name": "Cloudflare",
  "type": "cloudflare",
  "config": {
    "restrict_to_account_members": true
  }
}')

if check_result "$CF_IDP_RESPONSE"; then
  CF_IDP_ID=$(get_result "$CF_IDP_RESPONSE" '.result.id')
  ok "Cloudflare identity provider enabled (ID: ${CF_IDP_ID})"
else
  warn "Cloudflare IdP may already exist, checking..."
  EXISTING_CF=$(cf_api GET /access/identity_providers)
  CF_IDP_ID=$(echo "$EXISTING_CF" | jq -r '.result[] | select(.type=="cloudflare") | .id' | head -1)
  if [[ -n "$CF_IDP_ID" ]]; then
    ok "Cloudflare IdP already exists (ID: ${CF_IDP_ID})"
  else
    error "Failed to set up Cloudflare IdP"
  fi
fi

# ---------------------------------------------------------------------------
# 1c. Google (consumer Google accounts via generic OIDC)
# ---------------------------------------------------------------------------
GOOGLE_IDP_ID=""
if [[ -n "${GOOGLE_CLIENT_ID:-}" && -n "${GOOGLE_CLIENT_SECRET:-}" ]]; then
  info "Setting up Google identity provider..."

  GOOGLE_RESPONSE=$(cf_api POST /access/identity_providers "$(jq -n \
    --arg name "Google" \
    --arg client_id "$GOOGLE_CLIENT_ID" \
    --arg client_secret "$GOOGLE_CLIENT_SECRET" \
    '{
      name: $name,
      type: "oidc",
      config: {
        client_id: $client_id,
        client_secret: $client_secret,
        auth_url: "https://accounts.google.com/o/oauth2/auth",
        token_url: "https://accounts.google.com/o/oauth2/token",
        certs_url: "https://www.googleapis.com/oauth2/v3/certs",
        pkce_enabled: true,
        email_claim_name: "email",
        scopes: ["openid", "email", "profile"]
      }
    }')")

  if check_result "$GOOGLE_RESPONSE"; then
    GOOGLE_IDP_ID=$(get_result "$GOOGLE_RESPONSE" '.result.id')
    ok "Google identity provider enabled (ID: ${GOOGLE_IDP_ID})"
  else
    warn "Google IdP may already exist, checking..."
    EXISTING=$(cf_api GET /access/identity_providers)
    GOOGLE_IDP_ID=$(echo "$EXISTING" | jq -r '.result[] | select(.name=="Google") | .id' | head -1)
    if [[ -n "$GOOGLE_IDP_ID" ]]; then
      ok "Google IdP already exists (ID: ${GOOGLE_IDP_ID})"
    else
      error "Failed to set up Google IdP"
    fi
  fi
else
  warn "Google IdP skipped (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env to enable)"
fi

# ---------------------------------------------------------------------------
# 1d. GitHub
# ---------------------------------------------------------------------------
GITHUB_IDP_ID=""
if [[ -n "${GITHUB_CLIENT_ID:-}" && -n "${GITHUB_CLIENT_SECRET:-}" ]]; then
  info "Setting up GitHub identity provider..."

  GITHUB_RESPONSE=$(cf_api POST /access/identity_providers "$(jq -n \
    --arg name "GitHub" \
    --arg client_id "$GITHUB_CLIENT_ID" \
    --arg client_secret "$GITHUB_CLIENT_SECRET" \
    '{
      name: $name,
      type: "github",
      config: {
        client_id: $client_id,
        client_secret: $client_secret
      }
    }')")

  if check_result "$GITHUB_RESPONSE"; then
    GITHUB_IDP_ID=$(get_result "$GITHUB_RESPONSE" '.result.id')
    ok "GitHub identity provider enabled (ID: ${GITHUB_IDP_ID})"
  else
    warn "GitHub IdP may already exist, checking..."
    EXISTING=$(cf_api GET /access/identity_providers)
    GITHUB_IDP_ID=$(echo "$EXISTING" | jq -r '.result[] | select(.name=="GitHub") | .id' | head -1)
    if [[ -n "$GITHUB_IDP_ID" ]]; then
      ok "GitHub IdP already exists (ID: ${GITHUB_IDP_ID})"
    else
      error "Failed to set up GitHub IdP"
    fi
  fi
else
  warn "GitHub IdP skipped (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env to enable)"
fi

# ---------------------------------------------------------------------------
# 1e. Okta (free Developer Edition)
# ---------------------------------------------------------------------------
OKTA_IDP_ID=""
if [[ -n "${OKTA_CLIENT_ID:-}" && -n "${OKTA_CLIENT_SECRET:-}" && -n "${OKTA_ACCOUNT_URL:-}" ]]; then
  info "Setting up Okta identity provider..."

  # Okta OIDC endpoints
  OKTA_AUTH_URL="${OKTA_ACCOUNT_URL}/oauth2/default/v1/authorize"
  OKTA_TOKEN_URL="${OKTA_ACCOUNT_URL}/oauth2/default/v1/token"
  OKTA_CERTS_URL="${OKTA_ACCOUNT_URL}/oauth2/default/v1/keys"

  OKTA_RESPONSE=$(cf_api POST /access/identity_providers "$(jq -n \
    --arg name "Okta" \
    --arg client_id "$OKTA_CLIENT_ID" \
    --arg client_secret "$OKTA_CLIENT_SECRET" \
    --arg auth_url "$OKTA_AUTH_URL" \
    --arg token_url "$OKTA_TOKEN_URL" \
    --arg certs_url "$OKTA_CERTS_URL" \
    '{
      name: $name,
      type: "oidc",
      config: {
        client_id: $client_id,
        client_secret: $client_secret,
        auth_url: $auth_url,
        token_url: $token_url,
        certs_url: $certs_url,
        pkce_enabled: true,
        email_claim_name: "email",
        scopes: ["openid", "email", "profile"]
      }
    }')")

  if check_result "$OKTA_RESPONSE"; then
    OKTA_IDP_ID=$(get_result "$OKTA_RESPONSE" '.result.id')
    ok "Okta identity provider enabled (ID: ${OKTA_IDP_ID})"
  else
    warn "Okta IdP may already exist, checking..."
    EXISTING=$(cf_api GET /access/identity_providers)
    OKTA_IDP_ID=$(echo "$EXISTING" | jq -r '.result[] | select(.name=="Okta") | .id' | head -1)
    if [[ -n "$OKTA_IDP_ID" ]]; then
      ok "Okta IdP already exists (ID: ${OKTA_IDP_ID})"
    else
      error "Failed to set up Okta IdP"
    fi
  fi
else
  warn "Okta IdP skipped (set OKTA_CLIENT_ID, OKTA_CLIENT_SECRET, and OKTA_ACCOUNT_URL in .env to enable)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
ok "=== Identity Providers Summary ==="
echo "  OTP:        ${OTP_ID:-not set}"
echo "  Cloudflare: ${CF_IDP_ID:-not set}"
echo "  Google:     ${GOOGLE_IDP_ID:-skipped}"
echo "  GitHub:     ${GITHUB_IDP_ID:-skipped}"
echo "  Okta:      ${OKTA_IDP_ID:-skipped}"
echo ""

# Save IdP IDs for later scripts
IDP_FILE="${SCRIPT_DIR}/../.idp-ids"
cat > "$IDP_FILE" << EOF
OTP_IDP_ID=${OTP_IDP_ID:-}
CF_IDP_ID=${CF_IDP_ID:-}
GOOGLE_IDP_ID=${GOOGLE_IDP_ID:-}
GITHUB_IDP_ID=${GITHUB_IDP_ID:-}
OKTA_IDP_ID=${OKTA_IDP_ID:-}
EOF
ok "IdP IDs saved to .idp-ids"
