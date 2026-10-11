/**
 * Unit tests for pure payment helpers (src/payments.ts):
 * PAYMENT_CONFIG parsing and amount formatting.
 */
import { describe, it, expect } from "vitest";
import { parsePaymentConfig, formatAmount, formatEthAmount } from "../src/payments";

const VALID_CONFIG = JSON.stringify({
  networks: {
    "eip155:8453": {
      chainId: "0x2105",
      name: "Base",
      ethAmount: "1000000000000000",
      usdc: "0xabababababababababababababababababababab",
      usdcAmount: "10000",
    },
  },
});

describe("parsePaymentConfig", () => {
  it("accepts a valid config", () => {
    const config = parsePaymentConfig(VALID_CONFIG);
    expect(config.networks["eip155:8453"].chainId).toBe("0x2105");
    expect(config.networks["eip155:8453"].ethAmount).toBe("1000000000000000");
    expect(config.networks["eip155:8453"].usdcAmount).toBe("10000");
  });

  it("rejects invalid JSON", () => {
    expect(() => parsePaymentConfig("not json")).toThrow(/valid JSON/);
  });

  it("rejects a missing networks object", () => {
    expect(() => parsePaymentConfig(JSON.stringify({}))).toThrow(/networks object/);
  });

  it("rejects an unsupported network", () => {
    expect(() =>
      parsePaymentConfig(
        JSON.stringify({ networks: { "eip155:9999": { chainId: "0x270f" } } }),
      ),
    ).toThrow(/unsupported network/);
  });

  it("rejects a wrong chainId", () => {
    expect(() =>
      parsePaymentConfig(
        JSON.stringify({ networks: { "eip155:8453": { chainId: "0x1", ethAmount: "1" } } }),
      ),
    ).toThrow(/incorrect chainId/);
  });

  it("rejects usdc without usdcAmount", () => {
    expect(() =>
      parsePaymentConfig(
        JSON.stringify({
          networks: {
            "eip155:8453": {
              chainId: "0x2105",
              usdc: "0xabababababababababababababababababababab",
            },
          },
        }),
      ),
    ).toThrow(/both usdc and usdcAmount/);
  });

  it("rejects a network with no payment options", () => {
    expect(() =>
      parsePaymentConfig(
        JSON.stringify({ networks: { "eip155:8453": { chainId: "0x2105" } } }),
      ),
    ).toThrow(/no payment options/);
  });

  it("rejects a non-positive amount", () => {
    expect(() =>
      parsePaymentConfig(
        JSON.stringify({
          networks: { "eip155:8453": { chainId: "0x2105", ethAmount: "0" } },
        }),
      ),
    ).toThrow(/invalid ethAmount/);
  });
});

describe("formatAmount", () => {
  it("formats USDC atomic units as dollars", () => {
    expect(formatAmount("1000000")).toBe("$1.000000");
    expect(formatAmount("2500000")).toBe("$2.500000");
    expect(formatAmount("1")).toBe("$0.000001");
  });
});

describe("formatEthAmount", () => {
  it("formats wei as ETH, trimming trailing zeros", () => {
    expect(formatEthAmount("1000000000000000000")).toBe("1");
    expect(formatEthAmount("1500000000000000000")).toBe("1.5");
    expect(formatEthAmount("1000000000000000")).toBe("0.001");
  });
});
