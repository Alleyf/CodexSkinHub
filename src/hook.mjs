// codexhost-hook.mjs - Dream Skin integration loaded by @codexhost/cli's bin.
// Exposes:
//   runTheme(argv)        -> `codexhost theme [name|list|status]` (sync, inherits stdio)
//   superviseDetached()   -> fire-and-forget injector supervisor for `codexhost launch`
// Never throws into the host: callers wrap it in try/catch, and these
// functions degrade to no-ops when the Dream Skin engine is absent.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Platform-aware data home (Windows: %LOCALAPPDATA%, macOS:
// ~/Library/Application Support, Linux: XDG data home), kept inline because
// this file is loaded by the patched codexhost bin and should stay
// self-contained.
function dataHome() {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

// CodexSkinHub runtime home (config/state/logs); Dream Skin engine stays in
// its own directory and is only referenced. Sibling sources are resolved
// relative to this file, preferring the installed runtime copy over the repo.
const HUB_ROOT = path.join(dataHome(), "CodexSkinHub");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.existsSync(path.join(HUB_ROOT, "src", "cli.mjs"))
  ? path.join(HUB_ROOT, "src")
  : HERE;
const DS_ROOT = process.env.CODEXSKIN_DS_ROOT ?? path.join(dataHome(), "CodexDreamSkin");
// Engine-bundled node when present, else whatever node is running us.
// process.execPath is ALWAYS a working node (self-contained copy of the
// platform.mjs logic - this file is loaded by the patched codexhost bin).
function engineNodeBin(dsRoot) {
  const bundled = process.platform === "win32"
    ? path.join(dsRoot, "engine", "runtime", "node", "node.exe")
    : path.join(dsRoot, "engine", "runtime", "node", "bin", "node");
  try { fs.accessSync(bundled, fs.constants.X_OK); return bundled; } catch { /* fall through */ }
  return process.execPath;
}
const NODE_EXE = engineNodeBin(DS_ROOT);
const CODEXSKIN = path.join(RUNTIME_SRC, "cli.mjs");
const SKIN_STATE = path.join(HUB_ROOT, "codexskin.json");
const SUPERVISE_LOG = path.join(HUB_ROOT, "codexskin-supervise.log");

// Own package version (same probe as cli.mjs). Used to replace supervisors
// that were started by an OLDER release - a pre-versioning daemon otherwise
// survives every upgrade and keeps answering bridge actions with stale code.
const PKG_VERSION = (() => {
  for (const p of [path.join(RUNTIME_SRC, "..", "package.json"), path.join(HUB_ROOT, "package.json")]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, "utf8")).version;
      if (v) return String(v);
    } catch { /* probe next */ }
  }
  return "unknown";
})();
const PATCHER = path.join(RUNTIME_SRC, "patch.mjs");

function enginePresent() {
  // NODE_EXE always resolves to an existing binary, so only the CLI entry
  // itself needs checking.
  return fs.existsSync(CODEXSKIN);
}

// Self-heal: if a partial drift happened (e.g. npm restored the package but
// someone/something re-patched only the bin), re-apply all patches detached.
// Idempotent and silent; never blocks or fails the host.
function healDetached() {
  if (!fs.existsSync(PATCHER)) return;
  try {
    const child = spawn(NODE_EXE, [PATCHER, "--quiet"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* best effort */
  }
}

export function runTheme(argv) {
  if (!enginePresent()) {
    console.error(`codexhost theme: Codex Dream Skin engine not found under ${DS_ROOT}.`);
    process.exitCode = 1;
    return;
  }
  const args = argv.length > 0 ? argv : [];
  const result = spawnSync(NODE_EXE, [CODEXSKIN, "theme", ...args], {
    stdio: "inherit",
    windowsHide: true,
  });
  process.exitCode = result.status ?? 1;
}

export function superviseDetached() {
  if (!enginePresent()) return;
  healDetached();
  let supervisePid = 0;
  let superviseVersion = "";
  try {
    const s = JSON.parse(fs.readFileSync(SKIN_STATE, "utf8").replace(/^\uFEFF/, ""));
    supervisePid = Number(s.supervisePid) || 0;
    superviseVersion = String(s.superviseVersion ?? "");
  } catch {
    supervisePid = 0;
  }
  if (supervisePid > 0) {
    let alive = false;
    try {
      process.kill(supervisePid, 0); // throws if not running
      alive = true;
    } catch {
      supervisePid = 0;
    }
    if (alive) {
      // A supervisor from an older release must not keep serving stale code -
      // the v0.3.9 self-heal only helps daemons STARTED with 0.3.9+ code, so
      // pre-versioning daemons would survive every upgrade forever.
      if (superviseVersion === PKG_VERSION) return; // current code; nothing to do
      try {
        fs.appendFileSync(
          SUPERVISE_LOG,
          `[${new Date().toISOString()}] [codexskin] hook: replacing stale supervisor (pid ${supervisePid}, ${superviseVersion ? `v${superviseVersion}` : "pre-versioning"}) with v${PKG_VERSION}\n`,
        );
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(supervisePid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
          try { process.kill(supervisePid); } catch { /* already gone */ }
        }
      } catch { /* best effort - fall through and try to spawn anyway */ }
      try {
        const s = JSON.parse(fs.readFileSync(SKIN_STATE, "utf8").replace(/^\uFEFF/, ""));
        if (Number(s.supervisePid) === supervisePid) {
          s.supervisePid = 0;
          fs.writeFileSync(SKIN_STATE, JSON.stringify(s, null, 2) + "\n", "utf8");
        }
      } catch { /* spawn claims ownership on its own */ }
    }
  }
  const out = fs.openSync(SUPERVISE_LOG, "a");
  const err = fs.openSync(SUPERVISE_LOG, "a");
  try {
    const child = spawn(
      NODE_EXE,
      [CODEXSKIN, "supervise"],
      { detached: true, stdio: ["ignore", out, err], windowsHide: true },
    );
    child.unref();
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}
