/**
 * Identity accounting sink (issue #252, P2 — IAAA "Accounting").
 *
 * Wires the aspect-logging accounting feed (setAccountingSink) to the
 * IdentityAgent's durable append-only store. SDK-free: it uses
 * identityStub()'s dynamic import so Vitest modules that import this one
 * never pay for a static "agents" import.
 *
 * Design: the aspect emits one AspectEvent per operation; this module holds
 * them in a small in-isolate buffer (cap 200, drop-oldest) and flushes them
 * in batches of up to 50 to `recordAccounting` on the singleton identity
 * instance. The flush is fire-and-forget: the transport copy of every event
 * is already in the Workers log stream, so a lost flush only delays the
 * system-of-record copy, it never loses observability.
 */

import type { AspectEvent, AspectEventSink } from "./aspect-logging";
import { setAccountingSink } from "./aspect-logging";
import { identityStub } from "./agent-stubs";

/** Max buffered events per isolate before the oldest are dropped. */
const BUFFER_MAX = 200;
/** Max events handed to recordAccounting per flush. */
const FLUSH_BATCH = 50;

const buffer: AspectEvent[] = [];
let flushScheduled = false;
let sinkWired = false;

/** Append one event to the in-isolate buffer; drop-oldest past the cap. */
function bufferEvent(event: AspectEvent): void {
  if (buffer.length >= BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX + 1);
  buffer.push(event);
}

/**
 * Guarded flush: at most one flush in flight per isolate. On flush, take up
 * to FLUSH_BATCH buffered events and hand them to the identity instance's
 * recordAccounting, fire-and-forget (void + catch).
 */
function kickFlush(env: any): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // queueMicrotask keeps the flush fire-and-forget from the request's point
  // of view; the runtime may still drain it before the isolate freezes.
  queueMicrotask(() => {
    flushScheduled = false;
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, FLUSH_BATCH);
    // Fire-and-forget: the transport copy of every event is already in the
    // Workers log stream, so a failed flush never loses observability.
    void (async () => {
      try {
        const stub = await identityStub(env);
        await stub.recordAccounting(batch);
      } catch {
        /* fire-and-forget; see module header */
      }
    })();
  });
}

/**
 * Build the accounting sink: appends every event to the in-isolate buffer
 * (cap 200, drop-oldest) and kicks the guarded flush.
 */
export function createIdentityAccountingSink(env: any): AspectEventSink {
  return (event: AspectEvent) => {
    bufferEvent(event);
    kickFlush(env);
  };
}

/**
 * Wire the aspect accounting feed to the identity store, once per isolate.
 * Idempotent: repeated calls are no-ops. `env` is captured at wiring time
 * (the first request of the isolate, from fetch()) so the sink never holds a
 * stale isolate's bindings.
 */
export function ensureAccountingSink(env: any): void {
  if (sinkWired) return;
  sinkWired = true;
  setAccountingSink(createIdentityAccountingSink(env));
}

/**
 * Awaited write for low-volume identity flows (login, logout, token
 * issuance): the events are written without batching. Never throws —
 * emission is observability, not the operation — but the failure is logged
 * so it is not silent.
 */
export async function recordAccountingDirect(
  env: any,
  events: Array<{
    operation: string;
    ts: string;
    level?: string;
    tenantId: string;
    userId: string;
    correlationId: string;
    outcome?: string;
    authDecision?: unknown;
    scopeUsed?: string;
    detail?: unknown;
  }>,
): Promise<void> {
  try {
    const stub = await identityStub(env);
    await stub.recordAccounting(events);
  } catch (err) {
    console.error("recordAccountingDirect failed:", err);
  }
}

/**
 * Test hook: drain the in-isolate buffer. Tests only — nothing in
 * production calls this.
 */
export function __drainAccountingBufferForTests(): AspectEvent[] {
  return buffer.splice(0, buffer.length);
}
