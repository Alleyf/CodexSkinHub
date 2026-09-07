#!/usr/bin/env node
// uninstall.mjs - reverse of install.mjs.
//
//   node uninstall.mjs
//
//   1. strips the codexhost bin/renderer patches back to stock (anchor-safe,
//      refuses to touch files whose layout it does not recognize)
//   2. removes the PATH shim and the optional startup entry
//   3. removes the runtime home %LOCALAPPDATA%\CodexSkinHub
//
// The Dream Skin installation, the theme library and Codex itself are left
// untouched. The legacy %LOCALAPPDATA%\CodexDreamSkin\codexskin.json state is
// kept so a re-install picks up where things left off.

import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const repo = dirname(fileURLToPath(import.meta.url));
const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const userProfile = process.env.USERPROFILE ?? homedir();
const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");

const HUB_ROOT = join(localAppData, "CodexSkinHub");
const SHIM = join(userProfile, ".local", "bin", "codexskin.cmd");
const STARTUP = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "CodexSkinHub.cmd");

function log(msg) {
  console.log(`[codexskin-uninstall] ${msg}`);
}

// 1. Revert patches. Prefer the installed runtime copy, fall back to the repo.
const patcher = existsSync(join(HUB_ROOT, "src", "patch.mjs"))
  ? join(HUB_ROOT, "src", "patch.mjs")
  : join(repo, "src", "patch.mjs");
const nodeExe = join(localAppData, "CodexDreamSkin", "engine", "runtime", "node", "node.exe");
const node = existsSync(nodeExe) ? nodeExe : "node";
const r = spawnSync(node, [patcher, "--revert"], { stdio: "inherit", windowsHide: true });
if (r.status !== 0) {
  log("WARNING: revert reported problems - inspect the files manually:");
  log(`  node ${patcher} --revert`);
}

// 2. Shim + startup entry.
for (const f of [SHIM, STARTUP]) {
  if (existsSync(f)) {
    rmSync(f);
    log(`removed ${f}`);
  }
}

// 3. Runtime home.
if (existsSync(HUB_ROOT)) {
  rmSync(HUB_ROOT, { recursive: true, force: true });
  log(`removed ${HUB_ROOT}`);
}

log("done. Note: the separate %USERPROFILE%\\.local\\bin\\codexhost.cmd shim from the");
log("legacy CodexDreamSkin setup is NOT removed by this script - delete it manually");
log("if you no longer want codexhost invocations to run patch checks.");
