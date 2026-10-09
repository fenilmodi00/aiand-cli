import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const ROOTS = [
  "src",
  "test",
  "scripts",
  ".github",
  "dist",
  "install.sh",
  "install.ps1",
  "README.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "CONTEXT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "THANKS.md",
  ".env.example",
  "package.json",
];

const SKIP_DIRS = new Set(["node_modules", ".git", "coverage"]);
const SCAN_EXT = new Set([
  ".ts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".sh",
  ".ps1",
]);

const PUBLIC_HOSTS = new Set(["api.aiand.com", "console.aiand.com", "docs.aiand.com"]);

const RULES = [
  {
    name: "undocumented hostname",
    // Full hostname, not one label: `internal.api.aiand.com` must match whole
    // (and fail the allowlist) instead of matching just `api.aiand.com`.
    pattern: /[a-z0-9.-]*\.aiand\.com\b/gi,

    allow: (match) => PUBLIC_HOSTS.has(match.toLowerCase()),
    hint: `Name only ${[...PUBLIC_HOSTS].join(", ")}.`,
  },
  {
    name: "internal service name",

    pattern: /\b(?:worker|svc|service)-[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/gi,
    hint: "Describe what the API does, not the service that implements it.",
  },
  {
    name: "private workspace package",

    pattern: /@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*/gi,
    allow: (match) =>
      match.startsWith("@aiand/") ||
      match.startsWith("@types/") ||
      match.startsWith("@biomejs/") ||
      match.startsWith("@ai-sdk/") ||
      match.startsWith("@opencode-ai/") ||
      match.startsWith("@anthropic-ai/") ||
      match.startsWith("@mariozechner/") ||
      match.startsWith("@oh-my-pi/") ||
      match.startsWith("@openai/") ||
      match.startsWith("@earendil-works/") ||
      match.startsWith("@deepseek-ai/") ||
      match.startsWith("@github/"),
    hint: "Reference only published packages.",
  },
  {
    name: "private repository tooling",
    pattern: /\b(?:pnpm|turbo|wrangler|nx|lerna)\b/gi,
    hint: "This project builds with npm and tsc; do not reference other repositories' tooling.",
  },
  {
    name: "issue tracker reference",
    pattern: /\b[A-Z]{2,6}-\d{1,6}\b/g,

    allow: (match) =>
      /^(?:RFC|UTF|SHA|ISO|ANSI|OSC|AES|RSA|HTTP|IPv|EC|P|CVE|SLSA|ES)-?\d/i.test(match) ||
      // Catalog ids such as GLM-5.3 contain this shape. The dot ends the match.
      match === "GLM-5",
    hint: "Internal ticket identifiers must not be published.",
  },
  {
    name: "absolute home path",
    pattern: /\/(?:Users|home)\/[a-z0-9._-]+\//gi,
    hint: "Use a relative path, ~, or an environment variable.",
  },
  {
    name: "credential-shaped string",

    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/gi,
    allow: (match) => {
      const m = match.toLowerCase();
      return (
        m === "sk-your-key-here" ||
        m.startsWith("sk-test-") ||
        m.startsWith("sk-e2e-") ||
        m.startsWith("sk-smoke-") ||
        m.startsWith("sk-key-") ||
        m.startsWith("sk-browser") ||
        m.startsWith("sk-this-key-")
      );
    },
    hint: "Never commit an API key, even a revoked one.",
  },
  {
    name: "private-context aside",

    pattern: /\b(?:internal[- ]only|do not ship|for the team|our monorepo|the monorepo)\b/gi,
    hint: "Rewrite for a reader outside the organization, or delete it.",
  },
];

function* walk(entry, root = ROOT) {
  const absolute = join(root, entry);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return;
  }
  if (stats.isFile()) {
    yield entry;
    return;
  }
  for (const child of readdirSync(absolute)) {
    if (SKIP_DIRS.has(child)) continue;
    yield* walk(join(entry, child), root);
  }
}

// A source module past this is doing more than one job; split it along its
// seams (as src/auth/ is: identity, login, logout) instead of raising this.
const MAX_SOURCE_LINES = 650;

const findings = [];
let scanned = 0;

for (const target of ROOTS) {
  for (const file of walk(target)) {
    if (file.endsWith(".map")) continue;
    const dot = file.lastIndexOf(".");
    if (dot !== -1 && !SCAN_EXT.has(file.slice(dot)) && file !== ".env.example") continue;

    if (file.endsWith("check-public.mjs")) continue;

    scanned += 1;
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    // A trailing newline ends the last line; it does not start another.
    const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    if (file.startsWith("src/") && file.endsWith(".ts") && lineCount > MAX_SOURCE_LINES) {
      findings.push({
        file,
        line: lineCount,
        rule: "oversized module",
        match: `${lineCount} lines`,
        hint: `Keep src modules under ${MAX_SOURCE_LINES} lines; split by responsibility.`,
        context: "",
      });
    }
    lines.forEach((line, index) => {
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        for (const match of line.matchAll(rule.pattern)) {
          if (rule.allow?.(match[0])) continue;
          findings.push({
            file,
            line: index + 1,
            rule: rule.name,
            match: match[0],
            hint: rule.hint,
            context: line.trim().slice(0, 100),
          });
          break;
        }
      }
    });
  }
}

if (scanned === 0) {
  // Zero files scanned means a broken ROOT, never a clean tree.
  console.error("check-public failed: scanned 0 files — the scan root is wrong, not clean.");
  process.exit(1);
}

if (findings.length > 0) {
  console.error(
    `check-public failed: ${findings.length} item${findings.length === 1 ? "" : "s"} should not be published.\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]  "${f.match}"`);
    console.error(`    ${f.context}`);
    console.error(`    ${f.hint}\n`);
  }
  process.exit(1);
}

// Self-tests: guard the guard. This file skips itself in the scan above,
// so these fixtures never trip the rules.
{
  const hostRule = RULES.find((rule) => rule.name === "undocumented hostname");
  const verdicts = (line) => {
    hostRule.pattern.lastIndex = 0;
    return [...line.matchAll(hostRule.pattern)];
  };
  for (const host of PUBLIC_HOSTS) {
    const matches = verdicts(`https://${host}/v1`);
    assert.ok(
      matches.length > 0 && matches.every((m) => hostRule.allow(m[0])),
      `must allow exactly ${host}`,
    );
  }
  for (const line of [
    "https://internal.api.aiand.com/v1",
    "https://staging.console.aiand.com/",
    "https://secret-gateway.docs.aiand.com/x",
  ]) {
    const matches = verdicts(line);
    assert.ok(
      matches.some((m) => !hostRule.allow(m[0])),
      `must flag ${line}`,
    );
  }
  // walk() must resolve entries under a directory whose name contains a
  // space (ROOT must not stay percent-encoded).
  const probeDir = mkdtempSync(join(tmpdir(), "check public space-"));
  try {
    writeFileSync(join(probeDir, "probe.txt"), "probe\n");
    assert.deepEqual([...walk("probe.txt", probeDir)], ["probe.txt"]);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

console.log(`check-public ok: ${RULES.length} rules, nothing to redact`);
