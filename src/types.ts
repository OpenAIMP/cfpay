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
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}
