// patch-sandbox-test.mjs - offline regression test for src/patch.mjs.
//
// Copies the locally installed @codexhost/cli bin + renderer (stock OR already
// patched) into a temp sandbox package and asserts:
//   1. if the copies were patched, --revert yields a stable stock baseline
//      (second revert is a no-op that changes nothing)
//   2. patch run exits 0 and reports PATCHED for bin + renderer
//   3. second patch run is an idempotent no-op ("already patched")
//   4. --revert restores both files byte-identical to the stock baseline
//   5. the patched renderer parses both as ESM and as a classic script
//      (classic-script parse emulates the CDP Runtime.evaluate context the
//      codexhost injector uses - `node --check` alone cannot catch this class)
//   6. the payload render smoke test (check-payload-render.cjs) still passes
//
// The real installation is never touched: patch.mjs is pointed at the sandbox
// via the CODEXSKIN_PKG_DIR testing override. Exit code 0 = all checks passed.
//
// Usage:  node src/tools/patch-sandbox-test.mjs

import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findCodexhostPackage } from "../discover.mjs";

const projRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const patchScript = join(projRoot, "src", "patch.mjs");
const smokeScript = join(projRoot, "src", "tools", "check-payload-render.cjs");

const pkg = findCodexhostPackage([process.env.CODEXSKIN_PKG_DIR]);
if (!pkg) {
  console.error("patch-sandbox-test: @codexhost/cli not found - install it first");
  process.exit(1);
}
const binSrc = join(pkg.dir, "bin", "codexhost.js");
const platformPkgs = [
  "cli-win32-x64", "cli-win32-arm64",
  "cli-darwin-arm64", "cli-darwin-x64",
  "cli-linux-x64", "cli-linux-arm64",
];
let rendererSrc = null;
for (const plat of platformPkgs) {
  const candidate = join(pkg.dir, "node_modules", "@codexhost", plat, "app", "renderer-extension.js");
  if (candidate && readFileSync(candidate, "utf8").length > 0) { rendererSrc = candidate; break; }
}
if (!rendererSrc) {
  console.error("patch-sandbox-test: no platform renderer found under " + pkg.dir);
  process.exit(1);
}

let failures = 0;
function check(ok, label) {
  console.log((ok ? "ok    " : "FAIL  ") + label);
  if (!ok) failures += 1;
}

const sandbox = mkdtempSync(join(tmpdir(), "csh-sandbox-"));
try {
  const pkgDir = join(sandbox, "pkg");
  const platRel = rendererSrc.slice(join(pkg.dir, "node_modules").length + 1);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  mkdirSync(dirname(join(pkgDir, "node_modules", platRel)), { recursive: true });
  copyFileSync(binSrc, join(pkgDir, "bin", "codexhost.js"));
  copyFileSync(rendererSrc, join(pkgDir, "node_modules", platRel));
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@codexhost/cli", version: pkg.version }));

  const env = { ...process.env, CODEXSKIN_PKG_DIR: pkgDir };
  const run = (...args) =>
    spawnSync(process.execPath, args, { encoding: "utf8", cwd: projRoot, env });
  const sandboxRenderer = () => readFileSync(join(pkgDir, "node_modules", platRel), "utf8");
  const sandboxBin = () => readFileSync(join(pkgDir, "bin", "codexhost.js"), "utf8");

  // 1. Normalize the sandbox to stock. If the installed files were already
  //    patched, revert here (sandbox only) and verify revert stability.
  const wasPatched = sandboxBin().includes("[codexskin]") || sandboxRenderer().includes("[codexskin]");
  if (wasPatched) {
    const rr = run(patchScript, "--revert");
    check(rr.status === 0, "revert of pre-patched copies exits 0");
    const after1 = { bin: sandboxBin(), ren: sandboxRenderer() };
    run(patchScript, "--revert");
    check(sandboxBin() === after1.bin && sandboxRenderer() === after1.ren,
      "second revert is a no-op (revert is stable)");
  }
  const baseline = { bin: sandboxBin(), ren: sandboxRenderer() };
  check(!baseline.bin.includes("[codexskin]") && !baseline.ren.includes("[codexskin]"),
    "stock baseline established (no [codexskin] markers)");

  // 2. patch
  const r1 = run(patchScript);
  check(r1.status === 0 && r1.stdout.includes("bin: PATCHED"), `patch applies on codexhost v${pkg.version} (bin)`);
  check(r1.status === 0 && r1.stdout.includes("renderer: PATCHED"), "patch applies (renderer)");

  // 3. idempotence
  const r2 = run(patchScript);
  check(r2.status === 0 && r2.stdout.includes("already patched"), "second patch run is an idempotent no-op");

  // 4. revert == stock baseline
  const r3 = run(patchScript, "--revert");
  check(r3.status === 0, "revert run exits 0");
  check(sandboxRenderer() === baseline.ren, "revert restores renderer byte-identical to stock");
  check(sandboxBin() === baseline.bin, "revert restores bin byte-identical to stock");

  // Re-apply for the parse checks (sandbox was reverted above).
  run(patchScript);
  const patchedRenderer = sandboxRenderer();
  const patchedBin = sandboxBin();

  // 5. parse modes
  const modTmp = join(sandbox, "modcheck.mjs");
  writeFileSync(modTmp, patchedRenderer);
  const esm = spawnSync(process.execPath, ["--check", modTmp], { encoding: "utf8" });
  check(esm.status === 0, "patched renderer parses as ESM");
  let scriptOk = true;
  try { new Function(patchedRenderer); } catch { scriptOk = false; }
  check(scriptOk, "patched renderer parses as classic script (injector context)");
  writeFileSync(modTmp, patchedBin);
  const esmBin = spawnSync(process.execPath, ["--check", modTmp], { encoding: "utf8" });
  check(esmBin.status === 0, "patched bin parses as ESM");

  // 6. payload render smoke
  const r6 = run(smokeScript);
  check(r6.status === 0, "payload render smoke test passes");
} finally {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* keep on failure */ }
}

console.log(failures === 0 ? "\nall sandbox patch checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
