# Securing pay.openaimp.com/mcp with Cloudflare MCP Portal + Managed OAuth

## Architecture

```
                                    ┌─────────────────────────────────────────────┐
                                    │           Cloudflare Zero Trust             │
                                    │                                             │
  MCP Client ──OAuth 2.0 PKCE──►   │  MCP Portal (mcp.openaimp.com/mcp)          │
  (Claude, Cursor, etc.)            │    │                                        │
       │                            │    │ Access policies (who can connect)        │
       │ 401 + WWW-Authenticate      │    │ Managed OAuth (PKCE + DCR)              │
       │                            │    │                                        │
       │ ◄── browser login ──►      │    ▼                                        │
       │   Access IdP (OTP/Google/  │  Proxy (no auth to upstream)               │
       │   GitHub/etc.)              │    │                                        │
       │                            │    ▼                                        │
       │ Bearer token ──►            │  pay.openaimp.com/mcp (unchanged)          │
       │                            │    │                                        │
       │                            │    ▼                                        │
       │                            │  Your MCP server Worker (NO CODE CHANGES)   │
       │                            └─────────────────────────────────────────────┘
       │                            ┌─────────────────────────────────────────────┐
       │                            │  WAF Custom Rule: block direct access to    │
       │                            │  pay.openaimp.com/mcp (optional, see below)  │
       │                            └─────────────────────────────────────────────┘
```

## How it works

1. **MCP client** connects to `https://mcp.openaimp.com/mcp` (the portal URL)
2. Portal returns `401` with `WWW-Authenticate` header pointing to Access OAuth discovery
3. Client fetches `https://mcp.openaimp.com/.well-known/oauth-authorization-server`
4. Client opens browser → user logs in via Cloudflare Access (OTP, Google, GitHub, etc.)
5. Access issues opaque OAuth access token (PKCE flow, DCR for client registration)
6. Client sends `Authorization: Bearer <token>` to portal
7. Portal validates token against Access, proxies request to `https://pay.openaimp.com/mcp`
8. Your MCP server responds normally — **zero code changes**

## OAuth protocol details

| Feature | Implementation |
|---------|---------------|
| **Grant type** | Authorization Code (RFC 6749) |
| **PKCE** | Required, S256 (RFC 7636) |
| **DCR** | Dynamic Client Registration (RFC 7591) — enabled by default on new portals |
| **Token format** | Opaque (`oauth:...`), not JWT — by design |
| **Discovery** | RFC 8414 + RFC 9728 at `/.well-known/oauth-authorization-server` |
| **Auth enforcement** | Same Access policies as browser login |

## Prerequisites

1. **Zero Trust organization** — must be initialized (free tier is fine)
2. **Identity provider** — at minimum, the built-in One-Time PIN (OTP); optionally Google, GitHub, Okta, etc.
3. **Active zone** — `openaimp.com` is active in your account ✅
4. **API token** with permissions:
   - `Access: Apps and Policies Write`
   - `Account: Zero Trust Write` (for MCP portal/server management)

## Setup steps

### Step 1: Register the MCP server (unauthenticated)

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"
export ACCOUNT_ID="1e7e9bb45eca8d59ec86bbd6dac9b900"
bash 01-register-mcp-server.sh
```

### Step 2: Create the MCP portal

```bash
bash 02-create-mcp-portal.sh
```

### Step 3: Verify managed OAuth is enabled

```bash
bash 03-verify-managed-oauth.sh
```

### Step 4: Configure Access policy

```bash
bash 06-configure-access-policy.sh
```

### Step 5: (Optional) Protect the direct URL

```bash
bash 04-protect-direct-url.sh
```

### Step 6: Configure your MCP client

See `05-mcp-client-config.json` for Claude Desktop / Cursor / Windsurf examples.

### Or run everything at once:

```bash
bash setup.sh
```

## Dashboard alternative

1. Go to **Zero Trust** → **Access controls** → **MCP Portals** (or **AI controls**)
2. **MCP servers** tab → **Add MCP server**:
   - Name: `pay-mcp-server`
   - HTTP URL: `https://pay.openaimp.com/mcp`
   - Auth type: **Unauthenticated**
   - Save and connect
3. **Add MCP server portal**:
   - Name: `OpenAIMP MCP Portal`
   - Custom domain: `mcp.openaimp.com`
   - Add the server you just registered
   - Add Access policies (e.g., allow `*@openaimp.com`)
   - Create
4. Verify **Managed OAuth** is on (enabled by default on new portals):
   - Edit portal → **Advanced settings** → **Managed OAuth** should be ON
   - Optionally configure DCR allowed URIs and token lifetime

## Important caveats

- **Direct URL bypass**: Without Step 5, `https://pay.openaimp.com/mcp` remains publicly accessible. The portal secures the *portal URL*, not the origin URL.
- **Policy limitations**: Independent MFA, purpose justification, and temporary authentication are not enforced for MCP servers authorized through a portal.
- **Don't visit `/mcp` in a browser** — it returns `invalid token`. Visit the portal root (`https://mcp.openaimp.com/`) for the homepage with setup instructions.

## References

- [MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [Secure MCP servers with Access for SaaS](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- [MCP Portal GA announcement](https://developers.cloudflare.com/changelog/post/2026-09-24-mcp-portals-ga/)
