/**
 * Tenant binding on WebSocket connection state (issue #316).
 *
 * The /agents/* edge enforces the 401/403 before a socket reaches the DO;
 * each tenantized agent then stamps the resolved tenant/user onto the
 * connection's own state in onConnect (SDK connection.setState, functional
 * updater). This file pins the helper the onConnect methods call: stamping
 * the right identity, leaving operator singletons unstamped, refusing to
 * restamp a connection to a different tenant, preserving pre-existing
 * connection state, and never throwing.
 *
 * Pure connection-likes only — no Durable Objects, no real WebSockets.
 * The module under test is top-level SDK-free (same convention as
 * src/tenant-provision.ts).
 */
import { describe, expect, it } from "vitest";
import {
  readTenantConnectionStamp,
  stampForInstance,
  stampTenantOnConnection,
  TENANT_CONNECTION_STATE_KEY,
  type ConnectionLike,
} from "../src/tenant-connection";

/** A fake SDK connection: setState applies the functional updater. */
function fakeConnection(initialState: unknown = null): ConnectionLike & { id: string } {
  const conn: ConnectionLike & { id: string } = {
    id: "conn-1",
    state: initialState,
    setState(state: unknown) {
      const next =
        typeof state === "function"
          ? (state as (prev: unknown) => unknown)(conn.state)
          : state;
      conn.state = next;
      return next;
    },
  };
  return conn;
}

/** What onConnect sees: env + the instance name from ctx.id.name. */
const agent = (name: string | undefined, env: unknown = {}) => ({
  env,
  ctx: { id: { name } },
});

describe("stampTenantOnConnection (issue #316)", () => {
  it("stamps tenant + user on a WS connect to a tenant instance", async () => {
    const conn = fakeConnection();
    const stamp = await stampTenantOnConnection(agent("chat:usr_conn_1"), conn);
    expect(stamp).not.toBeNull();
    expect(stamp!.tenantId).toBe("usr_conn_1");
    expect(stamp!.userId).toBe("usr_conn_1");
    expect(stamp!.instanceName).toBe("chat:usr_conn_1");
    expect(typeof stamp!.stampedAt).toBe("number");
    const stored = (conn.state as Record<string, unknown>)[TENANT_CONNECTION_STATE_KEY];
    expect(stored).toEqual(stamp);
  });

  it("preserves pre-existing connection state (functional updater, no clobber)", async () => {
    const conn = fakeConnection({ app: { theme: "dark" } });
    await stampTenantOnConnection(agent("email:usr_conn_2"), conn);
    const state = conn.state as Record<string, unknown>;
    expect(state.app).toEqual({ theme: "dark" });
    expect((state[TENANT_CONNECTION_STATE_KEY] as { tenantId: string }).tenantId).toBe(
      "usr_conn_2",
    );
  });

  it("leaves the operator singleton unstamped (legacy path byte-identical)", async () => {
    const conn = fakeConnection();
    for (const name of ["qa", "agent", "payments"]) {
      const stamp = await stampTenantOnConnection(agent(name), conn);
      expect(stamp).toBeNull();
    }
    expect(conn.state).toBeNull();
  });

  it("is a no-op when the cutover kill switch is off (defensive re-check)", async () => {
    const conn = fakeConnection();
    const stamp = await stampTenantOnConnection(
      agent("slack:usr_conn_3", { TENANT_CUTOVER: "none" }),
      conn,
    );
    expect(stamp).toBeNull();
    expect(conn.state).toBeNull();
  });

  it("is a no-op without an instance name", async () => {
    const conn = fakeConnection();
    expect(await stampTenantOnConnection(agent(undefined), conn)).toBeNull();
    expect(conn.state).toBeNull();
  });

  it("does not restamp a connection to a different tenant (first stamp wins)", async () => {
    const conn = fakeConnection();
    const first = await stampTenantOnConnection(agent("chat:usr_conn_A"), conn);
    expect(first!.tenantId).toBe("usr_conn_A");
    const second = await stampTenantOnConnection(agent("chat:usr_conn_B"), conn);
    // Returns the ORIGINAL stamp; the stored state is unchanged.
    expect(second!.tenantId).toBe("usr_conn_A");
    const stored = (conn.state as Record<string, unknown>)[TENANT_CONNECTION_STATE_KEY] as {
      tenantId: string;
    };
    expect(stored.tenantId).toBe("usr_conn_A");
  });

  it("re-stamping the same tenant is idempotent", async () => {
    const conn = fakeConnection();
    const first = await stampTenantOnConnection(agent("voice:usr_conn_4"), conn);
    const second = await stampTenantOnConnection(agent("voice:usr_conn_4"), conn);
    expect(second).toEqual(first);
  });

  it("never throws: a failing setState degrades to unstamped", async () => {
    const conn: ConnectionLike = {
      state: null,
      setState() {
        throw new Error("boom");
      },
    };
    const stamp = await stampTenantOnConnection(agent("search:usr_conn_5"), conn);
    expect(stamp).toBeNull();
  });

  it("covers every tenantized surface base", async () => {
    const bases = [
      "autopilot",
      "chat",
      "email",
      "orchestrator",
      "payments",
      "scheduled",
      "search",
      "slack",
      "voice",
      "webhook",
    ];
    for (const base of bases) {
      const conn = fakeConnection();
      const stamp = await stampTenantOnConnection(agent(`${base}:usr_conn_6`), conn);
      expect(stamp, base).not.toBeNull();
      expect(stamp!.tenantId).toBe("usr_conn_6");
      expect(readTenantConnectionStamp(conn)!.tenantId).toBe("usr_conn_6");
    }
  });
});

describe("readTenantConnectionStamp", () => {
  it("returns null for unstamped or malformed state", () => {
    expect(readTenantConnectionStamp(fakeConnection())).toBeNull();
    expect(readTenantConnectionStamp(fakeConnection("garbage"))).toBeNull();
    expect(
      readTenantConnectionStamp(fakeConnection({ [TENANT_CONNECTION_STATE_KEY]: { nope: 1 } })),
    ).toBeNull();
  });
});

describe("stampForInstance (pure)", () => {
  it("derives tenant/user from the instance name", () => {
    const s = stampForInstance("orchestrator:usr_pure_1", {});
    expect(s).toMatchObject({ tenantId: "usr_pure_1", userId: "usr_pure_1" });
  });

  it("returns null for operator names and cutover-off bases", () => {
    expect(stampForInstance("qa", {})).toBeNull();
    expect(stampForInstance("chat:usr_x", { TENANT_CUTOVER: "none" })).toBeNull();
    expect(stampForInstance(undefined, {})).toBeNull();
  });
});
