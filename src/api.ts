import { Hono } from "hono";
import type { Env, PaymentClaim } from "./types";
import { formatAmount, formatEthAmount, parsePaymentConfig, verifyTestnetPayment } from "./payments";
import { CfmailAgentSQLite as CfmailAgent } from "./agent";

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  function requireAuth(c: any, next: any) {
    const presented = c.req.header("X-API-Key") ?? "";
    // Fail closed: an unset DASHBOARD_API_KEY must never authorize a request.
    if (!c.env.DASHBOARD_API_KEY || presented !== c.env.DASHBOARD_API_KEY) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  }

  function getAgent(c: any) {
    const agentId = c.env.CfmailAgent.idFromName("agent");
    return c.env.CfmailAgent.get(agentId) as any;
  }

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  function parsePaymentClaim(header: string, env: Env): PaymentClaim {
    let value: unknown;
    try {
      value = JSON.parse(atob(header));
    } catch {
      throw new Error("Invalid base64-encoded PAYMENT-SIGNATURE");
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("asset" in value) ||
      !("payTo" in value) ||
      !("amount" in value) ||
      !("network" in value) ||
      !("txHash" in value) ||
      typeof value.asset !== "string" ||
      typeof value.payTo !== "string" ||
      typeof value.amount !== "string" ||
      typeof value.network !== "string" ||
      typeof value.txHash !== "string" ||
      !/^0x[a-fA-F0-9]{40}$/.test(value.asset) ||
      !/^0x[a-fA-F0-9]{40}$/.test(value.payTo) ||
      !/^0x[a-fA-F0-9]{64}$/.test(value.txHash) ||
      !/^[1-9]\d*$/.test(value.amount)
    ) {
      throw new Error("PAYMENT-SIGNATURE is missing valid payment details");
    }
    const configuredNetwork = getPaymentConfig(env).networks[value.network];
    if (!configuredNetwork || value.payTo.toLowerCase() !== env.PAY_TO_ADDRESS.toLowerCase()) {
      throw new Error("PAYMENT-SIGNATURE does not match a configured network or recipient");
    }
    const isConfiguredNativePayment =
      value.asset.toLowerCase() === ZERO_ADDRESS &&
      configuredNetwork.ethAmount !== undefined &&
      value.amount === configuredNetwork.ethAmount;
    const isConfiguredTokenPayment =
      configuredNetwork.usdc?.toLowerCase() === value.asset.toLowerCase() &&
      configuredNetwork.usdcAmount !== undefined &&
      value.amount === configuredNetwork.usdcAmount;
    if (!isConfiguredNativePayment && !isConfiguredTokenPayment) {
      throw new Error("PAYMENT-SIGNATURE asset is not configured for this network");
    }
    return {
      asset: value.asset,
      payTo: value.payTo,
      amount: value.amount,
      network: value.network,
      txHash: value.txHash,
    };
  }

  function getPaymentConfig(env: Env) {
    return parsePaymentConfig(env.PAYMENT_CONFIG);
  }

  function buildPaymentChallenge(env: Env, description: string) {
    const config = getPaymentConfig(env);
    const accepts = [];

    for (const [network, options] of Object.entries(config.networks)) {
      if (options.ethAmount) {
        accepts.push({
          scheme: "exact",
          network,
          asset: ZERO_ADDRESS,
          amount: options.ethAmount,
          payTo: env.PAY_TO_ADDRESS,
          maxTimeoutSeconds: 3600,
          extra: { label: "ETH", name: options.name || network },
        });
      }
      if (options.usdc && options.usdcAmount) {
        accepts.push({
          scheme: "exact",
          network,
          asset: options.usdc,
          amount: options.usdcAmount,
          payTo: env.PAY_TO_ADDRESS,
          maxTimeoutSeconds: 3600,
          extra: { label: "USDC", name: options.name || network },
        });
      }
    }

    const challenge = {
      x402Version: 2,
      resource: {
        url: "https://pay.openaimp.com/api/process",
        description: description,
        mimeType: "application/json",
      },
      accepts,
    };
    const encoded = btoa(JSON.stringify(challenge));
    return {
      "PAYMENT-REQUIRED": encoded,
      "x-payment-required": encoded,
    };
  }

  async function verifyPayment(
    env: Env,
    paymentHeader: string,
    challenge: unknown,
    claim: PaymentClaim,
  ): Promise<{ verified: boolean; receipt?: string; error?: string }> {
    if (claim.network === "eip155:84532" || claim.network === "eip155:11155111") {
      try {
        await verifyTestnetPayment(claim);
        return {
          verified: true,
          receipt: btoa(JSON.stringify({
            verified: true,
            network: claim.network,
            txHash: claim.txHash,
            testnet: true,
            timestamp: Date.now(),
          })),
        };
      } catch (error) {
        console.warn("Testnet on-chain payment verification failed:", error);
        return {
          verified: false,
          error: error instanceof Error ? error.message : "Testnet payment verification failed.",
        };
      }
    }

    const facilitatorUrl = env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
    try {
      const parsedFacilitatorUrl = new URL(facilitatorUrl);
      if (parsedFacilitatorUrl.protocol !== "https:") {
        return { verified: false, error: "The x402 facilitator URL must use HTTPS." };
      }
      const response = await fetch(`${facilitatorUrl.replace(/\/+$/, "")}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentHeader,
          paymentRequirements: challenge,
        }),
      });
      const result = await response.json().catch(() => null) as {
        isValid?: boolean;
        invalidReason?: string;
        reason?: string;
        receipt?: string;
      } | null;
      if (!response.ok) {
        return {
          verified: false,
          error: result?.invalidReason || result?.reason || `Facilitator verification failed [HTTP ${response.status}].`,
        };
      }
      if (result?.isValid !== true) {
        return {
          verified: false,
          error: result?.invalidReason || result?.reason || "Facilitator did not confirm the payment.",
        };
      }
      return {
        verified: true,
        receipt: result.receipt || btoa(JSON.stringify({ verified: true, timestamp: Date.now() })),
      };
    } catch (error) {
      console.error("Facilitator verification failed:", error);
      return {
        verified: false,
        error: error instanceof Error ? error.message : "Facilitator verification is unavailable.",
      };
    }
  }

  function buildPaymentResponse(receipt: string) {
    return {
      "PAYMENT-RESPONSE": receipt,
      "x-payment-response": receipt,
    };
  }

  async function verifyRequestPayment(
    env: Env,
    paymentHeader: string,
    description: string,
  ): Promise<{ verified: true; claim: PaymentClaim; receipt: string } | { verified: false; error: string }> {
    let claim: PaymentClaim;
    try {
      claim = parsePaymentClaim(paymentHeader, env);
    } catch (error) {
      return {
        verified: false,
        error: error instanceof Error ? error.message : "Invalid payment signature.",
      };
    }
    const challengeHeaders = buildPaymentChallenge(env, description);
    const challenge = JSON.parse(atob(challengeHeaders["PAYMENT-REQUIRED"])) as unknown;
    const verification = await verifyPayment(env, paymentHeader, challenge, claim);
    if (!verification.verified) {
      return { verified: false, error: verification.error || "Payment verification failed." };
    }
    return {
      verified: true,
      claim,
      receipt: verification.receipt || btoa(JSON.stringify({ verified: true, timestamp: Date.now() })),
    };
  }

  app.get("/health", (c) => {
    return c.json({ status: "ok", service: "cfmail-agent", version: "9.2.0" });
  });

  app.post("/api/process", async (c) => {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    if (!paymentHeader) {
      return c.json(
        { error: "Payment required" },
        402,
        buildPaymentChallenge(c.env, c.env.PAYMENT_DESCRIPTION),
      );
    }
    const verification = await verifyRequestPayment(c.env, paymentHeader, c.env.PAYMENT_DESCRIPTION);
    if (!verification.verified) {
      return c.json({ error: "Payment verification failed", details: verification.error }, 402);
    }
    const body = await c.req.json<{ email: string; request: string }>();
    const agent = getAgent(c);
    const result = await agent.processPaidRequest(body.email, body.request, verification.claim);
    c.header("PAYMENT-RESPONSE", verification.receipt);
    c.header("x-payment-response", verification.receipt);
    return c.json({ success: true, receipt: result });
  });

  app.get("/api/emails", async (c) => {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    if (!paymentHeader) {
      return c.json(
        { error: "Payment required" },
        402,
        buildPaymentChallenge(c.env, "Access to stored email history"),
      );
    }
    const verification = await verifyRequestPayment(c.env, paymentHeader, "Access to stored email history");
    if (!verification.verified) {
      return c.json({ error: "Payment verification failed", details: verification.error }, 402);
    }
    const agent = getAgent(c);
    const emails = await agent.getEmails(null, 50);
    c.header("PAYMENT-RESPONSE", verification.receipt);
    c.header("x-payment-response", verification.receipt);
    return c.json({ emails });    
  });

  app.post("/mcp/tools/process", async (c) => {
    const paymentHeader = c.req.header("PAYMENT-SIGNATURE");
    if (!paymentHeader) {
      return c.json(
        { error: "Payment required" },
        402,
        buildPaymentChallenge(c.env, "Process email request via MCP tool"),
      );
    }
    const verification = await verifyRequestPayment(c.env, paymentHeader, "Process email request via MCP tool");
    if (!verification.verified) {
      return c.json({ error: "Payment verification failed", details: verification.error }, 402);
    }
    const body = await c.req.json<{ email: string; request: string }>();
    const agent = getAgent(c);
    const result = await agent.processPaidRequest(body.email, body.request, verification.claim);
    c.header("PAYMENT-RESPONSE", verification.receipt);
    c.header("x-payment-response", verification.receipt);
    return c.json({
      content: [
        { type: "text", text: `Processed and sent email response to ${body.email}` },
      ],
      receipt: result,
    });
  });

  app.get("/api/dashboard/stats", requireAuth, async (c) => {
    try {
      const agent = getAgent(c);
      const state = await agent.getDashboardData();
      const firstNetwork = Object.values(getPaymentConfig(c.env).networks)[0];
      const totalRevenue = firstNetwork?.usdcAmount
        ? `${formatAmount(firstNetwork.usdcAmount).replace("$", "")} USDC per request`
        : firstNetwork?.ethAmount
          ? `${formatEthAmount(firstNetwork.ethAmount)} ETH per request`
          : "N/A";
      return c.json({
        totalEmailsReceived: state.totalEmailsReceived || 0,
        totalEmailsSent: state.totalEmailsSent || 0,
        totalPaymentsReceived: state.totalPaymentsReceived || 0,
        totalPaymentsSent: state.totalPaymentsSent || 0,
        totalRevenue,
      });
    } catch (error: any) {
      console.error("Dashboard stats error:", error);
      return c.json({ error: error.message || "Failed to load stats" }, 500);
    }
  });

  app.get("/api/dashboard/emails", requireAuth, async (c) => {
    const direction = c.req.query("direction") || null;
    const agent = getAgent(c);
    const emails = await agent.getEmailsExcludingSlack(direction, 100);
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

  // WebSocket endpoint for real-time updates.
  //
  // This hands the raw request to the Durable Object, which exposes the entire
  // @callable RPC surface — including payExternalEndpoint, which spends real
  // funds. It must therefore be authenticated. Browsers cannot set headers on a
  // WebSocket handshake, so the dashboard passes the same DASHBOARD_API_KEY it
  // already uses for the REST routes as a ?token= query parameter; the header is
  // accepted too for non-browser clients.
  app.get("/ws", async (c) => {
    const upgradeHeader = c.req.header("Upgrade");
    if (upgradeHeader !== "websocket") {
      return c.text("Expected Upgrade: websocket", 426);
    }

    const presented = c.req.header("X-API-Key") ?? c.req.query("token") ?? "";

    // Fail closed: an unset key must never match an empty presented value.
    if (!c.env.DASHBOARD_API_KEY || presented !== c.env.DASHBOARD_API_KEY) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const agentId = c.env.CfmailAgent.idFromName("agent");
    const agent = c.env.CfmailAgent.get(agentId) as any;
    // The Durable Object reads its instance name from these headers
    // (partyserver's Server.fetch throws "Missing namespace or room headers"
    // without x-partykit-room on a cold instance, which surfaces as the
    // WebSocket closing with 1011 before onConnect ever runs). routeAgentRequest
    // and getAgentByName set them for their own routes; /ws forwards the raw
    // request, so mirror them here.
    const request = new Request(c.req.raw);
    request.headers.set("x-partykit-room", "agent");
    request.headers.set("x-partykit-namespace", "CfmailAgent");
    return agent.fetch(request);
  });

  app.get("/api/dashboard/payment-config", requireAuth, async (c) => {
    const config = getPaymentConfig(c.env);
    const accepts = [];
    for (const [network, options] of Object.entries(config.networks)) {
      if (options.ethAmount) {
        accepts.push({
          label: "ETH",
          network,
          networkName: options.name || network,
          chainId: options.chainId,
          asset: ZERO_ADDRESS,
          amount: options.ethAmount,
          formatted: `${formatEthAmount(options.ethAmount)} ETH`,
        });
      }
      if (options.usdc && options.usdcAmount) {
        accepts.push({
          label: "USDC",
          network,
          networkName: options.name || network,
          chainId: options.chainId,
          asset: options.usdc,
          amount: options.usdcAmount,
          formatted: `${formatAmount(options.usdcAmount)} USDC`,
        });
      }
    }

    const [defaultOption] = accepts;
    return c.json({
      payTo: c.env.PAY_TO_ADDRESS,
      network: defaultOption?.network,
      asset: defaultOption?.asset,
      amount: defaultOption?.amount,
      formattedAmount: defaultOption?.formatted,
      description: c.env.PAYMENT_DESCRIPTION,
      facilitator: c.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
      accepts,
    });
  });

  app.get("/api/dashboard/slack", requireAuth, async (c) => {
    const agent = getAgent(c);
    const messages = await agent.getSlackMessages(100);
    return c.json({ messages });
  });


  app.get("/api/dashboard/webhooks", requireAuth, async (c) => {
    const provider = c.req.query("provider") || null;
    const agent = getAgent(c);
    const events = await agent.getWebhookEvents(provider, 100);
    return c.json({ events });
  });

  app.post("/api/dashboard/notify-slack", requireAuth, async (c) => {
    const body = await c.req.json<{ message: string }>();
    const agent = getAgent(c);
    const result = await agent.notifySlack(body.message);
    return c.json(result);
  });
  return app;
}