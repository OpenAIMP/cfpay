import { Hono } from "hono";
import type { Env } from "./types";
import { formatAmount } from "./payments";
import { CfmailAgent } from "./agent";

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  function requireAuth(c: any, next: any) {
    const apiKey = c.req.header("X-API-Key");
    if (apiKey !== c.env.DASHBOARD_API_KEY) { return c.json({ error: "Unauthorized" }, 401); }
    return next();
  }

  function getAgent(c: any) {
    const agentId = c.env.CfmailAgent.idFromName("default");
    return c.env.CfmailAgent.get(agentId) as DurableObjectStub<CfmailAgent>;
  }

  app.get("/health", (c) => { return c.json({ status: "ok", service: "cfmail-agent", version: "9.1.0" }); });

  app.post("/api/process", async (c) => {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    if (!paymentHeader) {
      return c.json({ error: "Payment required", x402: { network: c.env.PAYMENT_NETWORK, asset: c.env.PAYMENT_ASSET, amount: c.env.PAYMENT_AMOUNT, payTo: c.env.PAY_TO_ADDRESS, description: c.env.PAYMENT_DESCRIPTION } }, 402);
    }
    const body = await c.req.json<{ email: string; request: string }>();
    const agent = getAgent(c);
    const result = await agent.processPaidRequest(body.email, body.request);
    return c.json({ success: true, receipt: result });
  });

  app.get("/api/emails", async (c) => {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    if (!paymentHeader) {
      return c.json({ error: "Payment required", x402: { network: c.env.PAYMENT_NETWORK, asset: c.env.PAYMENT_ASSET, amount: c.env.PAYMENT_AMOUNT, payTo: c.env.PAY_TO_ADDRESS, description: "Access to stored email history" } }, 402);
    }
    const agent = getAgent(c);
    const emails = await agent.getEmails(null, 50);
    return c.json({ emails });
  });

  app.post("/mcp/tools/process", async (c) => {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    if (!paymentHeader) {
      return c.json({ error: "Payment required", x402: { network: c.env.PAYMENT_NETWORK, asset: c.env.PAYMENT_ASSET, amount: c.env.PAYMENT_AMOUNT, payTo: c.env.PAY_TO_ADDRESS, description: "Process email request via MCP tool" } }, 402);
    }
    const body = await c.req.json<{ email: string; request: string }>();
    const agent = getAgent(c);
    const result = await agent.processPaidRequest(body.email, body.request);
    return c.json({ content: [{ type: "text", text: `Processed and sent email response to ${body.email}` }], receipt: result });
  });

  app.get("/api/dashboard/stats", requireAuth, async (c) => {
    const agent = getAgent(c);
    const state = await agent.getDashboardData();
    return c.json({
      totalEmailsReceived: state.totalEmailsReceived || 0, totalEmailsSent: state.totalEmailsSent || 0,
      totalPaymentsReceived: state.totalPaymentsReceived || 0, totalPaymentsSent: state.totalPaymentsSent || 0,
      totalRevenue: formatAmount(c.env.PAYMENT_AMOUNT).replace("$", "") + " USDC per request",
    });
  });

  app.get("/api/dashboard/emails", requireAuth, async (c) => {
    const direction = c.req.query("direction") || null;
    const agent = getAgent(c);
    const emails = await agent.getEmails(direction, 100);
    return c.json({ emails });
  });

  app.get("/api/dashboard/payments", requireAuth, async (c) => {
    const direction = c.req.query("direction") || null;
    const agent = getAgent(c);
    const payments = await agent.getPayments(direction, 100);
    return c.json({ payments });
  });

  app.post("/api/dashboard/send-email", requireAuth, async (c) => {
    const body = await c.req.json<{ to: string; subject: string; body: string }>();
    const agent = getAgent(c);
    const result = await agent.sendOutboundEmail(body.to, body.subject, body.body);
    return c.json(result);
  });

  app.post("/api/dashboard/chat", requireAuth, async (c) => {
    const body = await c.req.json<{ message: string }>();
    const agent = getAgent(c);
    const result = await agent.chat(body.message);
    return c.json(result);
  });

  app.get("/api/dashboard/payment-config", requireAuth, async (c) => {
    return c.json({
      payTo: c.env.PAY_TO_ADDRESS, network: c.env.PAYMENT_NETWORK, asset: c.env.PAYMENT_ASSET,
      amount: c.env.PAYMENT_AMOUNT, formattedAmount: formatAmount(c.env.PAYMENT_AMOUNT), description: c.env.PAYMENT_DESCRIPTION,
    });
  });

  return app;
}