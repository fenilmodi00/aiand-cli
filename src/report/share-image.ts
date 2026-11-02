import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_FILE_MODE, writeFileAtomic } from "../fsutil.js";

/** One external command to try, in order, until one succeeds. */
export type CommandSpec = {
  command: string;
  args: string[];
  /** Rename this produced file to the target instead of using stdout/exit status. */
  output?: string;
  /** Feed the PNG on stdin instead of pointing at the file. */
  useStdin?: boolean;
};

type AttemptResult = { ok: true } | { ok: false; reason: string };
type RasterResult = AttemptResult;
type ClipboardResult = AttemptResult;

export type ShareDeps = {
  rasterize: (svgPath: string, pngPath: string, width: number, height: number) => RasterResult;
  copy: (pngPath: string) => ClipboardResult;
};

export type ShareResult = { path: string; copied: boolean; note: string };

const SPAWN_TIMEOUT_MS = 30_000;

/** Browser-based rasterizer: scales via device-scale-factor at 2x logical size. */
function browserArgs(pngPath: string, width: number, height: number, svgPath: string): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    `--window-size=${width},${height}`,
    `--screenshot=${pngPath}`,
    pathToFileURL(svgPath).href,
  ];
}

function windowsBrowserCandidates(
  pngPath: string,
  width: number,
  height: number,
  svgPath: string,
  env: NodeJS.ProcessEnv,
): CommandSpec[] {
  const specs: CommandSpec[] = [];
  const programDirs = [env.ProgramFiles, env["ProgramFiles(x86)"]];
  for (const dir of programDirs) {
    if (!dir) continue;
    specs.push(
      {
        command: join(dir, "Microsoft", "Edge", "Application", "msedge.exe"),
        args: browserArgs(pngPath, width, height, svgPath),
      },
      {
        command: join(dir, "Google", "Chrome", "Application", "chrome.exe"),
        args: browserArgs(pngPath, width, height, svgPath),
      },
    );
  }
  for (const exe of ["msedge.exe", "chrome.exe"]) {
    specs.push({ command: exe, args: browserArgs(pngPath, width, height, svgPath) });
  }
  return specs;
}

function macRasterCandidates(
  pngPath: string,
  width: number,
  height: number,
  svgPath: string,
): CommandSpec[] {
  const qlSize = String(Math.max(width, height) * 2);
  return [
    {
      command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      args: browserArgs(pngPath, width, height, svgPath),
    },
    {
      command: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      args: browserArgs(pngPath, width, height, svgPath),
    },
    {
      command: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      args: browserArgs(pngPath, width, height, svgPath),
    },
    // qlmanage writes <input>.png next to the input and cannot pick the name.
    {
      command: "/usr/bin/qlmanage",
      args: ["-t", "-s", qlSize, "-o", dirname(pngPath), svgPath],
      output: `${svgPath}.png`,
    },
  ];
}

function linuxRasterCandidates(
  pngPath: string,
  width: number,
  height: number,
  svgPath: string,
): CommandSpec[] {
  const twoW = String(width * 2);
  const twoH = String(height * 2);
  const inkscape: CommandSpec = {
    command: "inkscape",
    args: ["--export-type=png", `--export-filename=${pngPath}`, `-w`, twoW, `-h`, twoH, svgPath],
  };
  const browsers = ["chromium", "google-chrome", "chromium-browser"].map(
    (exe): CommandSpec => ({ command: exe, args: browserArgs(pngPath, width, height, svgPath) }),
  );
  return [
    { command: "rsvg-convert", args: ["-w", twoW, "-h", twoH, "-o", pngPath, svgPath] },
    inkscape,
    ...browsers,
  ];
}

export function rasterizerCommands(
  svgPath: string,
  pngPath: string,
  width: number,
  height: number,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CommandSpec[] {
  if (platform === "win32") return windowsBrowserCandidates(pngPath, width, height, svgPath, env);
  if (platform === "darwin") return macRasterCandidates(pngPath, width, height, svgPath);
  return linuxRasterCandidates(pngPath, width, height, svgPath);
}

function windowsClipboardSpec(pngPath: string, env: NodeJS.ProcessEnv): CommandSpec {
  // Bitmap so the clipboard holds real image data, not a file reference.
  const quotedPath = pngPath.replaceAll("'", "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    `$bytes = [System.IO.File]::ReadAllBytes('${quotedPath}')`,
    "$ms = New-Object System.IO.MemoryStream(,$bytes)",
    "$image = [System.Drawing.Image]::FromStream($ms)",
    "[System.Windows.Forms.Clipboard]::SetImage($image)",
    "if ([System.Windows.Forms.Clipboard]::ContainsImage()) { Write-Output 'True' } else { exit 1 }",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const powershell = env.SystemRoot
    ? join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell";
  return {
    command: powershell,
    args: ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
  };
}

export function clipboardCommands(
  pngPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CommandSpec[] {
  if (platform === "win32") return [windowsClipboardSpec(pngPath, env)];
  if (platform === "darwin") {
    return [
      {
        command: "osascript",
        args: ["-e", `set the clipboard to (read (POSIX file "${pngPath}") as «class PNGf»)`],
      },
    ];
  }
  const xclip: CommandSpec = {
    command: "xclip",
    args: ["-selection", "clipboard", "-t", "image/png", "-i", pngPath],
  };
  if (env.WAYLAND_DISPLAY) {
    return [{ command: "wl-copy", args: ["--type", "image/png"], useStdin: true }, xclip];
  }
  return [xclip];
}

function isPng(path: string): boolean {
  try {
    const bytes = readFileSync(path);
    return bytes.length > 8 && bytes.subarray(1, 4).toString("ascii") === "PNG";
  } catch {
    return false;
  }
}

function defaultRasterize(
  svgPath: string,
  pngPath: string,
  width: number,
  height: number,
): RasterResult {
  let reason = "no rasterizer produced a PNG";
  for (const spec of rasterizerCommands(svgPath, pngPath, width, height)) {
    if (isAbsolute(spec.command) && !existsSync(spec.command)) continue;
    const result = spawnSync(spec.command, spec.args, {
      timeout: SPAWN_TIMEOUT_MS,
      stdio: "ignore",
      windowsHide: true,
    });
    if (spec.output && existsSync(spec.output)) {
      renameSync(spec.output, pngPath);
    }
    if (isPng(pngPath)) return { ok: true };
    reason = `${spec.command} ${result.error ? result.error.message : `exited ${result.status ?? result.signal}`}`;
  }
  return { ok: false, reason };
}

function defaultCopy(pngPath: string): ClipboardResult {
  for (const spec of clipboardCommands(pngPath)) {
    if (isAbsolute(spec.command) && !existsSync(spec.command)) continue;
    const result = spawnSync(spec.command, spec.args, {
      timeout: SPAWN_TIMEOUT_MS,
      windowsHide: true,
      input: spec.useStdin ? readFileSync(pngPath) : undefined,
    });
    if (process.platform === "win32") {
      if ((result.stdout?.toString() ?? "").includes("True")) return { ok: true };
      continue;
    }
    if (result.status === 0) return { ok: true };
  }
  return { ok: false, reason: "no clipboard tool accepted the PNG" };
}

const defaultDeps: ShareDeps = { rasterize: defaultRasterize, copy: defaultCopy };

export async function writeAndShare(
  svg: string,
  width: number,
  height: number,
  outPath: string,
  options: { noClipboard?: boolean; deps?: Partial<ShareDeps> } = {},
): Promise<ShareResult> {
  const deps = { ...defaultDeps, ...options.deps };
  const { noClipboard = false } = options;
  const ext = extname(outPath).toLowerCase();
  if (ext === ".svg") {
    await writeFileAtomic(outPath, svg, { mode: DEFAULT_FILE_MODE });
    return {
      path: outPath,
      copied: false,
      note: "Saved SVG — clipboard copy skipped (paste needs PNG).",
    };
  }

  const pngPath = ext === ".png" ? outPath : `${outPath}.png`;
  const tempDir = mkdtempSync(join(tmpdir(), "aiand-share-"));
  const tempSvg = join(tempDir, "overview.svg");
  try {
    await writeFileAtomic(tempSvg, svg, { mode: DEFAULT_FILE_MODE });
    const raster = deps.rasterize(tempSvg, join(tempDir, "overview.png"), width, height);
    if (!raster.ok) {
      const fallback = pngPath.replace(/\.png$/i, ".svg");
      await writeFileAtomic(fallback, svg, { mode: DEFAULT_FILE_MODE });
      return {
        path: fallback,
        copied: false,
        note: `No rasterizer available (${raster.reason}) — saved SVG instead.`,
      };
    }
    // Read before the temp dir goes away.
    const pngBytes = readFileSync(join(tempDir, "overview.png"));
    await writeFileAtomic(pngPath, pngBytes, { mode: DEFAULT_FILE_MODE });
    if (noClipboard) {
      return { path: pngPath, copied: false, note: "Saved PNG (clipboard disabled)." };
    }
    const clip = deps.copy(pngPath);
    if (!clip.ok) {
      return {
        path: pngPath,
        copied: false,
        note: `Saved PNG, but clipboard copy failed: ${clip.reason}`,
      };
    }
    return { path: pngPath, copied: true, note: "PNG copied to clipboard." };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
