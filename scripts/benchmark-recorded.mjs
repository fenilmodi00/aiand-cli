#!/usr/bin/env node
/**
 * The deterministic benchmark regression gate (#67, D4).
 *
 *   npm run benchmark:recorded                # replay offline, diff vs goldens
 *   npm run benchmark:recorded -- --update-goldens   # regenerate (local only)
 *
 * Replays the scenario pack through the deterministic transport in
 * dist/benchmark/recorded.js, writes the report + a human-readable summary
 * into the gitignored runs/ directory, and diffs the four CacheLane metrics
 * (baseline_cost_units, effective_cost_units, cache_hit_ratio,
 * savings_ratio) against the committed golden
 * test/golden/benchmark-recorded.json. Any drift in pricing math,
 * reconciler arithmetic, or aggregation fails with a readable diff.
 *
 * Requires a build first: `npm run build` (npm test does it via pretest).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = resolve(ROOT, "test/golden/benchmark-recorded.json");
const RUNS_DIR = resolve(ROOT, "runs/benchmark");
const UPDATE = process.argv.includes("--update-goldens");

const { runRecordedBenchmark, diffReports } = await import(
  new URL("../dist/benchmark/recorded.js", import.meta.url)
);

const report = await runRecordedBenchmark();
const reportJson = `${JSON.stringify(report, null, 2)}\n`;

mkdirSync(RUNS_DIR, { recursive: true });
writeFileSync(resolve(RUNS_DIR, "benchmark-recorded.json"), reportJson);
writeFileSync(resolve(RUNS_DIR, "summary.txt"), summarize(report));
console.log(`report written to ${relative(RUNS_DIR)}/ (gitignored)`);

if (UPDATE) {
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
    console.error(
      "--update-goldens is local-only: goldens are regenerated on a maintainer's machine and committed.",
    );
    process.exit(1);
  }
  mkdirSync(dirname(GOLDEN), { recursive: true });
  writeFileSync(GOLDEN, reportJson);
  console.log(`goldens updated: ${relative(GOLDEN)}`);
  process.exit(0);
}

let golden;
try {
  golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
} catch {
  console.error(`no readable golden file at ${relative(GOLDEN)}.`);
  console.error("Regenerate it locally with: npm run benchmark:recorded -- --update-goldens");
  process.exit(1);
}

const diffs = diffReports(report, golden);
if (diffs.length === 0) {
  console.log(
    `benchmark recorded gate: ${report.rows.length} scenario x layout rows match the goldens.`,
  );
  process.exit(0);
}

console.error(`benchmark recorded gate FAILED — ${diffs.length} diff(s) against the goldens:`);
for (const diff of diffs.slice(0, 20)) {
  console.error(`  - ${diff}`);
}
if (diffs.length > 20)
  console.error(`  ... and ${diffs.length - 20} more (full report in ${relative(RUNS_DIR)})`);
console.error("");
console.error("If the change is intentional (pinned prices, scenarios, or cost math),");
console.error("regenerate the goldens locally and commit them:");
console.error("  npm run benchmark:recorded -- --update-goldens");
process.exit(1);

function relative(path) {
  return path.slice(ROOT.length + 1).replaceAll("\\", "/");
}

function summarize(report) {
  const lines = [
    `recorded benchmark replay — ${report.model}`,
    `pinned prices (USD per 1M): input ${report.prices.inputPer1m}, cached ${report.prices.cachedPer1m}, output ${report.prices.outputPer1m}`,
    "",
    "scenario x layout                  requests  baseline  effective  hit%    saved%",
  ];
  for (const row of report.rows) {
    lines.push(
      [
        `${row.scenario} x ${row.layout}`.padEnd(34),
        String(row.requests).padStart(8),
        row.baseline_cost_units.toFixed(4).padStart(9),
        row.effective_cost_units.toFixed(4).padStart(10),
        `${(row.cache_hit_ratio * 100).toFixed(1)}`.padStart(6),
        `${(row.savings_ratio * 100).toFixed(1)}`.padStart(8),
      ].join("  "),
    );
  }
  return `${lines.join("\n")}\n`;
}
