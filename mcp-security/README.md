# MCP Portal Security — Cloudflare Zero Trust

Secures an existing, unauthenticated MCP server by putting a Cloudflare MCP Server
Portal in front of it, **without changing any code on the MCP server itself**.

| | |
|---|---|
| Upstream (unchanged) | `https://pay.openaimp.com/mcp` |
| Protected endpoint | `https://mcp.openaimp.com/mcp` |

## Why a portal

The upstream server authenticates nothing: every request that is not the MCP
handshake is served. The portal adds an identity-aware edge in front of it —
Access policies, an OAuth 2.0 authorization-code flow with PKCE and Dynamic
Client Registration, and per-request logging — and proxies to the upstream with
its own credential. The origin stays exactly as it is.

```
MCP client ──OAuth 2.0 (PKCE/DCR)──▶ mcp.openaimp.com/mcp
                                        │  Access policy + Managed OAuth
                                        │  IdP: OTP / Google / GitHub / Okta
                                        ▼
                                     pay.openaimp.com/mcp   (no code changes)
```

A portal does **not** close the upstream URL. Blocking direct access is a
separate, optional step — see `scripts/05-protect-direct-url.sh`.

## Layout

```
scripts/
  lib.sh                            shared helpers: env loading, API calls, output
  01-setup-identity-providers.sh    OTP + Cloudflare always; Google/GitHub/Okta if configured
  02-create-mcp-portal.sh           DNS CNAME, register server, create portal, sync
  03-configure-access-policies.sh   Allow policy + enable Managed OAuth (PKCE/DCR)
  04-verify-portal.sh               read-only checks (DNS, 401, discovery, sync status)
  05-protect-direct-url.sh          OPTIONAL: WAF rule blocking the upstream host
  06-sync-server.sh                 OPTIONAL: re-sync tools after an upstream change
  07-mcp-client-config.json         client snippets for Claude Desktop, Cursor, etc.
  run-all.sh                        steps 1-4 in order
legacy/                             earlier two-repo flow, kept for reference
```

## Prerequisites

1. **Cloudflare Zero Trust organization** — free plan is enough. Note your
   **team name** (the subdomain of `cloudflareaccess.com`).
2. **API token** with:
   - `Access: Apps and Policies Write` and `Read`
   - `Access: Organizations, Identity Providers, and Groups Write`
   - `DNS: Edit` on the zone holding the portal hostname
3. **Active zone** — `openaimp.com`.
4. **IdP credentials** — optional. OTP needs nothing; Google, GitHub and Okta
   each need an OAuth app whose redirect URI is
   `https://<CF_TEAM_NAME>.cloudflareaccess.com/cdn-cgi/access/callback`.

## Usage

```bash
cp env.example .env      # fill in the values
./scripts/run-all.sh     # or run the scripts one at a time
```

`lib.sh` derives `PORTAL_SUBDOMAIN`, `PORTAL_NAME`, `MCP_SERVER_NAME`,
`ALLOWED_EMAILS` and `SYNC_TIMEOUT` from a minimal `.env`, so only
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `CF_TEAM_NAME` are required.

Each script is idempotent: objects are looked up by name before being created,
so a re-run reconciles rather than duplicating. Step 1 writes `.idp-ids` and
step 2 writes `.portal-state`; both are consumed by later steps, so the order in
`run-all.sh` is load-bearing.

## Connecting a client

Use the **portal** URL, not the upstream:

```
https://mcp.openaimp.com/mcp
```

In Claude, choose **Sign in now** (or the OAuth option) — the portal serves a
complete OAuth authorization server, so Dynamic Client Registration succeeds and
you are redirected to your IdP. `scripts/07-mcp-client-config.json` holds
equivalent snippets for Claude Desktop, Cursor, Windsurf and opencode.

## Notes

- **Managed OAuth is required** for non-browser clients. Without it a CLI or
  agent receives a `302` with no usable token and the connection fails.
- **Step 1 was syntactically invalid until this revision.** Its `cf_api POST`
  payloads closed with `}')` without reopening the quote opened by the leading
  `'{`, so the closing brace terminated the command substitution. `bash -n`
  failed, and `run-all.sh` calls it first, so the pipeline could not run. The
  Google, GitHub and Okta payloads now build their JSON with `jq -n`.
- `legacy/` is the earlier flow from two separate repos with the same goal. Its
  Managed OAuth configuration (DCR plus token lifetimes) has been folded into
  `scripts/03`; the files remain only for reference.
