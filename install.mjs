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
  accessSync, chmodSync, constants, cpSync, existsSync, mkdirSync,
  readFileSync, writeFileSync, rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const repo = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";

// Per-OS data home: Windows %LOCALAPPDATA%, macOS ~/Library/Application
// Support, Linux XDG data home.
function dataHome() {
  if (IS_WIN) return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

function dsRootCandidates() {
  if (IS_WIN) return [join(dataHome(), "CodexDreamSkin")];
  if (process.platform === "darwin") {
    return [
      join(dataHome(), "CodexDreamSkin"),
      join(homedir(), "Applications", "CodexDreamSkin"),
      join("/Applications", "CodexDreamSkin"),
    ];
  }
  return [join(dataHome(), "CodexDreamSkin")];
}

function engineNodeBin(dsRoot) {
  const candidates = IS_WIN
    ? [join(dsRoot, "engine", "runtime", "node", "node.exe")]
    : [join(dsRoot, "engine", "runtime", "node", "bin", "node"), join(dsRoot, "engine", "runtime", "node", "node")];
  for (const p of candidates) {
    try { accessSync(p, constants.X_OK); return p; } catch { /* probe next */ }
  }
  return "node";
}

const HUB_ROOT = join(dataHome(), "CodexSkinHub");
const SHIM = join(homedir(), ".local", "bin", IS_WIN ? "codexskin.cmd" : "codexskin");
const STARTUP = IS_WIN
  ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodexSkinHub.cmd")
  : join(homedir(), "Library", "LaunchAgents", "cc.dreamskin.codexskin.plist");
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
const dsRoot = dsRootCandidates().find((p) => existsSync(join(p, "engine", "scripts", "injector.mjs"))) ?? null;
if (!dsRoot) {
  // Degrade gracefully: a public `npm i -g` must not hard-fail just because
  // the optional Codex Dream Skin engine is not installed yet. The runtime
  // copy and the codexskin CLI still work; doctor/status will show MISSes
  // until the engine (and codexhost) are present.
  log(`WARNING: Dream Skin engine not found (probed: ${dsRootCandidates().join(", ")})`);
  log("WARNING: run `codexskin setup` to bootstrap it (auto-download + guided install), or install Codex Dream Skin manually first");
}
const node = dsRoot ? engineNodeBin(dsRoot) : "node";

// 1. Runtime copy.
//    Guard: when invoked from the runtime home itself (codexskin setup ->
//    %LOCALAPPDATA%\CodexSkinHub\install.mjs) the source and the destination
//    are the same directory - deleting src first would leave nothing to copy.
//    The runtime is already in place there, so skip the copy entirely.
const isRuntimeSelfInstall = resolve(repo) === resolve(HUB_ROOT);
if (isRuntimeSelfInstall) {
  log("running from the runtime home - src already in place, skipping copy");
} else {
  if (!existsSync(join(repo, "src"))) {
    die(`source tree missing at ${join(repo, "src")} - reinstall the package`);
  }
  mkdirSync(join(HUB_ROOT, "src"), { recursive: true });
  rmSync(join(HUB_ROOT, "src"), { recursive: true, force: true });
  cpSync(join(repo, "src"), join(HUB_ROOT, "src"), { recursive: true });
  for (const f of ["install.mjs", "uninstall.mjs"]) {
    if (existsSync(join(repo, f))) cpSync(join(repo, f), join(HUB_ROOT, f));
  }
  log(`runtime copied to ${join(HUB_ROOT, "src")}`);
}

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
//    Windows: codexskin.cmd batch wrapper. macOS/Linux: POSIX sh script with
//    the executable bit set (~/.local/bin is typically already on PATH).
mkdirSync(dirname(SHIM), { recursive: true });
if (IS_WIN) {
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
} else {
  const engineNode = dsRoot ? engineNodeBin(dsRoot) : "node";
  writeFileSync(
    SHIM,
    [
      "#!/bin/sh",
      `CSHUB_NODE="${engineNode}"`,
      '[ -x "$CSHUB_NODE" ] || CSHUB_NODE="$(command -v node)"',
      `exec "$CSHUB_NODE" "${join(HUB_ROOT, "src", "cli.mjs")}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(SHIM, 0o755);
}
log(`shim written to ${SHIM}${IS_WIN ? " (needs %USERPROFILE%\\.local\\bin on PATH)" : " (needs ~/.local/bin on PATH)"}`);

// 6. Optional startup entry: Startup-folder .cmd on Windows, a launchd
//    LaunchAgent on macOS, a systemd user unit on Linux.
if (withStartup) {
  mkdirSync(dirname(STARTUP), { recursive: true });
  if (IS_WIN) {
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
  } else if (process.platform === "darwin") {
    const nodeAbs = dsRoot ? engineNodeBin(dsRoot) : "/usr/local/bin/node";
    writeFileSync(
      STARTUP,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cc.dreamskin.codexskin</string>
  <key>ProgramArguments</key><array>
    <string>${nodeAbs}</string><string>${join(HUB_ROOT, "src", "cli.mjs")}</string><string>supervise</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
`,
    );
    try {
      spawnSync("launchctl", ["load", STARTUP], { stdio: "ignore" });
    } catch { /* best effort - loads at next login anyway */ }
  } else {
    const nodeAbs = dsRoot ? engineNodeBin(dsRoot) : "/usr/bin/node";
    writeFileSync(
      STARTUP,
      `[Unit]
Description=CodexSkinHub supervisor

[Service]
ExecStart=${nodeAbs} ${join(HUB_ROOT, "src", "cli.mjs")} supervise
Restart=on-failure

[Install]
WantedBy=default.target
`,
    );
    log("enable it with: systemctl --user enable --now codexskin.service");
  }
  log(`startup entry written to ${STARTUP}`);
} else {
  log("startup entry skipped (pass --startup to register one)");
}

log("done. Commands: codexskin theme | import | gallery | dir | status | doctor");
