import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMoneyFixed } from "../dist/pricing/currency.js";

// #99: an accumulation artifact like −1.11e-16 must never render as
// "$-0.0000"; the formatting boundary clamps to plain zero.
test("formatMoneyFixed clamps negative zero and epsilon to plain zero", () => {
  assert.equal(formatMoneyFixed(-1.11e-16, 4), "0.0000");
  assert.equal(formatMoneyFixed(-1.11e-16, 6), "0.000000");
  assert.equal(formatMoneyFixed(-0, 2), "0.00");
  assert.equal(formatMoneyFixed(-0.00004, 4), "0.0000");
  assert.equal(formatMoneyFixed(-0.004, 2), "0.00");
  // Real negatives still render with their sign.
  assert.equal(formatMoneyFixed(-0.01, 2), "-0.01");
  assert.equal(formatMoneyFixed(-1.5, 4), "-1.5000");
  // Positives untouched.
  assert.equal(formatMoneyFixed(0.0042, 4), "0.0042");
});
