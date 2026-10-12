// Shared types for the CFmail Agent

export interface Env {
  EMAIL: SendEmail;
  EMAIL_DOMAIN: string;
  EMAIL_SECRET: string;
  AI: Ai;
  ASSETS: Fetcher;
  PAYMENT_PRIVATE_KEY: string;
  PAY_TO_ADDRESS: string;
  PAYMENT_CONFIG: string;
  PAYMENT_DESCRIPTION: string;
  X402_FACILITATOR_URL: string;
  DASHBOARD_API_KEY: string;
  CfmailAgent: DurableObjectNamespace;
  /**
   * The payments capability, extracted from CfmailAgentSQLite into its own
   * Durable Object. Owns the ledger, Stripe checkout state and the replay
   * registries for both payment rails.
   */
  PAYMENTS_AGENT: DurableObjectNamespace;
  /** Owns the mail resource; other agents send through it. */
  EMAIL_AGENT: DurableObjectNamespace;
  /**
   * This Worker's own origin, used when one agent calls another over A2A.
   *
   * A Worker cannot discover its own hostname at runtime without a request, and an
   * inter-agent call may not be inside one, so the origin is configuration. Defaults
   * to the production host in the caller when unset.
   */
  SELF_ORIGIN?: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_APP_TOKEN: string;
  SLACK_CLIENT_ID: string;
  /** Secret for the Slack OAuth install flow (/slack/install code exchange). */
  SLACK_CLIENT_SECRET?: string;
  // GitHub OAuth for dashboard sign-on (additive; API-key auth untouched)
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  // Webhook secrets (incoming verification)
  GITHUB_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  SLACK_WEBHOOK_SECRET?: string;
  // Outgoing webhook URLs
  SLACK_WEBHOOK_URL?: string;
  // Outbound x402 payments (agent spending). Both must be configured before the
  // agent will send funds; see CfmailAgentSQLite.payExternalEndpoint.
  // Static bearer token accepted by /mcp. A GitHub token is also accepted and
  // validated against the GitHub API. With neither this nor MCP_GITHUB_ORG set,
  // /mcp refuses every request.
  MCP_AUTH_TOKEN?: string;
  // When set, a GitHub token must belong to this organisation to be accepted.
  MCP_GITHUB_ORG?: string;
  // Which credentials /mcp accepts: "either" (default), "static", "github" or
  // "none". "none" serves without authentication and must be set explicitly; an
  // unset or unrecognised value is not treated as "none".
  MCP_AUTH_MODE?: string;
  // When "false", every unauthenticated /mcp request is refused, including the
  // handshake. Anything else (or unset) lets the handshake through so MCP clients
  // do not mistake this for an OAuth-protected server.
  MCP_ANON_INITIALIZE?: string;
  // When "true", /mcp publishes RFC 9728 Protected Resource Metadata at
  // /.well-known/oauth-protected-resource and sends a WWW-Authenticate
  // challenge pointing at it. Off unless explicitly enabled, because the
  // challenge changes how MCP clients classify the endpoint.
  MCP_OAUTH_DISCOVERY?: string;
  // Origin used in published metadata. Defaults to the request's own origin.
  MCP_PUBLIC_ORIGIN?: string;
  // Base URL for absolute links the worker hands out (Stripe success/cancel
  // URLs). Defaults to the request's own origin when unset.
  APP_BASE_URL?: string;
  // HMAC key for OAuth tokens and client ids. Falls back to MCP_AUTH_TOKEN
  // when unset; rotating MCP_AUTH_TOKEN therefore invalidates issued tokens.
  MCP_OAUTH_SIGNING_KEY?: string;
  // Staging/test only: when "true", outbound email is logged and recorded
  // instead of being delivered. Never set in production.
  EMAIL_CAPTURE_MODE?: string;
  // Stripe card payments. STRIPE_SECRET_KEY is a secret; STRIPE_CONFIG is a
  // var. Card checkout is disabled unless both are present.
  STRIPE_SECRET_KEY?: string;
  STRIPE_CONFIG?: string;
  // Webhook email notifications. Off unless WEBHOOK_NOTIFY_EMAIL is set.
  WEBHOOK_NOTIFY_EMAIL?: string;
  WEBHOOK_NOTIFY_PROVIDERS?: string;
  OUTBOUND_PAY_TO_WHITELIST?: string;
  OUTBOUND_MAX_AMOUNT_ATOMIC?: string;
  /**
   * Optional comma-separated URL prefixes restricting the @callable
   * sendWebhook RPC. When set and non-empty, URLs not starting with one of
   * the prefixes are refused.
   */
  OUTBOUND_WEBHOOK_ALLOWLIST?: string;
}

export interface PaymentNetworkConfig {
  chainId: string;
  name?: string;
  usdc?: string;
  ethAmount?: string;
  usdcAmount?: string;
}

export interface PaymentConfig {
  networks: Record<string, PaymentNetworkConfig>;
}

/**
 * Card pricing. amountCents is the single source of truth for what a card
 * payment must total: the Stripe Price and this value are compared on the
 * webhook and a mismatch is rejected rather than fulfilled.
 */
export interface StripeConfig {
  /** Stripe Price id (price_...). */
  priceId: string;
  /** Expected total in minor units, e.g. 100 = $1.00. */
  amountCents: number;
  /** Lowercase ISO currency, e.g. "usd". */
  currency: string;
}

/** Lifecycle of one card checkout, keyed by our own requestId. */
export type StripeCheckoutStatus =
  | "awaiting_session"
  | "session_created"
  | "fulfilled"
  | "failed";

export interface StripeCheckout {
  requestId: string;
  email: string;
  /** The user's request text. Held server-side; never trusted from the client. */
  request: string;
  status: StripeCheckoutStatus;
  createdAt: string;
  sessionId?: string;
  sessionUrl?: string;
  fulfilledAt?: string;
  /** Stripe payment_intent id, recorded on the payment ledger entry. */
  paymentIntentId?: string;
}

export interface PaymentClaim {
  asset: string;
  payTo: string;
  amount: string;
  network: string;
  txHash: string;
}

export interface EmailRecord {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  html?: string;
  direction: "inbound" | "outbound";
  receivedAt: string;
  aiSummary?: string;
  aiResponse?: string;
  paid: boolean;
}

export interface PaymentRecord {
  id: string;
  direction: "received" | "sent";
  amount: string;
  currency: string;
  network: string;
  fromAddress?: string;
  toAddress: string;
  description: string;
  status: "pending" | "confirmed" | "failed";
  txHash?: string;
  createdAt: string;
  relatedEmailId?: string;
}

export interface AgentState {
  emails: EmailRecord[];
  payments: PaymentRecord[];
  totalEmailsReceived: number;
  totalEmailsSent: number;
  totalPaymentsReceived: number;
  totalPaymentsSent: number;
  /**
   * Set once this instance's pre-split payment entries have been adopted by the
   * payments agent. Absent means the migration still has to run, so a failed
   * attempt retries on the next read rather than being silently forgotten.
   */
  paymentsBackfilledAt?: string;
  webhookEvents?: WebhookEvent[];
  totalWebhooksReceived?: number;
  /** Card checkouts awaiting or after fulfilment, keyed by requestId. */
  stripeCheckouts?: Record<string, StripeCheckout>;
  /**
   * Stripe event ids already handled. Stripe retries deliveries for up to three
   * days and may reorder them, so handling must be idempotent regardless of the
   * checkout state machine.
   */
  stripeProcessedEvents?: Record<string, string>;
  /**
   * x402 payment transaction hashes (lower-cased) already redeemed for a paid
   * request, mapped to the ISO timestamp of first use. Verified claims are
   * single-use: once a txHash is recorded here, presenting the same
   * PAYMENT-SIGNATURE again is rejected before any AI inference or email is
   * burned. Mirrors stripeProcessedEvents.
   */
  x402ProcessedClaims?: Record<string, string>;
  /**
   * GitHub X-GitHub-Delivery IDs already handled, mapped to the ISO timestamp
   * of first receipt. GitHub signatures cover no timestamp, so without this
   * rolling 24h set a captured payload could be replayed indefinitely.
   * Mirrors stripeProcessedEvents.
   */
  githubProcessedDeliveries?: Record<string, string>;
  /**
   * Consumed OAuth refresh-token ids (jti), mapped to the ISO timestamp of
   * rotation. Refresh tokens are single-use: presenting an already-rotated
   * token is rejected as suspected theft. Entries older than the refresh
   * lifetime are pruned.
   */
  oauthConsumedRefreshJtis?: Record<string, string>;
  /**
   * Slack bot token from the OAuth install flow (/slack/install). Takes
   * precedence over the SLACK_BOT_TOKEN env var when set.
   */
  slackBotToken?: string;
  /**
   * Public.com personal access token. Held server-side, behind
   * DASHBOARD_API_KEY, and never returned to the browser.
   */
  publicToken?: string;
  /**
   * The user's chosen model id for the Public.com chat, persisted so the
   * choice survives a reload. Resolved against src/models.json on read; an
   * unknown id falls back to the configured default rather than erroring.
   */
  publicModel?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

export interface WebhookEvent {
  id: string;
  provider: "github" | "stripe" | "slack";
  eventType: string;
  agentName: string;
  payload: unknown;
  receivedAt: string;
  processed: boolean;
  /** AI analysis of the event, attached when analysis succeeds. */
  aiInsight?: string;
}

/**
 * One tool call made while answering a Public.com question.
 *
 * Surfaced to the UI so the answer can be checked against what actually ran:
 * a fluent answer that called no tools, or called only get_portfolio, is not
 * evidence about an instrument.
 */
export interface ToolTrace {
  name: string;
  args: unknown;
  ok: boolean;
  /** Set when the call was blocked locally rather than by Public.com. */
  refused?: boolean;
  /** Full tool output, truncated for transport. */
  result: string;
  /** First non-empty line, for the collapsed view. */
  summary?: string;
}
