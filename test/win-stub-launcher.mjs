// A real Windows executable that stands in for System32 tools the CLI spawns
// by absolute path (powershell.exe, icacls.exe, whoami.exe). CreateProcess
// cannot run a shebang script named `*.exe`, and a copy of node.exe cannot be
// told which script to run, so the stub is a tiny launcher: it runs
// `node <itself>.mjs <args>` and pipes stdio through.
//
// Node aborts at startup when SystemRoot is missing or points at a directory
// without Windows in it (its entropy source cannot initialise), and these
// tests aim SystemRoot at a fake root on purpose. The launcher therefore
// starts node with the real SystemRoot from its `.node` sidecar and hands the
// value it was called with to the script as AIAND_TEST_SEEN_SYSTEMROOT, which
// the script's prelude (STUB_PRELUDE) puts back before the stub logs its env.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER_CS = `
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

public static class Launcher {
  static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\\t', '\\n', '\\v', '"' }) < 0) return arg;
    var sb = new StringBuilder("\\"");
    int slashes = 0;
    foreach (char c in arg) {
      if (c == '\\\\') { slashes++; continue; }
      if (c == '"') { sb.Append('\\\\', slashes * 2 + 1); sb.Append('"'); }
      else { sb.Append('\\\\', slashes); sb.Append(c); }
      slashes = 0;
    }
    sb.Append('\\\\', slashes * 2);
    return sb.Append('"').ToString();
  }

  public static int Main(string[] args) {
    string self = Process.GetCurrentProcess().MainModule.FileName;
    string[] sidecar = File.ReadAllLines(self + ".node");
    var psi = new ProcessStartInfo(sidecar[0]);
    var parts = new System.Collections.Generic.List<string> { Quote(self + ".mjs") };
    foreach (string a in args) parts.Add(Quote(a));
    psi.Arguments = string.Join(" ", parts.ToArray());
    psi.UseShellExecute = false;
    psi.RedirectStandardInput = psi.RedirectStandardOutput = psi.RedirectStandardError = true;
    string seen = Environment.GetEnvironmentVariable("SystemRoot");
    if (seen != null) psi.EnvironmentVariables["AIAND_TEST_SEEN_SYSTEMROOT"] = seen;
    psi.EnvironmentVariables["SystemRoot"] = sidecar[1];
    var child = Process.Start(psi);
    var stdin = new Thread(() => {
      try { using (var i = Console.OpenStandardInput()) i.CopyTo(child.StandardInput.BaseStream); } catch (IOException) { }
      try { child.StandardInput.Close(); } catch (IOException) { }
    });
    stdin.IsBackground = true;
    stdin.Start();
    var stdout = new Thread(() => { using (var o = Console.OpenStandardOutput()) child.StandardOutput.BaseStream.CopyTo(o); });
    var stderr = new Thread(() => { using (var e = Console.OpenStandardError()) child.StandardError.BaseStream.CopyTo(e); });
    stdout.Start();
    stderr.Start();
    child.WaitForExit();
    stdout.Join();
    stderr.Join();
    return child.ExitCode;
  }
}
`;

/** Put back the SystemRoot the stub was called with (see the header). */
export const STUB_PRELUDE = `if (process.env.AIAND_TEST_SEEN_SYSTEMROOT !== undefined) {
  process.env.SystemRoot = process.env.AIAND_TEST_SEEN_SYSTEMROOT;
  delete process.env.AIAND_TEST_SEEN_SYSTEMROOT;
}
`;

/** Compile the launcher once; returns its path, or null when csc is missing (every Windows has it). */
export function buildLauncher(dir = mkdtempSync(join(tmpdir(), "aiand-launcher-"))) {
  const csc = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  const source = join(dir, "launcher.cs");
  const exe = join(dir, "launcher.exe");
  writeFileSync(source, LAUNCHER_CS);
  const built = spawnSync(csc, ["/nologo", "/optimize", `/out:${exe}`, source], {
    encoding: "utf8",
  });
  return built.status === 0 ? exe : null;
}
