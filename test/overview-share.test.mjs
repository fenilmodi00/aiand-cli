import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { cliEnv, runCli, withEnv, withTestEnv } from "./helpers.mjs";

// `aiand overview --share`: the SVG renderer, the OS-native rasterizer/
// clipboard command specs, and the writeAndShare state machine. CLI tests
// run against a directly-seeded temp config dir; the PNG/clipboard paths are
// always fake deps or disabled (setup.mjs sets AIAND_NO_CLIPBOARD=1), so no
// test ever touches the real clipboard.

const box = withTestEnv("aiand-overview-share-", () => {
  process.env.NO_COLOR = "1";
  process.env.CI = "1";
  delete process.env.AIAND_NO_SYNC;
});

function freshDir(name) {
  const dir = join(box.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// -- fixtures -----------------------------------------------------------------

const PINNED_NOW = new Date("2026-10-22T12:00:00.000Z");

/** Two days, two harnesses (masked keys), one model — enough for every section. */
const ROWS = [
  {
    id: "r1",
    model: "zai-org/glm-5.3",
    api_key: "sk-abcd...1234",
    created_at: "2026-10-20T10:00:00.000Z",
    latency_ms: 500,
    ttft_ms: 100,
    input_tokens: 1000,
    output_tokens: 300,
    cached_tokens: 400,
    cost_value: 0.0042,
    currency: "usd",
  },
  {
    id: "r2",
    model: "zai-org/glm-5.3",
    api_key: "sk-effg...5678",
    created_at: "2026-10-21T09:00:00.000Z",
    latency_ms: 700,
    ttft_ms: 200,
    input_tokens: 900,
    output_tokens: 200,
    cached_tokens: 0,
    cost_value: 0.0031,
    currency: "usd",
  },
];

/** Map the masked keys to harnesses and cache a model catalog (for savings). */
function seedKeysAndCatalog(dir) {
  writeFileSync(
    join(dir, "agent-keys.json"),
    JSON.stringify({
      version: 1,
      keys: [
        { agent: "claude", masked: "sk-abcd...1234", fingerprint: "f1", at: 1 },
        { agent: "opencode", masked: "sk-effg...5678", fingerprint: "f2", at: 2 },
      ],
    }),
  );
  writeFileSync(
    join(dir, "model-catalog.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      baseUrl: "https://api.aiand.com",
      models: [
        {
          id: "zai-org/glm-5.3",
          currency: "usd",
          input_per_1m: "1.0",
          output_per_1m: "2.0",
          cached_input_per_1m: "0.1",
          capabilities: [],
        },
      ],
    }),
  );
}

async function buildData(dir, sections) {
  const { buildReportData } = await import("../dist/report/data.js");
  seedKeysAndCatalog(dir);
  return withEnv({ AIAND_CONFIG_DIR: dir }, async () =>
    buildReportData(
      {
        timezone: "UTC",
        sinceMs: Date.parse("2026-10-19T00:00:00Z"),
        untilMs: Date.parse("2026-10-22T00:00:00Z") - 1,
        harnesses: [],
        models: [],
        sections,
        top: 5,
        sync: { skipped: true },
        now: PINNED_NOW,
      },
      () => ROWS.map((r) => ({ ...r })),
    ),
  );
}

// -- SVG rendering ------------------------------------------------------------

describe("renderOverviewSvg", () => {
  test("mac-terminal chrome, logo, no ANSI, logical width >= 980", async () => {
    const { renderOverviewSvg } = await import("../dist/report/overview-svg.js");
    const { AIAND_LOGO_LIGHT } = await import("../dist/report/aiand-logo.js");
    const data = await buildData(freshDir("svg-all"), [
      "totals",
      "by-harness",
      "models",
      "busiest",
      "daily",
      "budget",
    ]);
    const { svg, width, height } = renderOverviewSvg(data, {
      showCost: true,
      sections: ["totals", "by-harness", "models", "busiest", "daily", "budget"],
    });
    assert.ok(svg.startsWith("<svg"), "starts with <svg");
    assert.ok(svg.includes(`viewBox="0 0 ${width} ${height}"`));
    assert.ok(width >= 980, `logical width ${width} must be >= 980`);
    for (const color of ["#ff5f57", "#febc2e", "#28c840"]) {
      assert.ok(svg.includes(color), `traffic light ${color}`);
    }
    assert.ok(svg.includes("ai&amp; overview"), "centered title-bar title");
    assert.ok(svg.includes(AIAND_LOGO_LIGHT), "inline ai& logo");
    assert.ok(!svg.includes("\x1b["), "no ANSI escapes reach the SVG");
  });

  test("sections are honored: totals only omits Top models", async () => {
    const { renderOverviewSvg } = await import("../dist/report/overview-svg.js");
    const data = await buildData(freshDir("svg-totals"), ["totals"]);
    const { svg } = renderOverviewSvg(data, { showCost: true, sections: ["totals"] });
    assert.ok(!svg.includes("Top models"), "Top models must be omitted");
  });

  test("showCost:false omits $", async () => {
    const { renderOverviewSvg } = await import("../dist/report/overview-svg.js");
    const data = await buildData(freshDir("svg-nocost"), [
      "totals",
      "by-harness",
      "models",
      "busiest",
      "daily",
      "budget",
    ]);
    const { svg } = renderOverviewSvg(data, {
      showCost: false,
      sections: ["totals", "by-harness", "models", "busiest", "daily", "budget"],
    });
    assert.ok(!svg.includes("$"), "no monetary figures with --no-cost");
  });
});

// -- rasterizer / clipboard command specs --------------------------------------

describe("rasterizerCommands / clipboardCommands", () => {
  const svgPath = "/tmp/x/overview.svg";
  const pngPath = "/tmp/x/overview.png";

  test("win32 rasterizer: Edge/Chrome headless at 2x device scale", async () => {
    const { rasterizerCommands } = await import("../dist/report/share-image.js");
    const specs = rasterizerCommands(svgPath, pngPath, 980, 400, "win32", {});
    assert.ok(specs.length > 0);
    assert.ok(
      specs.some((s) => s.command.endsWith("msedge.exe")),
      `msedge.exe among ${specs.map((s) => s.command).join(", ")}`,
    );
    for (const spec of specs) {
      assert.ok(spec.args.includes("--force-device-scale-factor=2"));
      assert.ok(spec.args.some((a) => a.startsWith("--screenshot=")));
    }
  });

  test("darwin rasterizer: Chrome/Edge/Chromium then qlmanage fallback", async () => {
    const { rasterizerCommands } = await import("../dist/report/share-image.js");
    const specs = rasterizerCommands(svgPath, pngPath, 980, 400, "darwin", {});
    assert.ok(specs.some((s) => s.command.includes("qlmanage")));
    const ql = specs.find((s) => s.command.includes("qlmanage"));
    assert.equal(ql.command, "/usr/bin/qlmanage");
    // 2x size: -s 2W
    assert.ok(ql.args.includes(String(980 * 2)));
  });

  test("linux rasterizer: rsvg-convert first at 2x", async () => {
    const { rasterizerCommands } = await import("../dist/report/share-image.js");
    const specs = rasterizerCommands(svgPath, pngPath, 980, 400, "linux", {});
    assert.equal(specs[0].command, "rsvg-convert");
    assert.deepEqual(specs[0].args.slice(0, 4), ["-w", String(980 * 2), "-h", String(400 * 2)]);
  });

  test("win32 clipboard: PowerShell STA with encoded script", async () => {
    const { clipboardCommands } = await import("../dist/report/share-image.js");
    const [spec] = clipboardCommands(pngPath, "win32", {});
    assert.equal(spec.command, "powershell");
    assert.ok(spec.args.includes("-STA"));
    assert.ok(spec.args.includes("-EncodedCommand"));
  });

  test("darwin clipboard: osascript PNGf", async () => {
    const { clipboardCommands } = await import("../dist/report/share-image.js");
    const [spec] = clipboardCommands(pngPath, "darwin", {});
    assert.equal(spec.command, "osascript");
    assert.ok(spec.args.some((a) => a.includes("«class PNGf»")));
  });

  test("linux clipboard: wl-copy on Wayland, xclip otherwise", async () => {
    const { clipboardCommands } = await import("../dist/report/share-image.js");
    const wayland = clipboardCommands(pngPath, "linux", { WAYLAND_DISPLAY: "wayland-0" });
    assert.equal(wayland[0].command, "wl-copy");
    assert.equal(wayland[0].useStdin, true);
    assert.equal(wayland[1].command, "xclip");
    const x11 = clipboardCommands(pngPath, "linux", {});
    assert.equal(x11[0].command, "xclip");
    assert.deepEqual(x11[0].args, ["-selection", "clipboard", "-t", "image/png", "-i", pngPath]);
  });
});

// -- writeAndShare state machine (fake deps, never the real clipboard) ---------

describe("writeAndShare", () => {
  const W = 980;
  const H = 300;
  // A minimal valid 1x1 PNG.
  const PNG_BYTES = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c626001000000ffff030000060005" +
      "57bfabd40000000049454e44ae426082",
    "hex",
  );

  test(".svg out path: saves SVG, no clipboard, note says SVG", async () => {
    const { writeAndShare } = await import("../dist/report/share-image.js");
    const outPath = join(box.dir, "share.svg");
    const result = await writeAndShare("<svg></svg>", W, H, outPath, {
      deps: {
        rasterize: () => ({ ok: false, reason: "unused" }),
        copy: () => ({ ok: false, reason: "unused" }),
      },
    });
    assert.equal(result.path, outPath);
    assert.equal(result.copied, false);
    assert.match(result.note, /SVG/i);
    assert.ok(readFileSync(outPath, "utf8").includes("<svg"));
  });

  test("fake rasterize + copy: PNG saved and copied:true", async () => {
    const { writeAndShare } = await import("../dist/report/share-image.js");
    const outPath = join(box.dir, "share.png");
    const result = await writeAndShare("<svg></svg>", W, H, outPath, {
      deps: {
        rasterize: (_svg, png) => {
          writeFileSync(png, PNG_BYTES);
          return { ok: true };
        },
        copy: () => ({ ok: true }),
      },
    });
    assert.equal(result.copied, true);
    assert.equal(result.path, outPath);
    assert.ok(existsSync(outPath));
    assert.deepEqual(readFileSync(outPath), PNG_BYTES);
  });

  test("rasterizer failure falls back to a saved SVG", async () => {
    const { writeAndShare } = await import("../dist/report/share-image.js");
    const outPath = join(box.dir, "share.png");
    const result = await writeAndShare("<svg></svg>", W, H, outPath, {
      deps: {
        rasterize: () => ({ ok: false, reason: "no rasterizer" }),
        copy: () => ({ ok: true }),
      },
    });
    assert.equal(result.copied, false);
    assert.ok(result.path.endsWith(".svg"), `fallback path ${result.path}`);
    assert.match(result.note, /SVG/i);
    assert.ok(readFileSync(result.path, "utf8").includes("<svg"));
  });

  test("noClipboard:true skips copy", async () => {
    const { writeAndShare } = await import("../dist/report/share-image.js");
    const outPath = join(box.dir, "share-noclip.png");
    let copies = 0;
    const result = await writeAndShare("<svg></svg>", W, H, outPath, {
      noClipboard: true,
      deps: {
        rasterize: (_svg, png) => {
          writeFileSync(png, PNG_BYTES);
          return { ok: true };
        },
        copy: () => {
          copies += 1;
          return { ok: true };
        },
      },
    });
    assert.equal(result.copied, false);
    assert.equal(copies, 0, "copy dep must never run");
    assert.ok(existsSync(outPath));
  });
});

// -- CLI ------------------------------------------------------------------------

const cliEnvFor = (dir) =>
  cliEnv({
    AIAND_CONFIG_DIR: dir,
    AIAND_NO_SYNC: "1",
    NO_COLOR: "1",
    CI: "1",
  });

async function seedStore(dir, rows) {
  await withEnv({ AIAND_CONFIG_DIR: dir }, async () => {
    const store = await import("../dist/store/index.js");
    const opened = store.openStore(store.storePath());
    assert.ok(opened.ok, `store open failed: ${opened.reason ?? ""}`);
    const insert = opened.db.prepare(
      "INSERT OR IGNORE INTO requests (id, model, api_key, status_code, ttft_ms, latency_ms, " +
        "input_tokens, output_tokens, cached_tokens, cost, cost_value, currency, created_at, synced_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(
        r.id,
        r.model,
        r.api_key,
        200,
        r.ttft_ms,
        r.latency_ms,
        r.input_tokens,
        r.output_tokens,
        r.cached_tokens,
        r.cost_value.toFixed(4),
        r.cost_value,
        r.currency,
        r.created_at,
        new Date().toISOString(),
      );
    }
    opened.db.close();
  });
}

describe("overview --share (CLI)", () => {
  test("--share --out share.svg --no-sync saves the SVG and prints the path", async () => {
    const dir = freshDir("cli-share");
    await seedStore(dir, ROWS);
    seedKeysAndCatalog(dir);
    const outPath = join(box.dir, "cli-share.svg");
    const result = await runCli(["overview", "--share", "--out", outPath, "--no-sync"], {
      env: cliEnvFor(dir),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(readFileSync(outPath, "utf8").includes("<svg"), "output file holds the SVG");
    assert.ok(result.stdout.includes("Saved"), result.stdout);
  });

  test("--share --json exits nonzero", async () => {
    const dir = freshDir("cli-share-json");
    const result = await runCli(["overview", "--share", "--json"], { env: cliEnvFor(dir) });
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("cannot be combined"), result.stderr);
  });

  test("--out without --share exits nonzero", async () => {
    const dir = freshDir("cli-out-alone");
    const result = await runCli(["overview", "--out", join(tmpdir(), "x.png")], {
      env: cliEnvFor(dir),
    });
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes("requires --share"), result.stderr);
  });
});
