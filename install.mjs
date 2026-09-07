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
// Single source of truth for platform logic (shim/startup content, engine
// node probing). install.mjs used to duplicate all of it and drifted.
import {
  engineNodeBin, shimContent, shimPath, startupEntryContent, startupEntryPath,
} from "./src/platform.mjs";

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

// Never trust a single hardcoded node path (2026-09-08 multi-machine lesson):
// probe the known engine-bundled layouts, then `node` on PATH, then give up
// with the bare "node" name (the caller decides how to degrade).
const HUB_ROOT = join(dataHome(), "CodexSkinHub");
const SHIM = shimPath();
const STARTUP = startupEntryPath();
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
const node = engineNodeBin(dsRoot ?? dataHome());

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

// 5. PATH shim (content generated by platform.mjs - pure ASCII, env-var based
//    paths, engine-bundled node first with a `node`-on-PATH fallback).
//    macOS/Linux: POSIX sh script with the executable bit set
//    (~/.local/bin is typically already on PATH).
mkdirSync(dirname(SHIM), { recursive: true });
writeFileSync(SHIM, shimContent(HUB_ROOT, dsRoot ?? dataHome()));
if (!IS_WIN) chmodSync(SHIM, 0o755);
log(`shim written to ${SHIM}${IS_WIN ? " (needs %USERPROFILE%\\.local\\bin on PATH)" : " (needs ~/.local/bin on PATH)"}`);

// 6. Optional startup entry: Startup-folder .cmd on Windows, a launchd
//    LaunchAgent on macOS, a systemd user unit on Linux (content generated
//    by platform.mjs, same node fallback rules as the shim).
if (withStartup) {
  mkdirSync(dirname(STARTUP), { recursive: true });
  writeFileSync(STARTUP, startupEntryContent(HUB_ROOT, dsRoot ?? dataHome()));
  if (process.platform === "darwin") {
    try {
      spawnSync("launchctl", ["load", STARTUP], { stdio: "ignore" });
    } catch { /* best effort - loads at next login anyway */ }
  } else if (!IS_WIN) {
    log("enable it with: systemctl --user enable --now codexskin.service");
  }
  log(`startup entry written to ${STARTUP}`);
} else {
  log("startup entry skipped (pass --startup to register one)");
}

log("done. Commands: codexskin theme | import | gallery | dir | status | doctor");
