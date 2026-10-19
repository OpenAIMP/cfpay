/**
 * Single-owner self-origin resolution (issue #269, cluster C4).
 *
 * The Worker's own public origin, honoring the SELF_ORIGIN env override.
 * Uses `??` (not `||`): a set-but-empty SELF_ORIGIN is treated as unset
 * and falls back to the default (issue #269, remainder — a deliberate
 * behavior change from the old `||` copies). The `origin` parameter in
 * probe call sites still takes precedence where one is passed.
 *
 * SDK-free: safe to import from tests and from any module.
 */
export function selfOrigin(env: { SELF_ORIGIN?: string }): string {
  return env.SELF_ORIGIN ?? "https://pay.openaimp.com";
}
