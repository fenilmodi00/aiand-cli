import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Unit coverage for renderWrappedText's format/cost branches — direct
 * WrappedStory fixtures, no CLI, no store. Every branch: empty story,
 * markdown vs text, no-cost masking, not-billed top session, topPair vs
 * topModel fallback, busiest-day cost cell, savings line, mixed currencies.
 */

const baseStory = {
  rangeLabel: "2026-09-25 to 2026-10-25",
  timezone: "UTC",
  requests: 12,
  sessions: 3,
  tokens: { input: 12_000, output: 340, cached: 8_000 },
  cost: { usd: 0.42 },
  currencyHandling: "single",
  currency: "usd",
  topSession: {
    id: "abc123",
    harness: "claude",
    turns: 4,
    cost: 0.21,
    currency: "usd",
  },
  topPair: { harness: "claude", model: "zai-org/glm-5.3", requests: 9 },
  busiestDay: { day: "2026-10-20", requests: 6, cost: { usd: 0.3 } },
  topModel: "zai-org/glm-5.3",
  savings: 1.2,
  costIfUncached: 3.4,
  provenance: { cost: "gateway-billed", savings: "estimated", sessions: "heuristic (time-gap)" },
};

const render = async (story, options) => {
  const { renderWrappedText } = await import("../dist/obs/wrapped.js");
  return renderWrappedText(story, options);
};

test("wrapped text: empty story renders the no-activity note", async () => {
  const empty = { ...baseStory, requests: 0, sessions: 0 };
  const text = await render(empty, { format: "text", showCost: true });
  assert.ok(text.includes("No activity"), `empty note: ${text}`);
  assert.ok(text.includes("2026-09-25 to 2026-10-25"), "range label kept");
});

test("wrapped text: singular vs plural counts", async () => {
  const one = await render(
    { ...baseStory, requests: 1, sessions: 1, topPair: { ...baseStory.topPair, requests: 1 } },
    { format: "text", showCost: false },
  );
  assert.match(one, /1 request across/, "singular request");
  assert.match(one, /1 time-gap session/, "singular session");
});

test("wrapped markdown: headings and bullets switch shape", async () => {
  const md = await render(baseStory, { format: "markdown", showCost: true });
  assert.ok(md.includes("## "), "markdown heading");
  assert.ok(/^- /m.test(md), "markdown bullet");
  assert.ok(!/\x1b\[/.test(md), "no ANSI in markdown");

  const text = await render(baseStory, { format: "text", showCost: true });
  assert.ok(!/^## /m.test(text), "text has no md headings");
  assert.ok(!/^- /m.test(text), "text has no md bullets");
});

test("wrapped no-cost: money figures masked, structure intact", async () => {
  const masked = await render(baseStory, { format: "text", showCost: false });
  assert.ok(!masked.includes("Spend:"), "spend line dropped");
  assert.ok(!masked.includes("Biggest session"), "session cost dropped");
  assert.ok(!masked.includes("saved an estimated"), "savings line dropped");
  assert.ok(masked.includes("Favorite pairing"), "pairing line kept");
  assert.ok(masked.includes("Busiest day"), "busiest day kept (no cost cell)");
});

test("wrapped: a not-billed top session says so; null falls to topModel", async () => {
  const notBilled = await render(
    { ...baseStory, topSession: { ...baseStory.topSession, cost: null, currency: null } },
    { format: "text", showCost: true },
  );
  assert.ok(notBilled.includes("not billed"), "not-billed label");

  const noPair = await render(
    { ...baseStory, topPair: null },
    {
      format: "text",
      showCost: true,
    },
  );
  assert.ok(noPair.includes("Top model"), "top-model fallback line");
  assert.ok(!noPair.includes("Favorite pairing"), "pairing line absent");
});

test("wrapped: mixed currencies render per-currency, never summed", async () => {
  const mixed = await render(
    { ...baseStory, cost: { usd: 0.3, eur: 0.1 }, currencyHandling: "mixed", currency: null },
    { format: "text", showCost: true },
  );
  assert.ok(mixed.includes("+"), "two currency cells joined");
  assert.ok(mixed.includes("Mixed currencies"), "mixed-currency warning");
});

test("wrapped: single-turn top session and zero-cost busiest day", async () => {
  const single = await render(
    { ...baseStory, topSession: { ...baseStory.topSession, turns: 1 } },
    { format: "text", showCost: true },
  );
  assert.match(single, /1 turn\b/, "singular turn");

  const noDayCost = await render(
    { ...baseStory, busiestDay: { ...baseStory.busiestDay, cost: {} } },
    { format: "text", showCost: true },
  );
  assert.ok(!noDayCost.match(/Busiest day.*\(\$/), "no empty cost cell");
});

test("wrapped: zero cached share and no busiest day", async () => {
  const zeroCache = await render(
    { ...baseStory, tokens: { input: 0, output: 10, cached: 0 } },
    { format: "text", showCost: true },
  );
  assert.match(zeroCache, /0% of prompt tokens served from cache/);

  const noDay = await render(
    { ...baseStory, busiestDay: null },
    {
      format: "text",
      showCost: true,
    },
  );
  assert.ok(!noDay.includes("Busiest day"), "busiest-day line absent");
});

test("wrapped: null savings drops the savings line; provenance footer always renders", async () => {
  const noSavings = await render(
    { ...baseStory, savings: null, costIfUncached: null },
    {
      format: "text",
      showCost: true,
    },
  );
  assert.ok(!noSavings.includes("saved an estimated"), "savings line dropped");
  assert.ok(noSavings.includes("cost: gateway-billed"), "provenance footer");
  assert.ok(noSavings.includes("sessions: heuristic (time-gap)"), "session provenance");
});
