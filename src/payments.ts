import { createWalletClient, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, sepolia } from "viem/chains";
import type { PaymentClaim, PaymentConfig, PaymentNetworkConfig } from "./types";

type X402Accept = {
  asset: string;
  payTo: string;
  amount: string;
  network: string;
};

type X402Challenge = {
  accepts: X402Accept[];
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const TESTNET_RPC: Record<string, { url: string; chainId: string }> = {
  "eip155:84532": { url: "https://sepolia.base.org", chainId: "0x14a34" },
  "eip155:11155111": { url: "https://ethereum-sepolia-rpc.publicnode.com", chainId: "0xaa36a7" },
};

const CHAIN_MAP: Record<string, Chain> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
  "eip155:11155111": sepolia,
  // Retain legacy network IDs for stored configurations during migration.
  base,
  "base-sepolia": baseSepolia,
  sepolia,
};

type RpcTransaction = {
  hash?: unknown;
  to?: unknown;
  value?: unknown;
  input?: unknown;
};

type RpcReceipt = {
  status?: unknown;
  logs?: unknown;
};

async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs = 10_000,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Testnet RPC request failed [HTTP ${response.status}].`);
  }
  const payload = await response.json() as {
    result?: T | null;
    error?: { message?: string };
  };
  if (payload.error) {
    throw new Error(`Testnet RPC error: ${payload.error.message || "unknown error"}`);
  }
  if (payload.result === undefined) {
    throw new Error("Testnet RPC returned an invalid response.");
  }
  return payload.result as T;
}

export async function verifyTestnetPayment(claim: PaymentClaim): Promise<void> {
  const rpc = TESTNET_RPC[claim.network];
  if (!rpc) {
    throw new Error("On-chain testnet verification is not configured for this network.");
  }

  const chainId = await rpcCall<string>(rpc.url, "eth_chainId", [], 5_000);
  if (chainId.toLowerCase() !== rpc.chainId) {
    throw new Error("Testnet RPC responded with an unexpected chain.");
  }

  const [transaction, receipt] = await Promise.all([
    rpcCall<RpcTransaction | null>(rpc.url, "eth_getTransactionByHash", [claim.txHash], 3_000),
    rpcCall<RpcReceipt | null>(rpc.url, "eth_getTransactionReceipt", [claim.txHash], 3_000),
  ]);
  if (!transaction || !receipt) {
    throw new Error("Payment transaction is not visible as confirmed yet. Verification can be retried; do not send another payment.");
  }
  if (typeof transaction.hash !== "string" || transaction.hash.toLowerCase() !== claim.txHash.toLowerCase()) {
    throw new Error("Testnet RPC returned a transaction that does not match the supplied hash.");
  }
  if (receipt.status !== "0x1") {
    throw new Error("Payment transaction did not succeed on-chain.");
  }

  if (claim.asset.toLowerCase() === ZERO_ADDRESS) {
    if (
      typeof transaction.to !== "string" ||
      transaction.to.toLowerCase() !== claim.payTo.toLowerCase() ||
      typeof transaction.value !== "string" ||
      BigInt(transaction.value) !== BigInt(claim.amount) ||
      transaction.input !== "0x"
    ) {
      throw new Error("On-chain native payment does not match the configured recipient and exact amount.");
    }
    return;
  }

  const input = transaction.input;
  if (
    typeof transaction.to !== "string" ||
    transaction.to.toLowerCase() !== claim.asset.toLowerCase() ||
    typeof input !== "string" ||
    !/^0xa9059cbb[0-9a-fA-F]{128}$/.test(input)
  ) {
    throw new Error("On-chain token payment is not a standard ERC-20 transfer.");
  }
  const recipientWord = input.slice(10, 74);
  const amountWord = input.slice(74, 138);
  if (
    !/^0{24}[0-9a-fA-F]{40}$/.test(recipientWord) ||
    `0x${recipientWord.slice(-40)}`.toLowerCase() !== claim.payTo.toLowerCase() ||
    BigInt(`0x${amountWord}`) !== BigInt(claim.amount)
  ) {
    throw new Error("On-chain token transfer does not match the configured recipient and exact amount.");
  }
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const expectedRecipientTopic = `0x${claim.payTo.slice(2).toLowerCase().padStart(64, "0")}`;
  const hasMatchingTransferLog =
    Array.isArray(receipt.logs) &&
    receipt.logs.some((log: unknown) => {
      if (!isRecord(log) || !Array.isArray(log.topics)) return false;
      return (
        typeof log.address === "string" &&
        log.address.toLowerCase() === claim.asset.toLowerCase() &&
        typeof log.topics[0] === "string" &&
        log.topics[0].toLowerCase() === transferTopic &&
        typeof log.topics[2] === "string" &&
        log.topics[2].toLowerCase() === expectedRecipientTopic &&
        typeof log.data === "string" &&
        /^0x[0-9a-fA-F]{64}$/.test(log.data) &&
        BigInt(log.data) === BigInt(claim.amount)
      );
    });
  if (!hasMatchingTransferLog) {
    throw new Error("Successful transaction did not emit a matching ERC-20 transfer event.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePaymentConfig(value: string): PaymentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PAYMENT_CONFIG must contain valid JSON");
  }

  if (!isRecord(parsed) || !isRecord(parsed.networks)) {
    throw new Error("PAYMENT_CONFIG must define a networks object");
  }

  const networks: Record<string, PaymentNetworkConfig> = {};
  for (const [network, config] of Object.entries(parsed.networks)) {
    if (!CHAIN_MAP[network]) {
      throw new Error(`PAYMENT_CONFIG contains unsupported network: ${network}`);
    }
    if (!isRecord(config) || typeof config.chainId !== "string") {
      throw new Error(`PAYMENT_CONFIG network ${network} must define chainId`);
    }

    const expectedChainId = `0x${CHAIN_MAP[network].id.toString(16)}`;
    if (config.chainId.toLowerCase() !== expectedChainId.toLowerCase()) {
      throw new Error(`PAYMENT_CONFIG network ${network} has an incorrect chainId`);
    }
    if (config.usdc !== undefined && (typeof config.usdc !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(config.usdc))) {
      throw new Error(`PAYMENT_CONFIG network ${network} has an invalid USDC address`);
    }
    for (const key of ["ethAmount", "usdcAmount"] as const) {
      if (config[key] !== undefined && (typeof config[key] !== "string" || !/^[1-9]\d*$/.test(config[key]))) {
        throw new Error(`PAYMENT_CONFIG network ${network} has an invalid ${key}`);
      }
    }
    if ((config.usdc === undefined) !== (config.usdcAmount === undefined)) {
      throw new Error(`PAYMENT_CONFIG network ${network} must define both usdc and usdcAmount`);
    }
    if (config.ethAmount === undefined && config.usdcAmount === undefined) {
      throw new Error(`PAYMENT_CONFIG network ${network} has no payment options`);
    }

    if (config.name !== undefined && typeof config.name !== "string") {
      throw new Error(`PAYMENT_CONFIG network ${network} has an invalid name`);
    }

    networks[network] = {
      chainId: config.chainId,
      ...(typeof config.name === "string" ? { name: config.name } : {}),
      ...(typeof config.usdc === "string" ? { usdc: config.usdc } : {}),
      ...(typeof config.ethAmount === "string" ? { ethAmount: config.ethAmount } : {}),
      ...(typeof config.usdcAmount === "string" ? { usdcAmount: config.usdcAmount } : {}),
    };
  }

  if (Object.keys(networks).length === 0) {
    throw new Error("PAYMENT_CONFIG must define at least one network");
  }

  return { networks };
}

export function createWallet(privateKey: string, network = "eip155:8453") {
  const account = privateKeyToAccount(privateKey as Hex);
  const chain = CHAIN_MAP[network];

  if (!chain) {
    throw new Error(`Unsupported payment network: ${network}`);
  }
  const client = createWalletClient({
    account,
    chain,
    transport: http(),
  });

  return { account, client };
}

export async function payX402Endpoint(
  url: string,
  method: string,
  body: string | null,
  privateKey: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const initialResponse = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });

  if (initialResponse.status !== 402) {
    return initialResponse;
  }

  const paymentRequired =
    initialResponse.headers.get("PAYMENT-REQUIRED") ??
    initialResponse.headers.get("x-payment-required");

  if (!paymentRequired) {
    throw new Error("No PAYMENT-REQUIRED or x-payment-required header in 402 response");
  }

  let challenge: X402Challenge;

  try {
    challenge = JSON.parse(atob(paymentRequired)) as X402Challenge;
  } catch {
    throw new Error("Invalid base64-encoded x402 payment challenge");
  }

  const accept = challenge.accepts?.[0];

  if (!accept) {
    throw new Error("x402 payment challenge contains no accepted payment option");
  }

  if (!accept.asset || !accept.payTo || !accept.amount || !accept.network) {
    throw new Error("x402 payment option is missing required fields");
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(accept.asset)) {
    throw new Error("x402 asset is not a valid EVM address");
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(accept.payTo)) {
    throw new Error("x402 payTo is not a valid EVM address");
  }

  let amount: bigint;

  try {
    amount = BigInt(accept.amount);
  } catch {
    throw new Error("x402 amount is not a valid integer");
  }

  if (amount <= 0n) {
    throw new Error("x402 amount must be greater than zero");
  }

  const usdcContract = accept.asset as Address;
  const payTo = accept.payTo as Address;
  const { account, client } = createWallet(privateKey, accept.network);
  const isNativeETH = usdcContract.toLowerCase() === ZERO_ADDRESS;

  let txHash: Hex;

  if (isNativeETH) {
    txHash = await client.sendTransaction({
      account,
      to: payTo,
      value: amount,
    });
  } else {
    const transferData = (
      "0xa9059cbb" +
      payTo.slice(2).toLowerCase().padStart(64, "0") +
      amount.toString(16).padStart(64, "0")
    ) as Hex;

    txHash = await client.sendTransaction({
      account,
      to: usdcContract,
      data: transferData,
    });
  }

  const paymentSignature = btoa(
    JSON.stringify({
      x402Version: 2,
      scheme: "exact",
      network: accept.network,
      asset: accept.asset,
      amount: accept.amount,
      payTo: accept.payTo,
      txHash,
    }),
  );

  return fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-SIGNATURE": paymentSignature,
      ...headers,
    },
    body,
  });
}

export function formatAmount(atomicUnits: string): string {
  const units = BigInt(atomicUnits);
  const whole = units / 1_000_000n;
  const fractional = (units % 1_000_000n).toString().padStart(6, "0");

  return `$${whole}.${fractional}`;
}

export function formatEthAmount(atomicUnits: string): string {
  const units = BigInt(atomicUnits);
  const whole = units / 1_000_000_000_000_000_000n;
  const fractional = (units % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");

  return fractional ? `${whole}.${fractional}` : whole.toString();
}

export function generateId(): string {
  return `${Date.now()}-${crypto.randomUUID()}`;
}