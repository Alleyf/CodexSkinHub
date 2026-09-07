#!/usr/bin/env node
// patch-codexhost.mjs - idempotent re-applier of the Codex Dream Skin patches
// to the globally installed @codexhost/cli npm package.
//
// Why: `npm update -g @codexhost/cli` (or a reinstall) replaces the whole
// package directory, wiping both integration patches:
//   A) bin/codexhost.js        -> `codexhost theme` + supervisor autostart
//   B) app/renderer-extension.js -> in-app "Dream Skin" settings page
// Run this after any update; it is safe to run any number of times.
//
// Usage:
//   node patch.mjs                      # ensure both patches are applied
//   node patch.mjs status               # only report, change nothing
//   node patch.mjs --revert             # strip both patches back to stock
//   --quiet                             # suppress stdout (for shims)
// Env:
//   CODEXSKIN_PKG_DIR=/path/to/@codexhost/cli   (testing override)
//
// Behavior guarantees:
//   - Already patched  -> no-op, exit 0.
//   - Anchors found    -> patch, syntax-check the result, exit 0.
//   - Anchors missing  -> upstream layout changed; file is LEFT UNTOUCHED,
//                         failure is reported, exit 1.

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const quiet = process.argv.includes("--quiet");
const statusOnly = process.argv.includes("status");
const revertMode = process.argv.includes("--revert");

function log(msg) {
  if (!quiet) console.log(`[codexskin-patch] ${msg}`);
}

// ---------------------------------------------------------------------------
// Locate the global @codexhost/cli package
// ---------------------------------------------------------------------------
function findPackage() {
  const override = process.env.CODEXSKIN_PKG_DIR;
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  const candidates = [
    override,
    join(appData, "npm", "node_modules", "@codexhost", "cli"),
  ].filter(Boolean);
  for (const dir of candidates) {
    const pkgJson = join(dir, "package.json");
    if (!existsSync(pkgJson)) continue;
    try {
      const json = JSON.parse(readFileSync(pkgJson, "utf8"));
      if (json.name === "@codexhost/cli") return { dir, version: json.version };
    } catch {
      /* unreadable package.json - skip */
    }
  }
  return null;
}

function targetsFor(pkgDir) {
  return {
    bin: join(pkgDir, "bin", "codexhost.js"),
    renderer: join(
      pkgDir, "node_modules", "@codexhost", "cli-win32-x64", "app", "renderer-extension.js",
    ),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const detectEol = (s) => (s.includes("\r\n") ? "\r\n" : "\n");
const toEol = (s, eol) => s.replace(/\r\n/g, "\n").replace(/\n/g, eol);

/** Write candidate text only after `node --check` accepts it (as ESM via .mjs). */
function writeChecked(filePath, text) {
  const tmpDir = mkdtempSync(join(tmpdir(), "codexskin-check-"));
  const tmpFile = join(tmpDir, "check.mjs");
  try {
    writeFileSync(tmpFile, text);
    const res = spawnSync(process.execPath, ["--check", tmpFile], { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(
        "patched file failed node --check: " + (res.stderr ?? res.stdout ?? "").trim().split("\n")[0],
      );
    }
    writeFileSync(filePath, text);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Patch A - bin/codexhost.js
//   A1: hook import + `theme` subcommand dispatch (before startupTrace entry)
//   A2: superviseDetached() on launch
//   A3: --help extension (best effort, never fatal)
// ---------------------------------------------------------------------------
function binBlock1(eol) {
  return toEol(
    `// [codexskin] Codex Dream Skin theme integration, maintained by CodexSkinHub.
// The hook lives in %LOCALAPPDATA%\\CodexSkinHub\\hook.mjs (fallback: the legacy
// %LOCALAPPDATA%\\CodexDreamSkin\\codexhost-hook.mjs); if neither file exists or
// the engine is uninstalled, codexhost behaves exactly like stock.
let dreamSkinHook = null;
const dreamSkinHookCandidates = [
  path.join(process.env.LOCALAPPDATA ?? "", "CodexSkinHub", "src", "hook.mjs"),
  path.join(process.env.LOCALAPPDATA ?? "", "CodexDreamSkin", "codexhost-hook.mjs"),
];
const dreamSkinHookPath = dreamSkinHookCandidates.find((p) => existsSync(p));
if (dreamSkinHookPath) {
  try {
    dreamSkinHook = await import(pathToFileURL(dreamSkinHookPath).href);
  } catch {
    dreamSkinHook = null;
  }
}
if (dreamSkinHook && userArguments[0] === "theme") {
  dreamSkinHook.runTheme(userArguments.slice(1));
  process.exit(process.exitCode ?? 0);
}
`,
    eol,
  );
}

const BIN_BLOCK2 = (eol) =>
  toEol(
    `  // [codexskin] keep Dream Skin themes aligned with whatever CDP endpoint the
  // managed Desktop ends up using, across restarts. Detached + no-op when the
  // engine is absent or a supervisor is already running.
  dreamSkinHook?.superviseDetached();`,
    eol,
  );

function patchBin(text) {
  if (text.includes("[codexskin]")) return { text, changed: false };
  const eol = detectEol(text);

  // Preconditions: stock names the patch relies on.
  const fsImportRe = /import\s*\{[^}]*existsSync[^}]*\}\s*from\s*"node:fs"/;
  if (!fsImportRe.test(text)) {
    throw new Error('stock bin is missing the existsSync import - upstream changed, refusing to patch');
  }
  // The hook import uses pathToFileURL. Stock bins before 0.6.0 already import
  // it; newer stock bins import only fileURLToPath, so add it in place.
  const urlImportRe = /import\s*\{([^}]*)\}\s*from\s*"node:url"/;
  const urlImport = text.match(urlImportRe);
  if (!urlImport) {
    throw new Error('stock bin has no "node:url" import - upstream changed, refusing to patch');
  }
  if (!/\bpathToFileURL\b/.test(urlImport[1])) {
    text = text.replace(
      urlImportRe,
      (_m, names) => `import { ${names.trim().split(",").map((s) => s.trim()).filter(Boolean)
        .concat("pathToFileURL").join(", ")} } from "node:url"`,
    );
  }

  const a1 = 'startupTrace("entry");';
  const i1 = text.indexOf(a1);
  if (i1 === -1) {
    throw new Error('bin anchor 1 (startupTrace("entry")) not found - upstream changed');
  }
  text = text.slice(0, i1) + binBlock1(eol) + text.slice(i1);

  const a2 = 'startupTrace("spawning Launcher");';
  const i2 = text.indexOf(a2);
  if (i2 === -1) {
    throw new Error('bin anchor 2 (startupTrace("spawning Launcher")) not found - upstream changed');
  }
  const afterA2 = i2 + a2.length;
  text = text.slice(0, afterA2) + eol + BIN_BLOCK2(eol) + text.slice(afterA2);

  // A3: --help extension (best effort).
  const helpAnchor = '"Rust launcher/shim. Codex Desktop must already be installed."';
  const hi = text.indexOf(helpAnchor);
  const joinAt = hi === -1 ? -1 : text.indexOf('].join("\\n")', hi);
  if (joinAt !== -1 && !text.slice(joinAt, joinAt + 200).includes("dreamSkinHook")) {
    const insertAt = joinAt + '].join("\\n")'.length;
    const helpText = toEol(
      ' +\n' +
      '      (dreamSkinHook\n' +
      '        ? "\\n\\nDream Skin integration:\\n  codexhost theme                  list Codex Dream Skin themes\\n  codexhost theme <name|id>        hot-switch the Codex theme"\n' +
      '        : "")',
      eol,
    );
    text = text.slice(0, insertAt) + helpText + text.slice(insertAt);
  } else if (joinAt === -1) {
    log("  (note: --help anchor not found, help text left stock)");
  }

  return { text, changed: true };
}

// ---------------------------------------------------------------------------
// Patch B - app/renderer-extension.js
//   B1: insert the bridge + Dream Skin settings page block (payload file)
//   B2: append dreamSkinPage() to the pages array
// ---------------------------------------------------------------------------
function patchRenderer(text) {
  if (text.includes("[codexskin]")) return { text, changed: false };
  const eol = detectEol(text);

  const payloadFile = join(here, "payload", "renderer.js");
  if (!existsSync(payloadFile)) {
    throw new Error(`payload file missing: ${payloadFile}`);
  }
  const payload = toEol(readFileSync(payloadFile, "utf8"), eol).trimEnd();

  const anchor = "function createDefaultRendererSettingsPages(";
  const i = text.indexOf(anchor);
  if (i === -1) {
    throw new Error("renderer anchor (createDefaultRendererSettingsPages) not found - upstream changed");
  }

  // B1: insert the payload just before the anchor's line.
  const lineStart = text.lastIndexOf("\n", i) + 1;
  let out = text.slice(0, lineStart) + payload + eol + text.slice(lineStart);

  // B2: append dreamSkinPage() inside the pages array.
  const j = out.indexOf(anchor);
  const re = /aboutPage\(messages\)(\r?\n)(\s*)\]\)/;
  const m = out.slice(j).match(re);
  if (!m) {
    throw new Error("renderer anchor 2 (aboutPage entry in pages array) not found - upstream changed");
  }
  const replacement =
    "aboutPage(messages)," + m[1] + "      dreamSkinPage()" + m[1] + m[2] + "])";
  out = out.slice(0, j) + out.slice(j).replace(re, replacement);

  return { text: out, changed: true };
}

// ---------------------------------------------------------------------------
// Revert - strip both patches back to stock (used by uninstall / migration)
// ---------------------------------------------------------------------------
function revertBin(text) {
  if (!text.includes("[codexskin]")) return { text, changed: false };
  // Block 1: comment header through the line before startupTrace("entry");.
  const s1 = text.indexOf("// [codexskin] Codex Dream Skin theme integration");
  const e1 = text.indexOf('startupTrace("entry");');
  if (s1 !== -1 && e1 !== -1 && e1 > s1) text = text.slice(0, s1) + text.slice(e1);
  // Block 2: marker comment + superviseDetached() call line.
  const marker2 = "  // [codexskin] keep Dream Skin themes aligned";
  const call2 = "  dreamSkinHook?.superviseDetached();";
  const s2 = text.indexOf(marker2);
  const e2 = text.indexOf(call2);
  if (s2 !== -1 && e2 !== -1 && e2 > s2) {
    text = text.slice(0, s2) + text.slice(e2 + call2.length);
    // The block was inserted as eol + block (block itself may end with an
    // extra eol), so collapse ALL blank lines left behind at the junction.
    text = text.replace(/(startupTrace\("spawning Launcher"\);\r?\n)\r?\n+/, "$1");
  }
  // --help extension.
  text = text.replace(/\s*\+\s*\(dreamSkinHook[\s\S]*?:\s*""\)/, "");
  // Import: drop pathToFileURL again if nothing else uses it (0.6.0+ stock
  // does not import it; older stock did but also used it elsewhere).
  const uses = text.split("pathToFileURL").length - 1;
  if (uses === 1) {
    text = text.replace(/\s*,\s*\bpathToFileURL\b/, "").replace(/\bpathToFileURL\b\s*,\s*/, "");
  }
  return { text, changed: true };
}

function revertRenderer(text) {
  if (!text.includes("[codexskin]")) return { text, changed: false };
  // Payload block: from its first marker line up to (not including) the
  // original createDefaultRendererSettingsPages line.
  const s = text.indexOf("  // [codexskin] Dream Skin theme page");
  const anchor = "  function createDefaultRendererSettingsPages(";
  const a = s === -1 ? -1 : text.indexOf(anchor, s);
  if (s !== -1 && a !== -1) text = text.slice(0, s) + text.slice(a);
  // dreamSkinPage() entry in the pages array.
  for (const eol of ["\r\n", "\n"]) {
    const patched = "aboutPage(messages)," + eol + "      dreamSkinPage()" + eol + "    ])";
    const stock = "aboutPage(messages)" + eol + "    ])";
    if (text.includes(patched)) {
      text = text.replace(patched, stock);
      break;
    }
  }
  return { text, changed: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const pkg = findPackage();
if (!pkg) {
  log("ERROR: @codexhost/cli not found (looked in %APPDATA%\\npm\\node_modules and CODEXSKIN_PKG_DIR)");
  process.exit(1);
}
const { bin, renderer } = targetsFor(pkg.dir);
let failed = false;

for (const [name, file, patchFn, revertFn] of [
  ["bin", bin, patchBin, revertBin],
  ["renderer", renderer, patchRenderer, revertRenderer],
]) {
  if (!existsSync(file)) {
    log(`${name}: FILE MISSING (${file})`);
    failed = true;
    continue;
  }
  const original = readFileSync(file, "utf8");
  if (revertMode) {
    if (!original.includes("[codexskin]")) {
      log(`${name}: already stock`);
      continue;
    }
    try {
      const { text } = revertFn(original);
      writeChecked(file, text);
      log(`${name}: REVERTED to stock`);
    } catch (err) {
      log(`${name}: REVERT FAILED - ${err.message}`);
      log(`  file left untouched: ${file}`);
      failed = true;
    }
    continue;
  }
  if (original.includes("[codexskin]")) {
    log(`${name}: already patched (codexhost v${pkg.version})`);
    continue;
  }
  if (statusOnly) {
    log(`${name}: PATCH MISSING (codexhost v${pkg.version})`);
    failed = true;
    continue;
  }
  try {
    const { text } = patchFn(original);
    writeChecked(file, text);
    log(`${name}: PATCHED (codexhost v${pkg.version})`);
  } catch (err) {
    log(`${name}: FAILED - ${err.message}`);
    log(`  file left untouched: ${file}`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
