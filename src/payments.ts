import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";

export function createWallet(privateKey: string) {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const client = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });
  return { account, client };
}

export async function payX402Endpoint(
  url: string,
  method: string,
  body: string | null,
  privateKey: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  const { account, client } = createWallet(privateKey);

  const initialResponse = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });

  if (initialResponse.status !== 402) {
    return initialResponse;
  }

  const paymentRequired =
    initialResponse.headers.get("PAYMENT-REQUIRED") ||
    initialResponse.headers.get("x-payment-required");

  if (!paymentRequired) {
    throw new Error("No PAYMENT-REQUIRED header in 402 response");
  }

  const challenge = JSON.parse(atob(paymentRequired));
  const accept = challenge.accepts[0];

  const usdcContract = accept.asset as `0x${string}`;
  const payTo = accept.payTo as `0x${string}`;
  const amount = BigInt(accept.amount);

  const transferData =
    "0xa9059cbb" +
    payTo.toLowerCase().replace("0x", "").padStart(64, "0") +
    amount.toString(16).padStart(64, "0");

  const txHash = await client.sendTransaction({
    account,
    to: usdcContract,
    data: transferData as `0x${string}`,
  });

  const paymentSignature = btoa(
    JSON.stringify({
      x402Version: 2,
      scheme: "exact",
      network: accept.network,
      asset: accept.asset,
      amount: accept.amount,
      payTo: accept.payTo,
      txHash,
    })
  );

  const retryResponse = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-SIGNATURE": paymentSignature,
      ...headers,
    },
    body,
  });

  return retryResponse;
}

export function formatAmount(atomicUnits: string): string {
  const units = parseInt(atomicUnits, 10);
  const usd = units / 1_000_000;
  return `$${usd.toFixed(6)}`;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}