// Locate the globally installed @codexhost/cli package without hard-coding a
// single npm prefix (issue #2: nvm-windows and custom `npm config set prefix`
// layouts keep global packages outside %APPDATA%\npm). No side effects on
// import - both cli.mjs and patch.mjs share this helper.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Candidate package dirs, cheapest first:
// 1. classic default prefix (%APPDATA%\npm)
// 2. next to node.exe - nvm-windows / volta keep the (symlinked) prefix dir
//    and node.exe side by side, so this resolves the active version directly
// 3. `npm prefix -g` - authoritative for custom prefixes, but costs a process
//    spawn, so it is only consulted when the fast candidates miss.
export function codexhostCandidateDirs() {
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
  const candidates = [
    join(appData, "npm", "node_modules", "@codexhost", "cli"),
    join(process.execPath, "..", "node_modules", "@codexhost", "cli"),
  ];
  try {
    const r = spawnSync("npm", ["prefix", "-g"], {
      encoding: "utf8", timeout: 15000, windowsHide: true, shell: true,
    });
    const prefix = String(r.stdout ?? "").split(/\r?\n/).find((l) => l.trim());
    if (prefix) candidates.push(join(prefix.trim(), "node_modules", "@codexhost", "cli"));
  } catch {
    /* npm not runnable - the first two candidates have to be enough */
  }
  return candidates;
}

// Returns { dir, version } for the first candidate that looks like
// @codexhost/cli, or null. `extraCandidates` are probed first (e.g. the
// CODEXSKIN_PKG_DIR override).
export function findCodexhostPackage(extraCandidates = []) {
  for (const dir of [...extraCandidates.filter(Boolean), ...codexhostCandidateDirs()]) {
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
