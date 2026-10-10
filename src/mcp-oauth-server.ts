import type { Env } from "./types";
import { timingSafeStringEqual } from "./mcp-auth";

/**
 * Minimal OAuth 2.1 authorization server for /mcp.
 *
 * Scope is fixed (mcp:read); there is no scope picker. Clients register
 * dynamically (DCR) and are public, so PKCE S256 is mandatory and no client
 * secret exists.
 *
 * Everything is stateless and carried in HMAC-signed blobs, so no storage
 * binding is needed:
 *   client_id     -> signed {redirect_uris, client_name}
 *   code          -> signed {cid, ru, cc, sc, exp}  (60s)
 *   access_token  -> signed {sc, exp}
 *   refresh_token -> signed {sc, exp}
 *
 * The signing key is MCP_OAUTH_SIGNING_KEY when set, otherwise MCP_AUTH_TOKEN.
 * Consequence: rotating MCP_AUTH_TOKEN invalidates outstanding tokens, and the
 * login password is MCP_AUTH_TOKEN itself - the same value already used as the
 * static bearer credential.
 */

const SCOPE = "mcp:read";
const CODE_TTL_MS = 60_000;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;

export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";

/** OAuth is advertised and served only when explicitly enabled. */
export function oauthEnabled(env: Env): boolean {
  return (env.MCP_OAUTH_DISCOVERY ?? "").trim().toLowerCase() === "true";
}

function origin(request: Request, env: Env): string {
  const configured = (env.MCP_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return configured !== "" ? configured : new URL(request.url).origin;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

/* ------------------------------- signing -------------------------------- */

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signingKey(env: Env): Promise<CryptoKey> {
  const secret = ((env.MCP_OAUTH_SIGNING_KEY || env.MCP_AUTH_TOKEN) ?? "").trim();
  if (!secret) throw new Error("no OAuth signing secret configured");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("cfmail-oauth|" + secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: Record<string, unknown>, env: Env): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await signingKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return body + "." + b64url(new Uint8Array(sig));
}

async function verify(token: string, env: Env): Promise<Record<string, any> | null> {
  const cut = token.lastIndexOf(".");
  if (cut <= 0) return null;
  const body = token.slice(0, cut);
  const sig = token.slice(cut + 1);
  try {
    const key = await signingKey(env);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      fromB64url(sig),
      new TextEncoder().encode(body),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

/* ------------------------------- metadata ------------------------------- */

export function buildAsMetadata(request: Request, env: Env): Record<string, unknown> {
  const base = origin(request, env);
  return {
    issuer: base,
    authorization_endpoint: base + AUTHORIZE_PATH,
    token_endpoint: base + TOKEN_PATH,
    registration_endpoint: base + REGISTER_PATH,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
  };
}

export function handleAsMetadata(request: Request, env: Env): Response {
  if (!oauthEnabled(env)) return json({ error: "Not found" }, 404);
  return new Response(JSON.stringify(buildAsMetadata(request, env)), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/* --------------------------- dynamic registration ----------------------- */

function isSafeRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  // Loopback http is allowed for native clients (RFC 8252).
  return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (!oauthEnabled(env)) return json({ error: "Not found" }, 404);
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "body must be JSON");
  }

  const requested = body?.redirect_uris;
  if (!Array.isArray(requested) || requested.length === 0) {
    return oauthError("invalid_redirect_uri", "redirect_uris is required");
  }
  const redirectUris: string[] = [];
  for (const uri of requested) {
    if (typeof uri !== "string" || !isSafeRedirectUri(uri)) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be https or loopback http");
    }
    redirectUris.push(uri);
  }

  const clientName = typeof body?.client_name === "string" ? body.client_name.slice(0, 120) : "MCP client";
  const clientId = await sign({ t: "client", ru: redirectUris, nm: clientName }, env);

  return json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    },
    201,
  );
}

/* ------------------------------ authorize ------------------------------- */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Validate the shared request parameters, returning the client or an error. */
async function resolveAuthorizeRequest(
  params: URLSearchParams,
  env: Env,
): Promise<{ clientId: string; redirectUri: string; codeChallenge: string; client: Record<string, any> } | { error: Response }> {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!clientId || !redirectUri) {
    return { error: oauthError("invalid_request", "client_id and redirect_uri are required") };
  }

  const client = await verify(clientId, env);
  if (!client || client.t !== "client" || !Array.isArray(client.ru)) {
    return { error: oauthError("invalid_client", "unknown client_id") };
  }
  if (!client.ru.includes(redirectUri)) {
    return { error: oauthError("invalid_request", "redirect_uri was not registered for this client") };
  }
  if ((params.get("response_type") ?? "") !== "code") {
    return { error: oauthError("unsupported_response_type", "response_type must be code") };
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!codeChallenge || (params.get("code_challenge_method") ?? "") !== "S256") {
    return { error: oauthError("invalid_request", "PKCE with code_challenge_method=S256 is required") };
  }
  return { clientId, redirectUri, codeChallenge, client };
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (!oauthEnabled(env)) return json({ error: "Not found" }, 404);

  if (request.method === "GET") {
    const params = new URL(request.url).searchParams;
    const resolved = await resolveAuthorizeRequest(params, env);
    if ("error" in resolved) return resolved.error;

    const hidden = [
      "client_id",
      "redirect_uri",
      "state",
      "code_challenge",
      "code_challenge_method",
      "response_type",
      "scope",
    ]
      .map((name) => {
        const value = params.get(name) ?? "";
        return value === "" ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
      })
      .join("");

    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorise ${escapeHtml(String(resolved.client.nm ?? "client"))}</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem;color:#111}
 h1{font-size:1.35rem;margin-bottom:.25rem} p{color:#444}
 code{background:#f3f4f6;padding:.1rem .3rem;border-radius:4px}
 input[type=password]{width:100%;padding:.6rem;font-size:1rem;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box}
 button{margin-top:1rem;width:100%;padding:.7rem;font-size:1rem;background:#111;color:#fff;border:0;border-radius:6px;cursor:pointer}
 .note{font-size:.85rem;color:#666}
</style></head><body>
<h1>Authorise ${escapeHtml(String(resolved.client.nm ?? "client"))}</h1>
<p>This grants read-only access to the CFmail agent (scope <code>${SCOPE}</code>).</p>
<form method="post" action="${AUTHORIZE_PATH}">
 ${hidden}
 <label for="token">Access token</label>
 <input id="token" name="token" type="password" autocomplete="off" autofocus required>
 <p class="note">Enter the CFmail MCP access token.</p>
 <button type="submit">Authorise</button>
</form></body></html>`;

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);

  const form = new URLSearchParams(await request.text());
  const resolved = await resolveAuthorizeRequest(form, env);
  if ("error" in resolved) return resolved.error;

  const expected = (env.MCP_AUTH_TOKEN ?? "").trim();
  const presented = (form.get("token") ?? "").trim();
  if (!expected || !timingSafeStringEqual(presented, expected)) {
    return new Response("Incorrect access token. Use the browser back button to retry.", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const code = await sign(
    {
      t: "code",
      cid: resolved.clientId,
      ru: resolved.redirectUri,
      cc: resolved.codeChallenge,
      sc: SCOPE,
      exp: Date.now() + CODE_TTL_MS,
    },
    env,
  );

  const location = new URL(resolved.redirectUri);
  location.searchParams.set("code", code);
  const state = form.get("state");
  if (state) location.searchParams.set("state", state);
  return Response.redirect(location.toString(), 302);
}

/* -------------------------------- token --------------------------------- */

async function issue(scope: string, env: Env): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: await sign({ t: "access", sc: scope, exp: now + ACCESS_TTL_S }, env),
    refresh_token: await sign({ t: "refresh", sc: scope, exp: now + REFRESH_TTL_S }, env),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    scope,
  };
}

export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (!oauthEnabled(env)) return json({ error: "Not found" }, 404);
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);

  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type") ?? "";

  if (grantType === "authorization_code") {
    const claims = await verify(form.get("code") ?? "", env);
    const verifier = form.get("code_verifier") ?? "";
    if (!claims || claims.t !== "code") return oauthError("invalid_grant", "unknown or malformed code");
    if (typeof claims.exp !== "number" || Date.now() > claims.exp) {
      return oauthError("invalid_grant", "code expired");
    }
    if ((form.get("client_id") ?? "") !== claims.cid) return oauthError("invalid_grant", "client mismatch");
    if ((form.get("redirect_uri") ?? "") !== claims.ru) return oauthError("invalid_grant", "redirect_uri mismatch");
    if (!verifier) return oauthError("invalid_grant", "code_verifier is required");

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    if (b64url(new Uint8Array(digest)) !== claims.cc) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    return json(await issue(claims.sc ?? SCOPE, env));
  }

  if (grantType === "refresh_token") {
    const claims = await verify(form.get("refresh_token") ?? "", env);
    if (!claims || claims.t !== "refresh") return oauthError("invalid_grant", "unknown refresh_token");
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || now > claims.exp) return oauthError("invalid_grant", "refresh_token expired");
    return json(await issue(claims.sc ?? SCOPE, env));
  }

  return oauthError("unsupported_grant_type", "supported: authorization_code, refresh_token");
}

/* --------------------------- access token check ------------------------- */

/**
 * True when the presented credential is a valid, unexpired OAuth access token.
 * Called by the /mcp guard in addition to the static shared secret.
 */
export async function isAcceptedAccessToken(token: string, env: Env): Promise<boolean> {
  if (!oauthEnabled(env)) return false;
  const claims = await verify(token, env);
  if (!claims || claims.t !== "access") return false;
  if (typeof claims.exp !== "number" || Math.floor(Date.now() / 1000) > claims.exp) return false;
  return claims.sc === SCOPE;
}