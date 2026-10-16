import { describe, expect, it } from "vitest";
import {
  extractAccountId,
  extractExpirations,
  matchProp,
  missingRequired,
  parseSymbolsParam,
  parseToolJson,
  pickArgs,
  schemaProps,
} from "../src/public-data";

/**
 * The desk data endpoints (issue #112 part 2) map their semantic
 * parameters onto whatever property names a Public.com tool's live
 * inputSchema declares. These tests pin that mapping: a name is only ever
 * used when the schema actually offers it.
 */
describe("public desk data: schema mapping", () => {
  it("reads properties and required lists defensively", () => {
    expect(schemaProps(null)).toEqual({ properties: {}, required: [] });
    expect(schemaProps("junk")).toEqual({ properties: {}, required: [] });
    expect(
      schemaProps({ properties: { symbol: { type: "string" } }, required: ["symbol", 3] }),
    ).toEqual({ properties: { symbol: { type: "string" } }, required: ["symbol"] });
  });

  it("matches a declared property exactly, then case-insensitively", () => {
    const props = { Symbol: { type: "string" }, EXPIRATIONDATE: { type: "string" } };
    expect(matchProp(props, ["symbol", "ticker"])).toBe("Symbol");
    expect(matchProp(props, ["expiration", "expirationDate"])).toBe("EXPIRATIONDATE");
    expect(matchProp(props, ["accountId"])).toBeUndefined();
  });

  it("maps concepts onto declared names and leaves the rest unmatched", () => {
    const schema = {
      properties: { ticker: { type: "string" }, expiration_date: { type: "string" } },
      required: ["ticker"],
    };
    const { args, matched } = pickArgs(schema, {
      symbol: { names: ["symbol", "ticker"], value: "SMH" },
      expiration: { names: ["expiration", "expirationDate", "expiry", "expiration_date"], value: "2026-11-20" },
      account: { names: ["accountId"], value: "x" },
    });
    expect(matched).toEqual({ symbol: "ticker", expiration: "expiration_date", account: undefined });
    expect(args).toEqual({ ticker: "SMH", expiration_date: "2026-11-20" });
    expect(missingRequired(schema, args)).toEqual([]);
  });

  it("reports required properties the args do not cover", () => {
    const schema = { properties: { a: {}, b: {} }, required: ["a", "b"] };
    expect(missingRequired(schema, { a: 1 })).toEqual(["b"]);
    expect(missingRequired(null, {})).toEqual([]);
  });

  it("parses tool JSON and rejects non-JSON", () => {
    expect(parseToolJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolJson("[1,2]")).toEqual([1, 2]);
    expect(parseToolJson("not json")).toBeUndefined();
  });
});

describe("public desk data: request and result shapes", () => {
  it("normalizes the symbols parameter", () => {
    expect(parseSymbolsParam("nvda, amd ,NVDA,, spy")).toEqual(["NVDA", "AMD", "SPY"]);
    expect(parseSymbolsParam("")).toEqual([]);
    expect(parseSymbolsParam(undefined)).toEqual([]);
    expect(parseSymbolsParam("BRK.B,!!!,toolongsymbolname")).toEqual(["BRK.B"]);
    expect(parseSymbolsParam(Array(20).fill("A").join(","))).toEqual(["A"]);
  });

  it("extracts an account id across get_accounts shapes", () => {
    expect(extractAccountId([{ accountId: "acc-1" }])).toBe("acc-1");
    expect(extractAccountId({ accounts: [{ id: "acc-2" }] })).toBe("acc-2");
    expect(extractAccountId({ account_id: "acc-3" })).toBe("acc-3");
    expect(extractAccountId([{ name: "Main" }, { uuid: "acc-4" }])).toBe("acc-4");
    expect(extractAccountId({ accounts: [] })).toBeUndefined();
    expect(extractAccountId(null)).toBeUndefined();
    expect(extractAccountId("acc-5")).toBeUndefined();
  });

  it("extracts expirations across get_option_expirations shapes", () => {
    expect(extractExpirations(["2026-10-23", "2026-10-30"])).toEqual(["2026-10-23", "2026-10-30"]);
    expect(
      extractExpirations([{ expirationDate: "2026-10-23T00:00:00Z" }, { date: "2026-11-20" }]),
    ).toEqual(["2026-10-23", "2026-11-20"]);
    expect(extractExpirations({ expirations: ["2026-10-23"] })).toEqual(["2026-10-23"]);
    expect(extractExpirations(["not-a-date", 42])).toEqual([]);
    expect(extractExpirations(null)).toEqual([]);
  });
});
