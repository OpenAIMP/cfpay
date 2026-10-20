/**
 * Server-side Public.com data reads for the Autopilot Trading Desk
 * (issue #112, part 2): the quotes / portfolio / chain endpoints in
 * src/api.ts call MCP tools directly instead of going through the model.
 *
 * The tools' parameter names are NOT hardcoded here. Public.com does not
 * publish the schemas and the MCP server requires the account token even
 * for tools/list, so each endpoint reads the tool's live inputSchema via
 * listTools and maps the endpoint's semantic parameters onto property
 * names the schema actually declares (see pickArgs). A name is used only
 * when the schema offers it; anything required that cannot be mapped is
 * reported back by name rather than guessed.
 */

/** The two halves of a JSON-Schema object this module reasons about. */
export function schemaProps(schema: unknown): {
  properties: Record<string, unknown>;
  required: string[];
} {
  if (!schema || typeof schema !== "object") return { properties: {}, required: [] };
  const s = schema as Record<string, unknown>;
  const properties =
    s.properties && typeof s.properties === "object"
      ? (s.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(s.required)
    ? s.required.filter((r): r is string => typeof r === "string")
    : [];
  return { properties, required };
}

/** First candidate the schema declares — exact match, then case-insensitive. */
export function matchProp(
  properties: Record<string, unknown>,
  names: string[],
): string | undefined {
  for (const n of names) if (n in properties) return n;
  const lower = new Map(Object.keys(properties).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const hit = lower.get(n.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Map semantic parameters onto a tool's declared properties. `spec` maps a
 * concept name to its candidate property names (in preference order) and
 * the value to send. Returns the args to call with and, per concept, the
 * property name that matched (undefined when the schema offers none).
 */
export function pickArgs(
  schema: unknown,
  spec: Record<string, { names: string[]; value: unknown }>,
): { args: Record<string, unknown>; matched: Record<string, string | undefined> } {
  const { properties } = schemaProps(schema);
  const args: Record<string, unknown> = {};
  const matched: Record<string, string | undefined> = {};
  for (const [concept, { names, value }] of Object.entries(spec)) {
    const prop = matchProp(properties, names);
    matched[concept] = prop;
    if (prop) args[prop] = value;
  }
  return { args, matched };
}

/** Required schema properties the args do not cover. */
export function missingRequired(
  schema: unknown,
  args: Record<string, unknown>,
): string[] {
  return schemaProps(schema).required.filter((r) => !(r in args));
}

/** Parse a tool's text result as JSON; undefined when it is not JSON. */
export function parseToolJson(text: string): unknown {
  try {
    const parsed = JSON.parse(text);
    // Some MCP wrappers double-encode: the text parses to a string that is
    // itself JSON. Unwrap one level so shape extraction can work on it.
    if (typeof parsed === "string") {
      try {
        const inner = JSON.parse(parsed);
        if (inner && typeof inner === "object") return inner;
      } catch {
        /* keep the string */
      }
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** `?symbols=` parsing for the quotes endpoint: uppercased, deduped, capped. */
export function parseSymbolsParam(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim().toUpperCase();
    if (/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(s)) seen.add(s);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

const ACCOUNT_ID_FIELDS = ["accountId", "account_id", "accountNumber", "id", "uuid"];

/**
 * The first account id in a get_accounts result, across the shapes such
 * tools return: an array of account objects, an object with an accounts
 * array, or a single account object.
 */
export function extractAccountId(result: unknown): string | undefined {
  const fromObject = (o: unknown): string | undefined => {
    if (!o || typeof o !== "object") return undefined;
    const rec = o as Record<string, unknown>;
    for (const f of ACCOUNT_ID_FIELDS) {
      if (typeof rec[f] === "string" && rec[f]) return rec[f] as string;
    }
    return undefined;
  };
  if (Array.isArray(result)) {
    for (const el of result) {
      const id = fromObject(el);
      if (id) return id;
    }
    return undefined;
  }
  if (result && typeof result === "object") {
    const direct = fromObject(result);
    if (direct) return direct;
    const rec = result as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (Array.isArray(rec[k])) {
        const id = extractAccountId(rec[k]);
        if (id) return id;
      }
    }
  }
  return undefined;
}

/**
 * One position row out of a get_portfolio result, normalized to the
 * fields this system reasons about. Everything the tool did not
 * provide stays null - nothing is estimated or invented here.
 */
export interface PortfolioPosition {
  /** Ticker as the tool reported it (an OCC-style code for options). */
  symbol: string;
  /** Signed quantity (negative = short), in the tool's own units. */
  quantity: number;
  /** Market value in dollars when the tool reported one, else null. */
  marketValue: number | null;
  /** Current per-unit price when the tool reported one, else null. */
  currentPrice: number | null;
  /** "equity" / "option" when the row says so, the raw type otherwise. */
  kind: string | null;
}

const POSITION_SYMBOL_FIELDS = ["symbol", "ticker", "instrumentSymbol", "instrument_symbol"];
const POSITION_QUANTITY_FIELDS = ["quantity", "shares", "units", "qty", "contracts"];
const POSITION_VALUE_FIELDS = ["marketValue", "market_value", "value", "currentValue", "totalValue"];
const POSITION_PRICE_FIELDS = ["currentPrice", "lastPrice", "price", "mark", "unitPrice"];

function numField(rec: Record<string, unknown>, fields: string[]): number | null {
  for (const f of fields) {
    const v = rec[f];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function positionFromRow(row: unknown): PortfolioPosition | null {
  if (!row || typeof row !== "object") return null;
  const rec = row as Record<string, unknown>;
  // The symbol may ride on a nested instrument object.
  let symbol = "";
  for (const f of POSITION_SYMBOL_FIELDS) {
    if (typeof rec[f] === "string" && (rec[f] as string).trim()) {
      symbol = (rec[f] as string).trim().toUpperCase();
      break;
    }
  }
  if (!symbol) {
    const inst = rec.instrument;
    if (inst && typeof inst === "object") {
      // Symbol from the instrument; quantity/value from whichever
      // level of the row carries them (the outer row wins conflicts).
      const merged: Record<string, unknown> = { ...(inst as Record<string, unknown>), ...rec };
      delete merged.instrument;
      return positionFromRow(merged);
    }
    return null;
  }
  const quantity = numField(rec, POSITION_QUANTITY_FIELDS);
  if (quantity === null || quantity === 0) return null;
  const rawType = [rec.type, rec.assetType, rec.asset_type, rec.instrumentType]
    .find((v) => typeof v === "string" && (v as string).trim()) as string | undefined;
  let kind: string | null = rawType ? rawType.trim().toLowerCase() : null;
  if (!kind && /^(call|put)$/i.test(String(rec.optionType ?? rec.option_type ?? ""))) kind = "option";
  if (kind && /option|call|put/.test(kind)) kind = "option";
  else if (kind && /equity|stock|share/.test(kind)) kind = "equity";
  return {
    symbol,
    quantity,
    marketValue: numField(rec, POSITION_VALUE_FIELDS),
    currentPrice: numField(rec, POSITION_PRICE_FIELDS),
    kind,
  };
}

/**
 * Positions from a get_portfolio result. The tool's payload shape is
 * not published and the desk renders it as a generic table today, so
 * extraction is liberal the way extractSpot/extractExpirations are:
 * walk the payload, score each array by how many rows parse as
 * positions, and take the best one (a payload that nests the same
 * array twice is read once, never double-counted). Rows without a
 * symbol or a nonzero quantity are not positions and are skipped.
 */
export function extractPositions(result: unknown): PortfolioPosition[] {
  let best: PortfolioPosition[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      const parsed = v.map(positionFromRow).filter((p): p is PortfolioPosition => p !== null);
      if (parsed.length > best.length) best = parsed;
      for (const el of v) walk(el, depth + 1);
      return;
    }
    for (const val of Object.values(v as Record<string, unknown>)) walk(val, depth + 1);
  };
  walk(result, 0);
  return best;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const EXPIRY_FIELDS = ["expiration", "expirationDate", "expiry", "date", "expiration_date"];

/**
 * Expiration dates from a get_option_expirations result: a string array,
 * an array of objects carrying a date field, or an object wrapping either.
 * Returned in the order the tool gave them (nearest first, as listed).
 */
export function extractExpirations(result: unknown): string[] {
  // The first YYYY-MM-DD anywhere in a value: expiry fields are usually
  // bare dates, but display strings ("Fri, Oct 23 2026 (2026-10-23)")
  // carry them embedded.
  const firstDate = (v: unknown): string => {
    if (typeof v !== "string") return "";
    const m = v.match(/\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : "";
  };
  const fromArray = (arr: unknown[]): string[] => {
    const out: string[] = [];
    for (const el of arr) {
      const direct = firstDate(el);
      if (direct) {
        out.push(direct);
      } else if (el && typeof el === "object") {
        const rec = el as Record<string, unknown>;
        let found = "";
        for (const f of EXPIRY_FIELDS) {
          found = firstDate(rec[f]);
          if (found) break;
        }
        // The date may ride in a field under any name (display strings,
        // nested contract ids) — take the first date-like string value.
        if (!found) {
          for (const v of Object.values(rec)) {
            found = firstDate(v);
            if (found) break;
          }
        }
        if (found) out.push(found);
      }
    }
    return out;
  };
  if (Array.isArray(result)) return fromArray(result);
  if (result && typeof result === "object") {
    const rec = result as Record<string, unknown>;
    let best: string[] = [];
    for (const k of Object.keys(rec)) {
      if (Array.isArray(rec[k])) {
        const dates = fromArray(rec[k] as unknown[]);
        if (dates.length > best.length) best = dates;
      } else if (typeof rec[k] === "string" && DATE_RE.test(rec[k] as string)) {
        return [(rec[k] as string).slice(0, 10)];
      }
    }
    return best;
  }
  return [];
}
