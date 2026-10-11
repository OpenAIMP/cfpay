/**
 * OAuth 2.1 client for Public.com's hosted MCP server.
 *
 * Discovery was verified live against production:
 *
 *   401 on https://mcp.public.com/mcp
 *     → WWW-Authenticate: Bearer resource_metadata="…/oauth-protected-resource"
 *   → authorization_servers: https://prod-api.154310543964.hellopublic.com/userapiauthservice/oauth2
 *   → AS metadata (RFC 8414): authorization + token endpoints, PKCE S256,
 *     token_endpoint_auth_method "none" (public clients),
 *     client_id_metadata_document_supported: true
 *
 * There is no RFC 7591 registration endpoint, so the client identifies itself
 * with a Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document)
 * served by this same Worker at /.well-known/oauth-client-id-metadata-document.
 * The browser never sees tokens: the pending PKCE session and the token set are
 * held on the central agent Durable Object behind DASHBOARD_API_KEY.
 */

/**
 * Path that serves this Worker's Client ID Metadata Document. The client_id we
 * present IS this URL, so it must be the path the document is actually served
 * from, and it must match `iss` in the document.
 */
export const PUBLIC_OAUTH_CLIENT_PATH = "/auth/public";

export const DEFAULT_PUBLIC_OAUTH_SCOPES = "openid offline_access marketdata trading.read";

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  scopes_supported?: string[];
}

export interface PublicOAuthPending {
  state: string;
  codeVerifier: string;
  clientId: string;
  issuer: string;
  tokenEndpoint: string;
  redirectUri: string;
  createdAt: number;
}

export interface PublicOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}

const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

/* ------------------------------ helpers ---------------------------------- */

function randomString(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time state comparison. */
export function stateMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function isFreshPending(pending: PublicOAuthPending | null | undefined): pending is PublicOAuthPending {
  return Boolean(pending && typeof pending.createdAt === "number" && Date.now() - pending.createdAt < PENDING_MAX_AGE_MS);
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text.trim() ? JSON.parse(text) : null;
  } catch {
    /* caller decides what to do with text */
  }
  return { ok: res.ok, status: res.status, json, text };
}


/* ----------------------------- discovery --------------------------------- */

/**
 * Step 1+2: elicit the resource-metadata challenge from the MCP server, fetch
 * the protected-resource document (RFC 9762), then the authorization server's
 * metadata (RFC 8414, both the path-inserted and root forms).
 */
export async function discoverAuthorizationServer(resourceUrl: string): Promise<AuthorizationServerMetadata> {
  // A bare POST is enough: the 401 carries the challenge without any credential.
  const challenge = await fetch(resourceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const www = challenge.headers.get("www-authenticate") || "";
  const match = /resource_metadata="([^"]+)"/.exec(www);
  if (!match) {
    throw new Error("The MCP server did not advertise OAuth resource metadata (WWW-Authenticate).");
  }

  const prm = await fetchJson(match[1]);
  if (!prm.ok || !Array.isArray(prm.json?.authorization_servers) || !prm.json.authorization_servers.length) {
    throw new Error("The MCP resource metadata lists no authorization server.");
  }
  const issuer: string = prm.json.authorization_servers[0];

  const candidates = issuer.endsWith("/")
    ? [`${issuer}/.well-known/oauth-authorization-server`]
    : (() => {
        const url = new URL(issuer);
        return [
          `${issuer}/.well-known/oauth-authorization-server`,
          `${url.origin}/.well-known/oauth-authorization-server${url.pathname}`,
        ];
      })();

  for (const candidate of candidates) {
    const meta = await fetchJson(candidate);
    if (meta.ok && meta.json?.authorization_endpoint && meta.json?.token_endpoint) {
      const parsed = meta.json as AuthorizationServerMetadata;
      if (
        parsed.code_challenge_methods_supported &&
        !parsed.code_challenge_methods_supported.includes("S256")
      ) {
        throw new Error("The authorization server does not support the required PKCE S256 method.");
      }
      return parsed;
    }
  }
  throw new Error("Could not fetch the authorization server's metadata document.");
}

/* ---------------------------- authorize URL ------------------------------ */

export function buildAuthorizeUrl(
  as: AuthorizationServerMetadata,
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  scopes: string,
  resourceUrl: string,
): string {
  const url = new URL(as.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (scopes) url.searchParams.set("scope", scopes);
  // RFC 8707 Resource Indicators: pin the grant to the MCP server.
  url.searchParams.set("resource", resourceUrl);
  return url.toString();
}

export async function createPkceSession(
  clientId: string,
  as: AuthorizationServerMetadata,
  redirectUri: string,
): Promise<PublicOAuthPending> {
  const codeVerifier = randomString(32);
  return {
    state: randomString(32),
    codeVerifier,
    clientId,
    issuer: as.issuer,
    tokenEndpoint: as.token_endpoint,
    redirectUri,
    createdAt: Date.now(),
  };
}


/* ------------------------------ token grant ------------------------------ */

/** PKCE S256 challenge for a verifier. */
export async function codeChallengeFor(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

function toTokenRecord(
  body: TokenResponse,
  clientId: string,
  issuer: string,
  tokenEndpoint: string,
  revocationEndpoint?: string,
): PublicOAuthTokens {
  if (!body.access_token) {
    throw new Error(
      "The token endpoint returned no access_token: " +
        (body.error_description || body.error || "unexpected response").slice(0, 200),
    );
  }
  const expiresIn =
    typeof body.expires_in === "string" ? parseInt(body.expires_in, 10) : body.expires_in;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || undefined,
    expiresAt:
      typeof expiresIn === "number" && Number.isFinite(expiresIn)
        ? Date.now() + expiresIn * 1000
        : undefined,
    clientId,
    issuer,
    tokenEndpoint,
    revocationEndpoint,
  };
}

export async function exchangeCode(
  pending: PublicOAuthPending,
  code: string,
  revocationEndpoint?: string,
): Promise<PublicOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.codeVerifier,
  });
  const res = await fetchJson(pending.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      "The authorization code exchange failed (" + res.status + "): " +
        (res.json?.error_description || res.json?.error || res.text.slice(0, 200)),
    );
  }
  return toTokenRecord(res.json, pending.clientId, pending.issuer, pending.tokenEndpoint, revocationEndpoint);
}

export async function refreshTokens(tokens: PublicOAuthTokens): Promise<PublicOAuthTokens> {
  if (!tokens.refreshToken) throw new Error("No refresh token is stored.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId,
  });
  const res = await fetchJson(tokens.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      "The refresh grant failed (" + res.status + "): " +
        (res.json?.error_description || res.json?.error || res.text.slice(0, 200)),
    );
  }
  // A refresh response may omit a new refresh_token; keep the current one.
  const next = toTokenRecord(res.json, tokens.clientId, tokens.issuer, tokens.tokenEndpoint, tokens.revocationEndpoint);
  if (!next.refreshToken) next.refreshToken = tokens.refreshToken;
  return next;
}

export function isExpired(tokens: PublicOAuthTokens, skewMs = 60_000): boolean {
  return typeof tokens.expiresAt === "number" && Date.now() + skewMs >= tokens.expiresAt;
}

/* ------------------------- client metadata document ---------------------- */

/**
 * Client ID Metadata Document served by this Worker. The document's `iss` must
 * equal the client_id, so the client_id is "<origin>/auth/public" and the
 * document describes exactly that client.
 */
export function clientMetadataDocument(
  origin: string,
  clientIdPath: string = PUBLIC_OAUTH_CLIENT_PATH,
): any {
  return {
    iss: origin + clientIdPath,
    client_name: "CFmail Agent Dashboard",
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
    redirect_uris: [origin + "/auth/public/callback"],
    scope: DEFAULT_PUBLIC_OAUTH_SCOPES,
  };
}

/** True when the client_id query parameter names this deployment's own client. */
export function isOwnClientId(clientId: string | undefined, origin: string): boolean {
  if (!clientId) return false;
  try {
    const url = new URL(clientId);
    return url.origin === origin && url.pathname === "/auth/public";
  } catch {
    return false;
  }
}
