#!/usr/bin/env node
// uninstall.mjs - reverse of install.mjs.
//
//   node uninstall.mjs
//
//   1. strips the codexhost bin/renderer patches back to stock (anchor-safe,
//      refuses to touch files whose layout it does not recognize)
//   2. removes the PATH shim and the optional startup entry
//   3. removes the runtime home (per-OS: %LOCALAPPDATA%\CodexSkinHub,
//      ~/Library/Application Support/CodexSkinHub, XDG data home)
//
// The Dream Skin installation, the theme library and Codex itself are left
// untouched. The legacy CodexDreamSkin state file is kept so a re-install
// picks up where things left off.

import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { platform as osPlatform } from "node:os";
// Single source of truth for platform paths (same rule as install.mjs).
import {
  dataHome, engineNodeBin, hubRoot, shimPath, startupEntryPath,
} from "./src/platform.mjs";

const repo = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const HUB_ROOT = hubRoot();
const SHIM = shimPath();
const STARTUP = startupEntryPath();

function log(msg) {
  console.log(`[codexskin-uninstall] ${msg}`);
}

// 1. Revert patches. Prefer the installed runtime copy, fall back to the repo.
const patcher = existsSync(join(HUB_ROOT, "src", "patch.mjs"))
  ? join(HUB_ROOT, "src", "patch.mjs")
  : join(repo, "src", "patch.mjs");
// process.execPath (the node running this script) is always a working node.
const node = engineNodeBin(dataHome());
const r = spawnSync(node, [patcher, "--revert"], { stdio: "inherit", windowsHide: true });
if (r.status !== 0) {
  log("WARNING: revert reported problems - inspect the files manually:");
  log(`  node ${patcher} --revert`);
}

// 2. Shim + startup entry. On macOS also unload the LaunchAgent first.
if (IS_MAC && existsSync(STARTUP)) {
  try { spawnSync("launchctl", ["unload", STARTUP], { stdio: "ignore" }); } catch { /* best effort */ }
}
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

if (IS_WIN) {
  log("done. Note: the separate %USERPROFILE%\\.local\\bin\\codexhost.cmd shim from the");
  log("legacy CodexDreamSkin setup is NOT removed by this script - delete it manually");
  log("if you no longer want codexhost invocations to run patch checks.");
} else {
  log(`done (${osPlatform}). The Dream Skin engine, theme library and Codex Desktop are untouched.`);
}
