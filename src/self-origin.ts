/**
 * Single-owner self-origin resolution (issue #269, cluster C4).
 *
 * The Worker's own public origin, honoring the SELF_ORIGIN env override.
 * Uses `??` (not `||`), matching the convention at the majority of call
 * sites: an explicitly set-but-empty SELF_ORIGIN is an ops concern, not a
 * silent fallback. The few call sites that relied on `||` semantics keep
 * their own expression — see the PR body for #269's hygiene tier.
 *
 * SDK-free: safe to import from tests and from any module.
 */
export function selfOrigin(env: { SELF_ORIGIN?: string }): string {
  return env.SELF_ORIGIN ?? "https://pay.openaimp.com";
}
