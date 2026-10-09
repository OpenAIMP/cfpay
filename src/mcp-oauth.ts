import type { Env } from "./types";

/**
 * Discovery support for the /mcp endpoint: RFC 9728 Protected Resource
 * Metadata.
 *
 * The credential /mcp accepts is a pre-shared bearer token, not OAuth. This
 * therefore publishes *resource* metadata and deliberately names no
 * authorisation server: `authorization_servers` is omitted. A client that reads
 * the document learns where the policy lives and that the token travels in the
 * Authorization header, and finds no authorisation server to attempt Dynamic
 * Client Registration against.
 *
 * That omission is the point. An earlier revision advertised
 * `WWW-Authenticate: Bearer realm="cfmail-mcp"` with nothing behind it, so
 * clients classified /mcp as OAuth-protected and failed during Dynamic Client
 * Registration (reverted in 544979f). Advertising an authorisation server we do
 * not implement reproduces that failure; publishing the resource document
 * without one does not.
 *
 * Off unless MCP_OAUTH_DISCOVERY is exactly "true".
 */

/** Well-known path carrying the Protected Resource Metadata document. */
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * Whether the discovery document is served and the 401 challenge advertises it.
 * Anything other than an explicit "true" keeps the endpoint inert.
 */
export function allowsDiscovery(env: Env): boolean {
  return (env.MCP_OAUTH_DISCOVERY ?? "").trim().toLowerCase() === "true";
}

/** Origin used in published metadata; defaults to the request's own origin. */
function publicOrigin(request: Request, env: Env): string {
  const configured = (env.MCP_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  return configured !== "" ? configured : new URL(request.url).origin;
}

/** Absolute URL of the Protected Resource Metadata document. */
export function resourceMetadataUrl(request: Request, env: Env): string {
  return publicOrigin(request, env) + RESOURCE_METADATA_PATH;
}

/**
 * Protected Resource Metadata for /mcp.
 *
 * No `authorization_servers`: we implement no authorisation server, and naming
 * one would send a client into a Dynamic Client Registration attempt that
 * cannot succeed. `bearer_methods_supported: ["header"]` documents the actual
 * requirement - the token is read from the Authorization header only.
 */
export function buildResourceMetadata(
  request: Request,
  env: Env,
): Record<string, unknown> {
  const origin = publicOrigin(request, env);
  return {
    resource: origin + "/mcp",
    bearer_methods_supported: ["header"],
    resource_documentation: origin + "/",
  };
}

/**
 * Serve the Protected Resource Metadata document, or 404 when discovery is off,
 * so that "off" is indistinguishable from a server that never published it.
 */
export function handleResourceMetadata(request: Request, env: Env): Response {
  if (!allowsDiscovery(env)) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(buildResourceMetadata(request, env)), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}