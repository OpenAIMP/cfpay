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
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_APP_TOKEN: string;
  SLACK_CLIENT_ID: string;
  // Webhook secrets (incoming verification)
  GITHUB_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  SLACK_WEBHOOK_SECRET?: string;
  // Outgoing webhook URLs
  SLACK_WEBHOOK_URL?: string;
  // Outbound x402 payments (agent spending). Both must be configured before the
  // agent will send funds; see CfmailAgentSQLite.payExternalEndpoint.
  // Stripe card payments. STRIPE_SECRET_KEY is a secret; STRIPE_CONFIG is a
  // var. Card checkout is disabled unless both are present.
  STRIPE_SECRET_KEY?: string;
  STRIPE_CONFIG?: string;
  // Webhook email notifications. Off unless WEBHOOK_NOTIFY_EMAIL is set.
  WEBHOOK_NOTIFY_EMAIL?: string;
  WEBHOOK_NOTIFY_PROVIDERS?: string;
  OUTBOUND_PAY_TO_WHITELIST?: string;
  OUTBOUND_MAX_AMOUNT_ATOMIC?: string;
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
