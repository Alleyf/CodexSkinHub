#!/usr/bin/env node
// install.mjs - one-shot installer for CodexSkinHub.
//
//   node install.mjs            # install / upgrade (idempotent)
//   node install.mjs --startup  # also register a per-user startup entry
//
// What it does:
//   1. copies src/ to the runtime home %LOCALAPPDATA%\CodexSkinHub\src
//      (the repo itself can be moved or deleted afterwards)
//   2. writes config.json pointing at the Dream Skin engine root
//   3. migrates codexskin.json (active theme state) from the legacy
//      CodexDreamSkin directory when present
//   4. applies the codexhost bin/renderer patches (idempotent, anchor-safe)
//   5. writes the PATH shim %USERPROFILE%\.local\bin\codexskin.cmd
//
// Nothing inside the Dream Skin installation or the @codexhost/cli source
// repository is modified beyond the runtime patches, which `uninstall.mjs`
// or `node src/patch.mjs --revert` strips cleanly.

import {
  cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const repo = dirname(fileURLToPath(import.meta.url));
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const userProfile = process.env.USERPROFILE ?? homedir();
const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

const HUB_ROOT = join(localAppData, "CodexSkinHub");
const DS_ROOT_DEFAULT = join(localAppData, "CodexDreamSkin");
const SHIM = join(userProfile, ".local", "bin", "codexskin.cmd");
const STARTUP = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodexSkinHub.cmd");
const withStartup = process.argv.includes("--startup");
const quiet = process.argv.includes("--quiet");

function log(msg) {
  if (!quiet) console.log(`[codexskin-install] ${msg}`);
}

function die(msg) {
  console.error(`[codexskin-install] ERROR: ${msg}`);
  process.exit(1);
}

// 0. Preconditions.
const dsRoot = existsSync(join(DS_ROOT_DEFAULT, "engine", "scripts", "injector.mjs"))
  ? DS_ROOT_DEFAULT
  : null;
if (!dsRoot) {
  // Degrade gracefully: a public `npm i -g` must not hard-fail just because
  // the optional Codex Dream Skin engine is not installed yet. The runtime
  // copy and the codexskin CLI still work; doctor/status will show MISSes
  // until the engine (and codexhost) are present.
  log(`WARNING: Dream Skin engine not found at ${DS_ROOT_DEFAULT}`);
  log("WARNING: run `codexskin setup` to bootstrap it (auto-download + guided install), or install Codex Dream Skin manually first");
}
const nodeExe = dsRoot ? join(dsRoot, "engine", "runtime", "node", "node.exe") : "";
const node = existsSync(nodeExe) ? nodeExe : "node";

// 1. Runtime copy.
mkdirSync(join(HUB_ROOT, "src"), { recursive: true });
rmSync(join(HUB_ROOT, "src"), { recursive: true, force: true });
cpSync(join(repo, "src"), join(HUB_ROOT, "src"), { recursive: true });
for (const f of ["install.mjs", "uninstall.mjs"]) {
  if (existsSync(join(repo, f))) cpSync(join(repo, f), join(HUB_ROOT, f));
}
log(`runtime copied to ${HUB_ROOT}\\src`);

// 2. Config.
writeFileSync(
  join(HUB_ROOT, "config.json"),
  JSON.stringify({ dreamSkinRoot: dsRoot, installedFrom: repo }, null, 2) + "\n",
);

// 3. Legacy state migration (active theme id + supervisor state).
const legacyState = dsRoot ? join(dsRoot, "codexskin.json") : null;
const hubState = join(HUB_ROOT, "codexskin.json");
if (legacyState && existsSync(legacyState) && !existsSync(hubState)) {
  writeFileSync(hubState, readFileSync(legacyState));
  log("migrated codexskin.json from the legacy CodexDreamSkin directory");
}

// 4. Patches (idempotent; refuses on anchor drift).
//    Skipped entirely when the Dream Skin engine is absent - the hook would
//    have nothing to drive; `codexskin install` re-applies everything later.
if (dsRoot) {
  const r = spawnSync(node, [join(HUB_ROOT, "src", "patch.mjs"), ...process.argv.slice(2).filter((a) => a !== "--startup")], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (r.status !== 0) {
    die("patching failed - see output above; codexhost may have changed upstream");
  }
} else {
  log("patching skipped (Dream Skin engine missing) - run `codexskin setup` to bootstrap and apply it");
}

// 5. PATH shim (pure ASCII - see GBK/PowerShell 5.1 encoding lessons).
mkdirSync(dirname(SHIM), { recursive: true });
writeFileSync(
  SHIM,
  [
    "@echo off",
    "setlocal",
    'set "CSHUB_NODE=%LOCALAPPDATA%\\CodexDreamSkin\\engine\\runtime\\node\\node.exe"',
    'if not exist "%CSHUB_NODE%" set "CSHUB_NODE=node"',
    '"%CSHUB_NODE%" "%LOCALAPPDATA%\\CodexSkinHub\\src\\cli.mjs" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n"),
);
log(`shim written to ${SHIM} (needs %USERPROFILE%\\.local\\bin on PATH)`);

// 6. Optional startup entry.
if (withStartup) {
  writeFileSync(
    STARTUP,
    [
      "@echo off",
      'set "CSHUB_NODE=%LOCALAPPDATA%\\CodexDreamSkin\\engine\\runtime\\node\\node.exe"',
      'if not exist "%CSHUB_NODE%" set "CSHUB_NODE=node"',
      'start "CodexSkinHub" /min "%CSHUB_NODE%" "%LOCALAPPDATA%\\CodexSkinHub\\src\\cli.mjs" supervise',
      "",
    ].join("\r\n"),
  );
  log(`startup entry written to ${STARTUP}`);
} else {
  log("startup entry skipped (pass --startup to register one)");
}

log("done. Commands: codexskin theme | import | gallery | dir | status | doctor");
