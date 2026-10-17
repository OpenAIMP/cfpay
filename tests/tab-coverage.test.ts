import { describe, expect, it } from "vitest";
import {
  genericTabProbeExpression,
  genericTabVerdict,
  knownTabExpectations,
  mergeDiscoveredTabs,
} from "../src/tab-coverage";

describe("tab coverage (issue #102 DOM discovery)", () => {
  it("keeps the four specific expectations", () => {
    const known = knownTabExpectations();
    expect(known.map((t) => t.tab)).toEqual(["emails", "payments", "webhooks", "public"]);
    expect(known.find((t) => t.tab === "public")?.rowSelector).toBe("details");
    expect(known.every((t) => !t.generic)).toBe(true);
  });

  it("merges discovered tabs after the known ones, in DOM order", () => {
    const dom = ["overview", "emails", "payments", "send", "pay", "chat", "slack", "webhooks", "public", "qa"];
    const merged = mergeDiscoveredTabs(knownTabExpectations(), dom);
    expect(merged).toHaveLength(10);
    expect(merged.slice(0, 4).map((t) => t.tab)).toEqual(["emails", "payments", "webhooks", "public"]);
    expect(merged.slice(4).map((t) => t.tab)).toEqual(["overview", "send", "pay", "chat", "slack", "qa"]);
    expect(merged.find((t) => t.tab === "qa")?.name).toBe("QA");
    expect(merged.slice(4).every((t) => t.generic)).toBe(true);
  });

  it("ignores blanks and duplicates in the discovered list", () => {
    const merged = mergeDiscoveredTabs(knownTabExpectations(), ["", "  ", "emails", "chat", "chat"]);
    expect(merged.map((t) => t.tab)).toEqual(["emails", "payments", "webhooks", "public", "chat"]);
  });
});

describe("genericTabVerdict", () => {
  const tab = { name: "Chat", tab: "chat", containerId: "", emptyText: "", generic: true };

  it("fails a missing or hidden panel", () => {
    expect(genericTabVerdict(tab, null).passed).toBe(false);
    expect(genericTabVerdict(tab, { found: false }).detail).toContain("not in the DOM");
    expect(genericTabVerdict(tab, { found: true, visible: false }).passed).toBe(false);
  });

  it("passes on text, rows, or controls (a form tab passes on controls)", () => {
    expect(genericTabVerdict(tab, { found: true, visible: true, textLength: 120 }).passed).toBe(true);
    expect(genericTabVerdict(tab, { found: true, visible: true, textLength: 0, controls: 6 }).passed).toBe(true);
    expect(genericTabVerdict(tab, { found: true, visible: true, textLength: 0, rows: 0, controls: 0 }).passed).toBe(false);
  });

  it("probes the panel by the tab key", () => {
    expect(genericTabProbeExpression("slack")).toContain('getElementById("slack")');
  });
});
