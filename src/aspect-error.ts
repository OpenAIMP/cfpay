/**
 * WS1 error aspect (issue #252, design §2.1).
 *
 * A thin interception wrapper: thrown values are classified to the #209
 * error catalog and rendered as catalog bodies. Handlers stop shaping their
 * own error responses; the response shape on the wire is byte-identical to
 * today's per-branch classification (a diff test pins this).
 *
 * Classification: an Error carrying a known `code` property keeps it;
 * otherwise the A2A lane uses a2aErrorCode and the API lane uses
 * mapUnknownError. Raw exception text is never put in a body.
 *
 * SDK-free (imports only ./errors and ./aspect-logging).
 */

import {
  errorBody,
  errorStatus,
  isErrorCode,
  mapUnknownError,
  a2aErrorCode,
  type ErrorCode,
} from "./errors";
import {
  type AspectTrace,
  type AspectOutcome,
  type AspectEvent,
  type AspectEnv,
  CORRELATION_HEADER,
  aspectEventNow,
  emitAspectEvent,
  mintCorrelationId,
  resolveCorrelationId,
  withCorrelationHeader,
} from "./aspect-logging";
import { tenantIdFor, userIdFor } from "./tenancy";
import {
  checkAuthz,
  emitAuthzDecision,
  findHttpDeclaration,
  resolveAuthzIdentity,
} from "./aspect-authz";

/** The single classification path for the API lane. */
export function classifyApiError(err: unknown): ErrorCode {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (isErrorCode(code)) return code;
  }
  return mapUnknownError(err);
}

/** The single classification path for the A2A lane. */
export function classifyA2AError(err: unknown): ErrorCode {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (isErrorCode(code)) return code;
  }
  return a2aErrorCode(err);
}

/**
 * Byte-identical replacement for the per-branch inline construction
 * `new Response(JSON.stringify(errorBody(mapUnknownError(err))), { status:
 * errorStatus(mapUnknownError(err)), ... })`.
 */
export function a2aErrorResponse(err: unknown): Response {
  const code = mapUnknownError(err);
  return new Response(JSON.stringify(errorBody(code)), {
    status: errorStatus(code),
    headers: { "Content-Type": "application/json" },
  });
}

/** Attach the catalog code to a thrown value so outer layers can read it. */
export function tagErrorCode(err: unknown, code: ErrorCode): unknown {
  if (err instanceof Error) {
    try {
      (err as { code?: ErrorCode }).code = code;
    } catch {
      /* non-extensible error: the log event still carries the code */
    }
  }
  return err;
}

/* ------------------------- A2A dispatch aspect -------------------------- */

export interface A2AAspect {
  correlationId: string;
  trace: AspectTrace;
  /** Emit the ok/error event and stamp the correlation header. */
  respond(res: Response): Response;
  /** Classify (A2A lane), emit the error event, return the catalog response. */
  fail(err: unknown): Response;
}

/**
 * Begin the aspect for one A2A dispatch at the index.ts seam.
 * `correlationId` is minted once per HTTP request by the fetch wrapper and
 * passed in, so the response header and every event agree on the id.
 * `opts.identity` carries the edge-resolved tenant (P3); absent it falls
 * back to the operator tenant (P1 behavior).
 */
export function beginA2AAspect(
  env: AspectEnv | undefined,
  correlationId: string,
  opts: { agent: string; operation?: string; identity?: { tenantId: string; userId: string } },
): A2AAspect {
  const t0 = Date.now();
  const trace: AspectTrace = {
    correlationId,
    tenantId: opts.identity?.tenantId ?? tenantIdFor(),
    userId: opts.identity?.userId ?? userIdFor(),
  };
  const base: Omit<AspectEvent, "outcome" | "durationMs" | "ts" | "level"> = {
    v: 1,
    tenantId: trace.tenantId,
    userId: trace.userId,
    agent: opts.agent,
    operation: opts.operation ?? "a2a.dispatch",
    correlationId,
  };
  const finish = (outcome: AspectOutcome, errorCode?: string, level?: AspectEvent["level"]) => {
    emitAspectEvent(
      {
        ...base,
        ts: aspectEventNow(),
        level: level ?? (outcome === "ok" ? "info" : "error"),
        outcome,
        durationMs: Date.now() - t0,
        ...(errorCode ? { errorCode } : {}),
      },
      env,
    );
  };
  return {
    correlationId,
    trace,
    respond(res: Response): Response {
      finish(res.status < 400 ? "ok" : "error", res.status < 400 ? undefined : "UPSTREAM_ERROR");
      return withCorrelationHeader(res, correlationId);
    },
    fail(err: unknown): Response {
      const code = classifyA2AError(err);
      finish("error", code);
      return withCorrelationHeader(a2aErrorResponse(err), correlationId);
    },
  };
}

/* --------------------------- API seam aspect ---------------------------- */

export interface CallableAspectOpts {
  agent: string;
  env?: AspectEnv | null;
  correlationId?: string;
}

/**
 * Hono middleware factory: the API aspect (design §2.1 weave point 1).
 * Composed before the route handlers so it sees every API response —
 * including requireAuth's 401s — while changing none of them.
 *
 * Usage: `app.use("*", apiAspectsMiddleware())` as the first middleware in
 * createApp(). env is read from the Hono context per request.
 */
export function apiAspectsMiddleware() {
  return async (c: any, next: any): Promise<void> => {
    const correlationId = resolveCorrelationId(c.req.raw as Request);
    try {
      c.header(CORRELATION_HEADER, correlationId);
    } catch {
      /* header already sent: leave the response alone */
    }
    const t0 = Date.now();
    const routePath = (c.req.routePath ?? c.req.path) as string;
    const op = `${c.req.method} ${routePath}`;

    // WS1 authz aspect (issue #252, design §2.4): declared check points name
    // their object + relation at the seam. P1: the operator tenant satisfies
    // every declaration, so this is purely additive — the decision is
    // emitted as an accounting event either way (IAAA "Accounting").
    let authDecision: import("./aspect-logging").AspectAuthDecision | undefined;
    const declaration = findHttpDeclaration(c.req.method, routePath);
    if (declaration) {
      const identity = resolveAuthzIdentity(c.req.raw as Request);
      const check = checkAuthz(identity, declaration);
      authDecision = check.decision;
      emitAuthzDecision(identity, declaration, check, {
        correlationId,
        durationMs: Date.now() - t0,
        env: c.env,
      });
      if (!check.allow) {
        emitAspectEvent(
          {
            v: 1,
            ts: aspectEventNow(),
            level: "warn",
            tenantId: identity.tenantId,
            userId: identity.userId,
            agent: "api",
            operation: op,
            correlationId,
            durationMs: Date.now() - t0,
            outcome: "denied",
            errorCode: "INSUFFICIENT_SCOPE",
            authDecision,
          },
          c.env,
        );
        return c.json(errorBody("INSUFFICIENT_SCOPE"), 403);
      }
    }

    try {
      await next();
      const status: number = c.res?.status ?? 200;
      emitAspectEvent(
        {
          v: 1,
          ts: aspectEventNow(),
          level: status < 400 ? "info" : "error",
          tenantId: tenantIdFor(),
          userId: userIdFor(),
          agent: "api",
          operation: op,
          correlationId,
          durationMs: Date.now() - t0,
          outcome: status < 400 ? "ok" : "error",
          ...(status < 400 ? {} : { errorCode: "HTTP_" + status }),
          ...(authDecision ? { authDecision } : {}),
        },
        c.env,
      );
    } catch (err) {
      const code = classifyApiError(err);
      emitAspectEvent(
        {
          v: 1,
          ts: aspectEventNow(),
          level: "error",
          tenantId: tenantIdFor(),
          userId: userIdFor(),
          agent: "api",
          operation: op,
          correlationId,
          durationMs: Date.now() - t0,
          outcome: "error",
          errorCode: code,
          ...(authDecision ? { authDecision } : {}),
          detail: err,
        },
        c.env,
      );
      throw err;
    }
  };
}

/**
 * Callable seam aspect (design §2.1 weave point 4): wraps the RPC stub the
 * api.ts helpers return. RPC throws keep flowing to the route's own catch
 * (which still does its mapUnknownError — the original error object is
 * rethrown with .code attached, so wire behavior is unchanged) while the
 * aspect emits the structured event.
 */
export function withCallableAspect<T extends object>(
  stub: T,
  opts: CallableAspectOpts,
): T {
  return new Proxy(stub, {
    get(target, prop, _receiver) {
      const value = Reflect.get(target as object, prop);
      if (typeof value !== "function" || prop === "then") return value;
      const name = String(prop);
      return async (...args: unknown[]): Promise<unknown> => {
        const t0 = Date.now();
        const correlationId = opts.correlationId ?? mintCorrelationId();
        try {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          );
          emitAspectEvent(
            {
              v: 1,
              ts: aspectEventNow(),
              level: "info",
              tenantId: tenantIdFor(),
              userId: userIdFor(),
              agent: opts.agent,
              operation: `${opts.agent}.${name}`,
              correlationId,
              durationMs: Date.now() - t0,
              outcome: "ok",
            },
            opts.env ?? null,
          );
          return result;
        } catch (err) {
          const code = classifyApiError(err);
          emitAspectEvent(
            {
              v: 1,
              ts: aspectEventNow(),
              level: "error",
              tenantId: tenantIdFor(),
              userId: userIdFor(),
              agent: opts.agent,
              operation: `${opts.agent}.${name}`,
              correlationId,
              durationMs: Date.now() - t0,
              outcome: "error",
              errorCode: code,
              detail: err,
            },
            opts.env ?? null,
          );
          throw tagErrorCode(err, code);
        }
      };
    },
  });
}

/**
 * Workflow-step seam aspect (design §2.1): wraps a step.do body so step
 * failures emit the error event. The aspect records — it never retries and
 * never swallows: the throw propagates to the workflow unchanged.
 */
export async function withWorkflowStepAspect<T>(
  fn: () => Promise<T>,
  opts: { agent: string; operation: string; correlationId: string; env?: AspectEnv | null },
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    emitAspectEvent(
      {
        v: 1,
        ts: aspectEventNow(),
        level: "info",
        tenantId: tenantIdFor(),
        userId: userIdFor(),
        agent: opts.agent,
        operation: opts.operation,
        correlationId: opts.correlationId,
        durationMs: Date.now() - t0,
        outcome: "ok",
      },
      opts.env ?? null,
    );
    return result;
  } catch (err) {
    const code = classifyApiError(err);
    emitAspectEvent(
      {
        v: 1,
        ts: aspectEventNow(),
        level: "error",
        tenantId: tenantIdFor(),
        userId: userIdFor(),
        agent: opts.agent,
        operation: opts.operation,
        correlationId: opts.correlationId,
        durationMs: Date.now() - t0,
        outcome: "error",
        errorCode: code,
        detail: err,
      },
      opts.env ?? null,
    );
    throw tagErrorCode(err, code);
  }
}
