
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const ROOTS = ["src", "scripts", ".github", "dist", "install.sh", "README.md", "CHANGELOG.md", "package.json"];

const SKIP_DIRS = new Set(["node_modules", ".git", "coverage"]);
const SCAN_EXT = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml"]);

const PUBLIC_HOSTS = new Set(["api.aiand.com", "console.aiand.com", "docs.aiand.com"]);

const RULES = [
  {
    name: "undocumented hostname",
    pattern: /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.aiand\.com\b/gi,

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
      match.startsWith("@ai-sdk/") ||
      match.startsWith("@opencode-ai/") ||
      match.startsWith("@anthropic-ai/") ||
      match.startsWith("@openai/") ||
      match.startsWith("@earendil-works/") ||
      match.startsWith("@deepseek-ai/"),
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
      /^(?:RFC|UTF|SHA|ISO|ANSI|OSC|AES|RSA|HTTP|IPv|EC|P|CVE|SLSA|ES)-?\d/i.test(match),
    hint: "Internal ticket identifiers must not be published.",
  },
  {
    name: "absolute home path",
    pattern: /\/(?:Users|home)\/[a-z0-9._-]+\//gi,
    hint: "Use a relative path, ~, or an environment variable.",
  },
  {
    name: "credential-shaped string",

    pattern: /\bsk-[0-9a-f]{24,}\b/gi,
    hint: "Never commit an API key, even a revoked one.",
  },
  {
    name: "private-context aside",

    pattern: /\b(?:internal[- ]only|do not ship|for the team|our monorepo|the monorepo)\b/gi,
    hint: "Rewrite for a reader outside the organization, or delete it.",
  },
];

function* walk(entry) {
  const absolute = join(ROOT, entry);
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
    yield* walk(join(entry, child));
  }
}

const findings = [];

for (const target of ROOTS) {
  for (const file of walk(target)) {
    if (file.endsWith(".map")) continue;
    const dot = file.lastIndexOf(".");
    if (dot !== -1 && !SCAN_EXT.has(file.slice(dot))) continue;

    if (file.endsWith("check-public.mjs")) continue;

    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
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

if (findings.length > 0) {
  console.error(
    `check-public failed: ${findings.length} item${findings.length === 1 ? "" : "s"} should not be published.\n`
  );
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]  "${f.match}"`);
    console.error(`    ${f.context}`);
    console.error(`    ${f.hint}\n`);
  }
  process.exit(1);
}

console.log(`check-public ok: ${RULES.length} rules, nothing to redact`);
