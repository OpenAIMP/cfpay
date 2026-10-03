// Shared types for the CFmail Agent

export interface Env {
  EMAIL: SendEmail;
  EMAIL_DOMAIN: string;
  EMAIL_SECRET: string;
  AI: Ai;
  ASSETS: Fetcher;
  PAYMENT_PRIVATE_KEY: string;
  PAY_TO_ADDRESS: string;
  PAYMENT_NETWORK: string;
  PAYMENT_ASSET: string;
  PAYMENT_AMOUNT: string;
  PAYMENT_DESCRIPTION: string;
  DASHBOARD_API_KEY: string;
  CfmailAgent: DurableObjectNamespace;
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