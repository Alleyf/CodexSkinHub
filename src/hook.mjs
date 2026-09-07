// codexhost-hook.mjs - Dream Skin integration loaded by @codexhost/cli's bin.
// Exposes:
//   runTheme(argv)        -> `codexhost theme [name|list|status]` (sync, inherits stdio)
//   superviseDetached()   -> fire-and-forget injector supervisor for `codexhost launch`
// Never throws into the host: callers wrap it in try/catch, and these
// functions degrade to no-ops when the Dream Skin engine is absent.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CodexSkinHub runtime home (config/state/logs); Dream Skin engine stays in
// its own directory and is only referenced. Sibling sources are resolved
// relative to this file, preferring the installed runtime copy over the repo.
const HUB_ROOT = path.join(process.env.LOCALAPPDATA ?? "", "CodexSkinHub");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.existsSync(path.join(HUB_ROOT, "src", "cli.mjs"))
  ? path.join(HUB_ROOT, "src")
  : HERE;
const DS_ROOT = path.join(process.env.LOCALAPPDATA ?? "", "CodexDreamSkin");
const NODE_EXE = path.join(DS_ROOT, "engine", "runtime", "node", "node.exe");
const CODEXSKIN = path.join(RUNTIME_SRC, "cli.mjs");
const SKIN_STATE = path.join(HUB_ROOT, "codexskin.json");
const SUPERVISE_LOG = path.join(HUB_ROOT, "codexskin-supervise.log");
const PATCHER = path.join(RUNTIME_SRC, "patch.mjs");

function enginePresent() {
  return fs.existsSync(NODE_EXE) && fs.existsSync(CODEXSKIN);
}

// Self-heal: if a partial drift happened (e.g. npm restored the package but
// someone/something re-patched only the bin), re-apply all patches detached.
// Idempotent and silent; never blocks or fails the host.
function healDetached() {
  if (!fs.existsSync(PATCHER)) return;
  try {
    const node = fs.existsSync(NODE_EXE) ? NODE_EXE : process.execPath;
    const child = spawn(node, [PATCHER, "--quiet"], {
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
    console.error("codexhost theme: Codex Dream Skin engine not found in %LOCALAPPDATA%\\CodexDreamSkin.");
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
  try {
    const raw = fs.readFileSync(SKIN_STATE, "utf8");
    supervisePid = Number(JSON.parse(raw.replace(/^\uFEFF/, "")).supervisePid) || 0;
  } catch {
    supervisePid = 0;
  }
  if (supervisePid > 0) {
    try {
      process.kill(supervisePid, 0); // throws if not running
      return; // supervisor already alive; nothing to do
    } catch {
      supervisePid = 0;
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
