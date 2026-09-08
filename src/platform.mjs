// platform.mjs - the single place that knows about operating systems.
//
// Everything else (cli / hook / patch / install) asks this module how to:
//   - locate per-user data dirs (hub runtime home, Dream Skin engine root)
//   - find the engine's bundled Node binary
//   - discover the Codex Desktop processes and their CDP listening ports
//   - kill a process tree, open files/URLs, pick a ZIP via a native dialog
//   - write the PATH shim and the autostart entry
//
// Support matrix (see README "Compatibility"):
//   win32  - fully supported, byte-level verified against codexhost 0.6.0
//   darwin - experimental: upstream engine ships a .dmg, but this port has
//            not been exercised on real macOS hardware yet
//   linux  - NOT supported: upstream Dream Skin has no Linux engine build

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";
export const PLATFORM_TAG = IS_WIN ? "win32" : IS_MAC ? "darwin" : "linux";

// ---------------------------------------------------------------------------
// Data directories
// ---------------------------------------------------------------------------

export function dataHome() {
  if (IS_WIN) return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  if (IS_MAC) return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

// The Dream Skin engine may live in different places per OS / install style.
// Ordered candidates; the first existing one wins (config.json override and
// the CODEXSKIN_DS_ROOT env var are checked by the callers before this list).
export function dsRootCandidates() {
  if (IS_WIN) return [path.join(dataHome(), "CodexDreamSkin")];
  if (IS_MAC) {
    return [
      path.join(dataHome(), "CodexDreamSkin"),
      path.join(os.homedir(), "Applications", "CodexDreamSkin"),
      path.join("/Applications", "CodexDreamSkin"),
      "/usr/local/share/CodexDreamSkin",
    ];
  }
  return [path.join(dataHome(), "CodexDreamSkin")];
}

export function hubRoot() {
  return path.join(dataHome(), "CodexSkinHub");
}

// The injector only needs a plain node. Prefer the engine-bundled runtime;
// otherwise use whatever node is running us - process.execPath is ALWAYS a
// working node (when the shim launched us with the bundled node, execPath IS
// the bundled node; when npm launched us, it is the user's own node). No
// PATH probing, no candidate lists - anything more is uncertainty.
export function engineNodeBin(dsRoot) {
  const bundled = IS_WIN
    ? path.join(dsRoot, "engine", "runtime", "node", "node.exe")
    : path.join(dsRoot, "engine", "runtime", "node", "bin", "node");
  try { fs.accessSync(bundled, fs.constants.X_OK); return bundled; } catch { /* fall through */ }
  return process.execPath;
}

// ---------------------------------------------------------------------------
// Codex Desktop process discovery
// ---------------------------------------------------------------------------

function codexDesktopPatterns() {
  if (IS_WIN) return ["chatgpt\\.exe"]; // MSIX app: process name is ChatGPT.exe
  if (IS_MAC) return ["Codex\\.app", "ChatGPT\\.app"]; // match the bundle path, not "codexhost"
  return ["Codex\\.app", "ChatGPT\\.app"]; // linux is blocked upstream anyway
}

export async function findDesktopPids(execFileText) {
  if (IS_WIN) {
    const out = await execFileText("tasklist", ["/FI", "IMAGENAME eq ChatGPT.exe", "/FO", "CSV", "/NH"]);
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"ChatGPT\.exe","(\d+)"/);
      if (m) pids.push(Number(m[1]));
    }
    return pids;
  }
  // unix: pgrep -f against the app bundle path; excludes codexhost/codexskin
  // node processes because those never contain "Codex.app".
  const pattern = codexDesktopPatterns().join("|");
  const r = spawnSync("pgrep", ["-if", pattern], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  return String(r.stdout).split(/\r?\n/).map(Number).filter(Boolean);
}

export async function listeningPortsOfPids(pids, execFileText) {
  if (pids.length === 0) return [];
  if (IS_WIN) {
    const out = await execFileText("netstat", ["-ano", "-p", "TCP"]);
    const ports = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const [, local, , state, pid] = parts; // TCP  127.0.0.1:2977  0.0.0.0:0  LISTENING  1234
      if (!/LISTENING/i.test(state ?? "")) continue;
      if (!/^(127\.0\.0\.1|\[::1\]):\d+$/i.test(local ?? "")) continue;
      if (pids.includes(Number(pid))) ports.add(Number(local.split(":").pop()));
    }
    return [...ports].sort((a, b) => a - b);
  }
  const r = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  const ports = new Set();
  for (const line of String(r.stdout).split(/\r?\n/)) {
    // COMMAND  PID USER  FD  TYPE  DEVICE SIZE/OFF NODE NAME
    // Codex    421 user   24u  IPv4  0x...      0t0  TCP 127.0.0.1:2977 (LISTEN)
    const m = line.match(/^(?:\S+\s+){8}(\S+):(\d+)\s+\(LISTEN\)/);
    if (m && (/^127\./.test(m[1]) || m[1] === "[::1]" || m[1] === "*")) ports.add(Number(m[2]));
  }
  return [...ports].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

export async function killTree(pid, execFileText) {
  if (IS_WIN) {
    await execFileText("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  // The pgid kill works for children we spawned detached (own process group);
  // pkill -P mops up descendants of anything else. Force-kill as the last
  // step, mirroring taskkill /F semantics.
  try { process.kill(-pid, "SIGTERM"); } catch { /* not a pgid leader */ }
  spawnSync("pkill", ["-TERM", "-P", String(pid)], { stdio: "ignore" });
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 300));
  try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  spawnSync("pkill", ["-KILL", "-P", String(pid)], { stdio: "ignore" });
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

// ---------------------------------------------------------------------------
// Opening files / URLs
// ---------------------------------------------------------------------------

export function openPath(p) {
  if (IS_WIN) {
    // NOTE: never set windowsHide on a GUI spawn - node maps it to
    // STARTUPINFO.wShowWindow = SW_HIDE and Explorer honors it, opening the
    // folder window INVISIBLE (no error, no window). That is exactly what
    // made "Open folder" / export-logs auto-open silently do nothing.
    const child = spawnSync("explorer.exe", [p], { detached: true, stdio: "ignore" });
    return child.status ?? 0;
  }
  const opener = IS_MAC ? "open" : "xdg-open";
  const r = spawnSync(opener, [p], { detached: true, stdio: "ignore" });
  return r.status ?? 0;
}

// Open a folder and REPORT failure instead of swallowing it. Same GUI-spawn
// rule as openPath: no windowsHide on Windows.
export function openFolder(p) {
  const fail = (error) => ({ opened: false, error: error || "unknown error" });
  if (IS_WIN) {
    const ex = spawnSync("explorer.exe", [p], { detached: true, stdio: "ignore" });
    if (!ex.error) return { opened: true, error: "" };
    const st = spawnSync("cmd.exe", ["/d", "/s", "/c", "start", "", p], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
    return st.error ? fail(`${ex.error.code ?? ex.error.message} / ${st.error.code ?? st.error.message}`) : { opened: true, error: "" };
  }
  if (IS_MAC) {
    const r = spawnSync("open", [p], { detached: true, stdio: "ignore" });
    return r.error ? fail(String(r.error.code ?? r.error.message)) : { opened: true, error: "" };
  }
  const r = spawnSync("xdg-open", [p], { detached: true, stdio: "ignore" });
  return r.error ? fail(String(r.error.code ?? r.error.message)) : { opened: true, error: "" };
}

export function openUrl(url) {
  if (IS_WIN) {
    spawnSync("cmd.exe", ["/d", "/s", "/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
    return;
  }
  const opener = IS_MAC ? "open" : "xdg-open";
  spawnSync(opener, [url], { detached: true, stdio: "ignore" });
}

// Open the folder containing `p` and select the file itself. Unlike openPath,
// this REPORTS failure instead of swallowing it: spawnSync never throws, it
// puts the failure in the result - and a supervisor spawned from inside the
// MSIX Codex app may be unable to pop an Explorer window (Explorer is a
// single-instance COM hand-off, unlike e.g. a PowerShell dialog). Callers use
// the returned flags to tell the user "opened" vs "open it manually at <path>".
export function revealPath(p) {
  const fail = (error) => ({ opened: false, error: error || "unknown error" });
  if (IS_WIN) {
    // Preferred: /select,<file> opens the folder with the file highlighted.
    // No windowsHide - see the note in openPath (SW_HIDE hides the window).
    const sel = spawnSync("explorer.exe", [`/select,${p}`], { detached: true, stdio: "ignore" });
    if (!sel.error) return { opened: true, error: "" };
    // Fallback: ShellExecute the folder (start) - different launch chain.
    const dir = path.dirname(p);
    const st = spawnSync("cmd.exe", ["/d", "/s", "/c", "start", "", dir], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
    if (!st.error) return { opened: true, error: "" };
    return fail(`${sel.error.code ?? sel.error.message} / ${st.error.code ?? st.error.message}`);
  }
  if (IS_MAC) {
    const r = spawnSync("open", ["-R", p], { detached: true, stdio: "ignore" });
    return r.error ? fail(`${r.error.code ?? r.error.message}`) : { opened: true, error: "" };
  }
  const r = spawnSync("xdg-open", [path.dirname(p)], { detached: true, stdio: "ignore" });
  return r.error ? fail(`${r.error.code ?? r.error.message}`) : { opened: true, error: "" };
}

// ---------------------------------------------------------------------------
// Native ZIP picker (returns "" when no dialog tool is available)
// ---------------------------------------------------------------------------

export async function pickZipViaDialog(execFileText) {
  if (IS_WIN) {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "$d = New-Object System.Windows.Forms.OpenFileDialog",
      "$d.Filter = 'Theme archive (*.zip)|*.zip|All files (*.*)|*.*'",
      "$d.Title = 'Import Dream Skin theme ZIP'",
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }",
    ].join("; ");
    const out = await execFileText("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-Command", script]);
    return out.trim();
  }
  if (IS_MAC) {
    const script = 'POSIX path of (choose file of type {"zip"} with prompt "Import Dream Skin theme ZIP")';
    try {
      const out = execFileSync("osascript", ["-e", script], { encoding: "utf8" });
      return String(out ?? "").trim();
    } catch { return ""; }
  }
  // linux: zenity if present, otherwise let the caller fall back to argv path
  try {
    const out = execFileSync("zenity", ["--file-selection", "--title=Import Dream Skin theme ZIP", "--file-filter=Theme archive | *.zip", "--file-filter=All files | *"], { encoding: "utf8" });
    return String(out ?? "").trim();
  } catch { return ""; }
}

// ---------------------------------------------------------------------------
// PATH shim + autostart
// ---------------------------------------------------------------------------

export function shimPath() {
  const base = path.join(os.homedir(), ".local", "bin");
  return IS_WIN ? path.join(base, "codexskin.cmd") : path.join(base, "codexskin");
}

// `hubRoot` and `dsRoot` are the resolved runtime locations; the shim must be
// pure ASCII (Windows GBK code-page lesson). The Windows content uses
// %LOCALAPPDATA% env vars (not baked-in absolute paths) so it survives profile
// relocation. Engine-bundled node first, plain `node` from PATH as fallback -
// the CLI itself handles any further resolution via process.execPath.
export function shimContent(hubRoot, dsRoot) {
  const cli = path.join(hubRoot, "src", "cli.mjs");
  if (IS_WIN) {
    return [
      "@echo off",
      "setlocal",
      'set "CSHUB_NODE=%LOCALAPPDATA%\\CodexDreamSkin\\engine\\runtime\\node\\node.exe"',
      'if not exist "%CSHUB_NODE%" set "CSHUB_NODE=node"',
      '"%CSHUB_NODE%" "%LOCALAPPDATA%\\CodexSkinHub\\src\\cli.mjs" %*',
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `CSHUB_NODE="${path.join(dsRoot, "engine", "runtime", "node", "bin", "node")}"`,
    '[ -x "$CSHUB_NODE" ] || CSHUB_NODE="$(command -v node || echo node)"',
    `exec "$CSHUB_NODE" "${cli}" "$@"`,
    "",
  ].join("\n");
}

export function startupEntryPath() {
  if (IS_WIN) {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodexSkinHub.cmd");
  }
  if (IS_MAC) return path.join(os.homedir(), "Library", "LaunchAgents", "cc.dreamskin.codexskin.plist");
  return path.join(os.homedir(), ".config", "systemd", "user", "codexskin.service");
}

export function startupEntryContent(hubRoot, dsRoot) {
  if (IS_WIN) {
    // Startup .cmd must never pop an error window on logon: bundled node
    // first, `node` from PATH as fallback, silent exit when neither exists.
    return [
      "@echo off",
      'set "CSHUB_NODE=%LOCALAPPDATA%\\CodexDreamSkin\\engine\\runtime\\node\\node.exe"',
      'if not exist "%CSHUB_NODE%" set "CSHUB_NODE=node"',
      'if "%CSHUB_NODE%"=="node" where node >nul 2>nul || exit /b 0',
      'start "CodexSkinHub" /min "%CSHUB_NODE%" "%LOCALAPPDATA%\\CodexSkinHub\\src\\cli.mjs" supervise',
      "",
    ].join("\r\n");
  }
  const cli = path.join(hubRoot, "src", "cli.mjs");
  const node = engineNodeBin(dsRoot);
  const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
  if (IS_MAC) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cc.dreamskin.codexskin</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string><string>${xml(cli)}</string><string>supervise</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
`;
  }
  return `[Unit]
Description=CodexSkinHub supervisor

[Service]
ExecStart=${node} ${cli} supervise
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

// Best-effort registration of the autostart entry on unix; Windows callers
// just write the file into the Startup folder (no extra step needed).
export function registerStartupUnix() {
  if (IS_WIN) return;
  const p = startupEntryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try { execFileSync("launchctl", ["unload", p], { stdio: "ignore" }); } catch { /* not loaded */ }
}

export function isWindows() { return IS_WIN; }
