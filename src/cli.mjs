#!/usr/bin/env node
// codexskin - fuses BytePioneer-AI/codex-host with Fei-Away/Codex-Dream-Skin.
//
//   codexskin start [--theme <name>]   start codexhost + auto-inject + self-healing supervisor
//   codexskin theme [<name>]           switch theme live (no Codex restart) / list themes
//   codexskin status                   show endpoint / injector / theme state
//   codexskin down                     stop codexhost supervisor and the theme injector
//
// How it works:
// - Dream Skin themes are injected at runtime over CDP. The injector watch loop
//   polls the active-theme directory fingerprint, so rewriting the files inside
//   active-theme hot-applies a new theme to every running Codex window.
// - codexhost starts Codex Desktop with a dynamically chosen CDP port, so the
//   supervisor discovers the live endpoint (ChatGPT.exe listening sockets ->
//   /json/version) and (re)starts the injector against it whenever needed.

// Platform gate. Windows is fully supported; macOS is experimental (upstream
// engine ships a .dmg, but this port has not been exercised on real Macs);
// Linux is hard-blocked because upstream Dream Skin has no Linux engine.
if (process.platform === "linux" && !process.env.CODEXSKIN_ALLOW_NON_WIN32) {
  console.error("[codexskin] Linux is not supported: the upstream Codex Dream Skin");
  console.error("  engine has no Linux build (Windows .exe / macOS .dmg only).");
  console.error("  Set CODEXSKIN_ALLOW_NON_WIN32=1 to override at your own risk.");
  process.exit(1);
}
if (process.platform === "darwin" && !process.env.CODEXSKIN_QUIET) {
  console.error("[codexskin] note: macOS support is experimental and untested on real hardware;");
  console.error("  report issues at https://github.com/Alleyf/CodexSkinHub/issues");
}

import { spawn, execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { findCodexhostPackage } from "./discover.mjs";
import * as plat from "./platform.mjs";

// CodexSkinHub owns its own state; the Dream Skin engine (injector, node
// runtime, theme library) stays in its per-OS data home (Windows:
// %LOCALAPPDATA%\CodexDreamSkin, macOS: ~/Library/Application Support/...)
// and is only referenced. Resolution order: config.json -> env -> probe.
const HUB_ROOT = plat.hubRoot();
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HUB_ROOT, "config.json"), "utf8"));
  } catch {
    return {};
  }
}
const CFG = loadConfig();
const DS_ROOT = process.env.CODEXSKIN_DS_ROOT
  ?? CFG.dreamSkinRoot
  ?? plat.dsRootCandidates().find((p) => fs.existsSync(path.join(p, "engine", "scripts", "injector.mjs")))
  ?? plat.dsRootCandidates()[0];
const ENGINE = path.join(DS_ROOT, "engine");
const NODE_EXE = plat.engineNodeBin(DS_ROOT);
const INJECTOR = path.join(ENGINE, "scripts", "injector.mjs");
const THEME_DIR = path.join(DS_ROOT, "active-theme");
const THEMES_DIR = path.join(DS_ROOT, "themes");
const PAUSE_FILE = path.join(DS_ROOT, "paused");
const DS_STATE = path.join(DS_ROOT, "state.json");
const INJECTOR_LOG = path.join(DS_ROOT, "injector.log");
const INJECTOR_ERR = path.join(DS_ROOT, "injector-error.log");
const SKIN_STATE = path.join(HUB_ROOT, "codexskin.json");
const GALLERY_URL = "https://dreamskin.cc/gallery";
const IMPORT_LOG = path.join(HUB_ROOT, "codexskin-import.log");
const URL_PREFIX_ALLOW = "https://dreamskin.cc";

function die(message) {
  console.error(`[codexskin] error: ${message}`);
  process.exit(1);
}

function assertEngine() {
  for (const p of [INJECTOR, THEME_DIR]) {
    if (!fs.existsSync(p)) die(`Dream Skin engine incomplete, missing: ${p}`);
  }
  if (NODE_EXE === process.execPath) {
    die(`engine Node runtime not found under ${ENGINE} (looked for the bundled node binary)`);
  }
}

function execFileText(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

// Launch the codexhost CLI. On Windows `codexhost` resolves to a .cmd shim,
// which Node refuses to exec without a shell, hence cmd.exe. On unix the npm
// global bin script (node shebang) spawns directly via PATH.
function spawnCodexhost(options) {
  if (plat.isWindows()) {
    return spawn("cmd.exe", ["/d", "/s", "/c", "codexhost"], options);
  }
  return spawn("codexhost", [], options);
}

function readJsonSafe(file) {  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function writeJsonNoBom(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function getChatPids() {
  return plat.findDesktopPids(execFileText);
}

async function getListeningPorts(pids) {
  return plat.listeningPortsOfPids(pids, execFileText);
}

function probeCdp(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/json/version", timeout: 2000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const payload = JSON.parse(data);
            const ws = String(payload.webSocketDebuggerUrl ?? "");
            const m = ws.match(/^ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/([A-Za-z0-9._-]+)$/);
            if (m && Number(m[1]) === port) {
              resolve({ port, browserId: m[2], browser: String(payload.Browser ?? "") });
              return;
            }
          } catch { /* fallthrough */ }
          resolve(null);
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

async function discoverCdp() {
  const pids = await getChatPids();
  for (const port of await getListeningPorts(pids)) {
    const endpoint = await probeCdp(port);
    if (endpoint) return endpoint;
  }
  return null;
}

function processAlive(pid) {
  if (!pid || pid <= 0) return Promise.resolve(false);
  if (!plat.isWindows()) {
    // signal 0 = existence probe, works for any pid we own visibility of
    try { process.kill(pid, 0); return Promise.resolve(true); } catch { return Promise.resolve(false); }
  }
  return execFileText("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).then(
    (out) => /\.exe/i.test(out),
  );
}

async function liveInjectorPid() {
  const ds = readJsonSafe(DS_STATE);
  const pid = ds && Number(ds.injectorPid);
  if (pid && (await processAlive(pid))) return { pid, port: Number(ds.port) };
  return { pid: 0, port: 0 };
}

async function stopInjector() {
  const { pid } = await liveInjectorPid();
  if (pid) {
    await plat.killTree(pid, execFileText);
    console.log(`[codexskin] stopped old injector (pid ${pid})`);
  }
}

async function startInjector(endpoint) {
  await stopInjector();
  const args = [
    INJECTOR,
    "--port", String(endpoint.port),
    "--browser-id", endpoint.browserId,
    "--theme-dir", THEME_DIR,
    "--pause-file", PAUSE_FILE,
    "--watch",
  ];
  const out = fs.openSync(INJECTOR_LOG, "a");
  const err = fs.openSync(INJECTOR_ERR, "a");
  const child = spawn(NODE_EXE, args, { detached: true, stdio: ["ignore", out, err], windowsHide: true });
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);

  const ds = readJsonSafe(DS_STATE);
  if (ds) {
    ds.port = endpoint.port;
    ds.browserId = endpoint.browserId;
    ds.injectorPid = child.pid;
    ds.injectorStartedAt = new Date().toISOString();
    writeJsonNoBom(DS_STATE, ds);
  }
  console.log(`[codexskin] injector aligned to port ${endpoint.port} (pid ${child.pid})`);
  return child.pid;
}

async function listThemes() {
  const active = readJsonSafe(path.join(THEME_DIR, "theme.json"));
  const activeId = active ? String(active.id) : "";
  const entries = [];
  let dirents = [];
  try {
    dirents = await fsp.readdir(THEMES_DIR, { withFileTypes: true });
  } catch { /* no theme store */ }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const manifest = readJsonSafe(path.join(THEMES_DIR, d.name, "theme.json"));
    if (!manifest) continue;
    entries.push({ dir: d.name, id: String(manifest.id ?? d.name), name: String(manifest.name ?? d.name) });
  }
  return { activeId, entries };
}

async function applyTheme(query) {
  const { entries } = await listThemes();
  if (entries.length === 0) throw new Error(`no themes found in ${THEMES_DIR}`);
  const q = String(query ?? "").toLowerCase().trim();
  if (!q) throw new Error("theme name or id required");
  const theme = entries.find((t) => t.dir.toLowerCase() === q || t.id.toLowerCase() === q)
    ?? entries.find((t) => t.name.toLowerCase().includes(q) || t.dir.toLowerCase().includes(q));
  if (!theme) {
    throw new Error(`theme not found: "${query}". Run "codexskin theme" to list available themes.`);
  }

  const manifest = readJsonSafe(path.join(THEMES_DIR, theme.dir, "theme.json"));
  await fsp.rm(THEME_DIR, { recursive: true, force: true });
  await fsp.mkdir(THEME_DIR, { recursive: true });
  await fsp.cp(path.join(THEMES_DIR, theme.dir), THEME_DIR, { recursive: true });
  writeJsonNoBom(path.join(THEME_DIR, "theme.json"), manifest);

  const ds = readJsonSafe(DS_STATE);
  if (ds && "themeDir" in ds) {
    ds.themeDir = THEME_DIR; // only touch keys the Dream Skin app already knows
    writeJsonNoBom(DS_STATE, ds);
  }
  const skin = readJsonSafe(SKIN_STATE) ?? {};
  skin.lastTheme = { id: theme.id, dir: theme.dir, switchedAt: new Date().toISOString() };
  writeJsonNoBom(SKIN_STATE, skin);

  console.log(`[codexskin] theme switched to "${theme.name}" (${theme.id})`);
  console.log("[codexskin] the running injector hot-applies it within a few seconds.");
  if (!(await processAlive((readJsonSafe(DS_STATE) ?? {}).injectorPid))) {
    console.log("[codexskin] no live injector detected - it will be started automatically");
    console.log("            by \"codexskin start\", or run it now:  codexskin inject");
  }
  return theme;
}

async function switchTheme(query) {
  try {
    await applyTheme(query);
  } catch (e) {
    die(e.message);
  }
}

async function cmdInject() {
  assertEngine();
  const endpoint = await discoverCdp();
  if (!endpoint) die("no running Codex Desktop CDP endpoint. Start codexhost/Codex first.");
  await startInjector(endpoint);
  console.log("[codexskin] done.");
}

function startSupervisorLoop({ log = () => {}, intervalMs = 4000 } = {}) {
  return setInterval(async () => {
    try {
      const endpoint = await discoverCdp();
      if (!endpoint) return;
      const { pid, port } = await liveInjectorPid();
      if (pid && port === endpoint.port) return;
      if (pid && port !== endpoint.port) {
        log(`[codexskin] Codex endpoint moved ${port} -> ${endpoint.port}, realigning injector...`);
      } else {
        log(`[codexskin] Codex endpoint on port ${endpoint.port}, starting injector...`);
      }
      await startInjector(endpoint);
    } catch (e) {
      console.error(`[codexskin] supervisor: ${e.message}`);
    }
  }, intervalMs);
}

// ---------------------------------------------------------------------------
// Theme store management: open folder / open gallery / import theme ZIP
// ---------------------------------------------------------------------------

async function openThemesDir() {
  await fsp.mkdir(THEMES_DIR, { recursive: true });
  plat.openPath(THEMES_DIR);
  console.log(`[codexskin] opened theme folder: ${THEMES_DIR}`);
  return { opened: THEMES_DIR };
}

function openGallery(url) {
  const target = String(url ?? GALLERY_URL);
  if (!target.startsWith(URL_PREFIX_ALLOW)) {
    throw new Error(`only ${URL_PREFIX_ALLOW} URLs may be opened from the bridge`);
  }
  plat.openUrl(target);
  console.log(`[codexskin] opening ${target} in the default browser`);
  return { opened: target };
}

// Native file picker: PowerShell WinForms (Windows), osascript (macOS),
// zenity (Linux). Delegates to platform.mjs.
async function pickZipViaDialog() {
  return plat.pickZipViaDialog(execFileText);
}

// ZIP extraction: Windows ships bsdtar at System32\tar.exe (handles ZIP and
// drive-letter paths; a GNU tar earlier in PATH would treat "C:\..." as a
// remote host). macOS has bsdtar as `tar`; Linux gets `unzip` with a tar
// fallback.
function execFileStrict(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${String(stderr || err.message).split("\n")[0]}`));
      else resolve(String(stdout));
    });
  });
}

async function extractZip(zip, dest) {
  if (plat.isWindows()) {
    const systemTar = path.join(process.env.SystemRoot ?? "C:\\windows", "System32", "tar.exe");
    await execFileStrict(systemTar, ["-xf", zip, "-C", dest]);
    return;
  }
  try {
    await execFileStrict("unzip", ["-q", "-o", zip, "-d", dest]);
  } catch {
    await execFileStrict("tar", ["-xf", zip, "-C", dest]); // bsdtar on macOS
  }
}

function sanitizeDirName(name) {
  const clean = String(name ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "").replace(/^\.+/, "").trim();
  return clean || "imported-theme";
}

async function findThemeRoot(dir, depth = 0) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === "theme.json") return dir;
  }
  if (depth < 3) {
    for (const e of entries) {
      if (e.isDirectory()) {
        const hit = await findThemeRoot(path.join(dir, e.name), depth + 1);
        if (hit) return hit;
      }
    }
  }
  return null;
}

async function installThemeFromDir(srcDir, fallbackName) {
  const manifest = readJsonSafe(path.join(srcDir, "theme.json"));
  if (!manifest) throw new Error("theme.json not found in the archive - not a Dream Skin theme");
  const id = sanitizeDirName(manifest.id ?? fallbackName);
  const dest = path.join(THEMES_DIR, id);
  await fsp.mkdir(THEMES_DIR, { recursive: true });
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.cp(srcDir, dest, { recursive: true });
  writeJsonNoBom(path.join(dest, "theme.json"), manifest);
  return { id, name: String(manifest.name ?? id) };
}

function recordImport(rec) {
  const skin = readJsonSafe(SKIN_STATE) ?? {};
  skin.lastImport = { ...rec, at: new Date().toISOString() };
  writeJsonNoBom(SKIN_STATE, skin);
}

// Full import flow: native picker -> tar extract -> locate theme.json ->
// upsert into the theme store. Runs in a detached worker (`import-worker`
// subcommand) so the bridge pump never blocks on the modal dialog.
async function runImportFlow() {
  recordImport({ status: "pending" });
  let tmp = null;
  try {
    const zip = await pickZipViaDialog();
    if (!zip) {
      recordImport({ status: "canceled" });
      console.log("[codexskin] import canceled.");
      return;
    }
    tmp = await fsp.mkdtemp(path.join(HUB_ROOT, "import-"));
    await extractZip(zip, tmp);
    const root = await findThemeRoot(tmp);
    if (!root) throw new Error("theme.json not found in the archive - not a Dream Skin theme");
    const theme = await installThemeFromDir(root, path.basename(zip).replace(/\.zip$/i, ""));
    recordImport({ status: "ok", id: theme.id, name: theme.name, source: zip });
    console.log(`[codexskin] imported theme "${theme.name}" (${theme.id})`);
  } catch (e) {
    recordImport({ status: "error", error: String(e?.message ?? e) });
    console.error(`[codexskin] import failed: ${e?.message ?? e}`);
    process.exitCode = 1;
  } finally {
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function startImportWorker() {
  const node = fs.existsSync(NODE_EXE) ? NODE_EXE : process.execPath;
  const out = fs.openSync(IMPORT_LOG, "a");
  const err = fs.openSync(IMPORT_LOG, "a");
  try {
    const child = spawn(
      node,
      [path.join(import.meta.dirname, "cli.mjs"), "import-worker"],
      { detached: true, stdio: ["ignore", out, err], windowsHide: true },
    );
    child.unref();
    return { started: true };
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

// ---------------------------------------------------------------------------
// Renderer bridge: lets the CodexHost in-app settings page (Dream Skin tab)
// list/switch themes. The page pushes commands into window.__codexskinQueue,
// the supervisor drains it over CDP Runtime.evaluate and delivers results via
// window.__codexskin.deliver(). No extra processes or ports.
// ---------------------------------------------------------------------------

const DEBUG = process.env.CODEXSKIN_DEBUG === "1";

function httpJson(port, p) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: p, timeout: 2000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

class BrowserCdp {
  // Browser-level CDP session. Attaching with flatten:true per target lets us
  // evaluate inside pages WITHOUT taking the page's dedicated WebSocket -
  // so we never fight the Dream Skin injector or other CDP clients.
  constructor(browserId, port) {
    this.url = `ws://127.0.0.1:${port}/devtools/browser/${browserId}`;
    this.ws = new WebSocket(this.url);
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.ws.addEventListener("error", () => this.close());
    this.ws.addEventListener("close", () => this.close());
    this.ws.addEventListener("message", (event) => this.onMessage(event));
  }

  open() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { this.ws.close(); } catch { /* noop */ }
        reject(new Error("CDP browser socket open timed out"));
      }, 4000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP browser socket open failed")); }, { once: true });
    });
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message && message.id && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id);
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      waiter.resolve(message.error ? null : message.result ?? null);
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, 6000);
      this.pending.set(id, { resolve, timer });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try {
        this.ws.send(JSON.stringify(payload));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  async evaluateInTarget(targetId, expression) {
    const attached = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached?.sessionId;
    if (!sessionId) return null;
    try {
      const result = await this.send(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        sessionId,
      );
      return result?.result?.value ?? null;
    } finally {
      void this.send("Target.detachFromTarget", { sessionId });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.pending.clear();
    try { this.ws.close(); } catch { /* noop */ }
  }
}

async function bridgeStatus() {
  const ds = readJsonSafe(DS_STATE) ?? {};
  const endpoint = await discoverCdp();
  const { pid, port } = await liveInjectorPid();
  const active = readJsonSafe(path.join(THEME_DIR, "theme.json"));
  return {
    endpoint: endpoint ? { port: endpoint.port, browser: endpoint.browser } : null,
    injector: pid ? { pid, aligned: Boolean(endpoint && port === endpoint.port) } : null,
    activeTheme: active ? { id: String(active.id ?? ""), name: String(active.name ?? "") } : null,
    paused: fs.existsSync(PAUSE_FILE),
    supervisePid: Number(ds.injectorPid ?? 0) || undefined,
    themesDir: THEMES_DIR,
    galleryUrl: GALLERY_URL,
    lastImport: (readJsonSafe(SKIN_STATE) ?? {}).lastImport ?? null,
  };
}

async function handleBridgeCommand(action, payload) {
  if (action === "list") {
    const { activeId, entries } = await listThemes();
    return { activeId, entries };
  }
  if (action === "switch") {
    const theme = await applyTheme(String(payload?.id ?? payload?.query ?? ""));
    return { activeId: theme.id, name: theme.name };
  }
  if (action === "status") return bridgeStatus();
  if (action === "open-dir") return openThemesDir();
  if (action === "open-gallery") return openGallery(payload?.url);
  if (action === "import") return startImportWorker();
  throw new Error(`unknown bridge action: ${action}`);
}

async function pumpBridgeOnce(endpoint) {
  const browser = new BrowserCdp(endpoint.browserId, endpoint.port);
  try {
    await browser.open();
  } catch {
    return;
  }
  try {
    const tree = await browser.send("Target.getTargets");
    const targets = tree?.targetInfos ?? [];
    // NOTE: do NOT filter on targetInfo.attached - a dedicated DevTools client
    // on a page marks it "attached", but flatten-session attachToTarget still
    // works fine alongside it.
    const pages = targets.filter(
      (t) => t.type === "page" && String(t.url ?? "").startsWith("app://"),
    );
    if (DEBUG) console.log(`[codexskin:debug] pump tick port ${endpoint.port}: ${pages.length}/${targets.length} app pages`);
    for (const target of pages) {
      try {
        const raw = await browser.evaluateInTarget(
          target.targetId,
          "JSON.stringify((window.__codexskinQueue || (window.__codexskinQueue = [])).splice(0))",
        );
        if (DEBUG) console.log(`[codexskin:debug] raw=${String(raw).slice(0, 120)}`);
        let queue = [];
        try { queue = JSON.parse(raw ?? "[]"); } catch { queue = []; }
        for (const item of Array.isArray(queue) ? queue : []) {
          const id = Number(item?.id);
          if (!Number.isFinite(id)) continue;
          let error = null;
          let value = null;
          try {
            value = await handleBridgeCommand(String(item?.action ?? ""), item?.payload ?? null);
          } catch (e) {
            error = String(e?.message ?? e);
          }
          await browser.evaluateInTarget(
            target.targetId,
            `window.__codexskin && window.__codexskin.deliver(${JSON.stringify(id)}, ` +
            `${JSON.stringify(error)}, ${JSON.stringify(value ?? null)})`,
          );
        }
      } catch (e) {
        if (DEBUG) console.log(`[codexskin:debug] pump target error: ${e.message}`);
      }
    }
  } finally {
    browser.close();
  }
}

function startBridgeLoop({ log = () => {}, intervalMs = 1500 } = {}) {
  let busy = false;
  return setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const endpoint = await discoverCdp();
      if (endpoint) await pumpBridgeOnce(endpoint);
    } catch (e) {
      log(`[codexskin] bridge: ${e.message}`);
    } finally {
      busy = false;
    }
  }, intervalMs);
}

async function cmdSupervise() {
  assertEngine();
  const skin = readJsonSafe(SKIN_STATE) ?? {};
  if (skin.supervisePid && (await processAlive(skin.supervisePid))) {
    console.log(`[codexskin] supervisor already running (pid ${skin.supervisePid}).`);
    return;
  }
  const skinNow = { ...skin, supervisePid: process.pid, superviseStartedAt: new Date().toISOString() };
  writeJsonNoBom(SKIN_STATE, skinNow);
  const logStream = fs.createWriteStream(path.join(HUB_ROOT, "codexskin-supervise.log"), { flags: "a" });
  const origLog = console.log;
  console.log = (...a) => {
    logStream.write(a.join(" ") + "\n");
    origLog(...a);
  };
  console.log(`[codexskin] supervisor started (pid ${process.pid}).`);
  const timer = startSupervisorLoop({ log: (...a) => console.log(...a) });
  // NOTE: do NOT unref these intervals - they are what keeps this daemon alive.
  const bridge = startBridgeLoop({ log: (...a) => console.log(...a) });
  const heartbeat = setInterval(() => {
    const s = readJsonSafe(SKIN_STATE);
    if (s && Number(s.supervisePid) === process.pid) return;
    origLog("[codexskin] supervise pid removed from state; exiting.");
    process.exit(0);
  }, 15000);
  void timer;
  void bridge;
  void heartbeat;
}

async function stopSupervisor() {
  const skin = readJsonSafe(SKIN_STATE) ?? {};
  const pid = Number(skin.supervisePid);
  if (pid && (await processAlive(pid))) {
    await plat.killTree(pid, execFileText);
    console.log(`[codexskin] stopped supervisor (pid ${pid})`);
  }
  const skinNow = { ...skin, supervisePid: 0 };
  writeJsonNoBom(SKIN_STATE, skinNow);
}

async function cmdStart(argv) {
  assertEngine();
  let theme = null;
  let background = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--theme" || argv[i] === "-t") theme = argv[++i] ?? die("--theme needs a value");
    else if (argv[i] === "--background" || argv[i] === "-b") background = true;
    else die(`unknown argument: ${argv[i]} (supported: --theme <name>, --background)`);
  }
  if (theme) await switchTheme(theme);

  if (background) {
    // Detached launch: the child survives the closing terminal. The supervisor
    // daemon is NOT spawned here on purpose - the patched codexhost hook
    // (superviseDetached) already self-heals it right after launch, and
    // spawning a second one here would race it over the state file.
    console.log("[codexskin] starting codexhost in the background ...");
    const app = spawnCodexhost({ detached: true, stdio: "ignore", windowsHide: true });
    app.unref();
    writeJsonNoBom(SKIN_STATE, {
      ...(readJsonSafe(SKIN_STATE) ?? {}),
      codexHostPid: app.pid,
      startedAt: new Date().toISOString(),
    });
    // Wait for the hook's supervisor to claim the state file (app boot can
    // take ~30s), with an idempotent fallback spawn if the hook never fires
    // (e.g. older codexhost or a failed detached spawn).
    let supPid = 0;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const s = readJsonSafe(SKIN_STATE) ?? {};
      supPid = Number(s.supervisePid) || 0;
      if (supPid && (await processAlive(supPid))) break;
      if (i === 59) {
        const fb = spawn(process.execPath, [fileURLToPath(import.meta.url), "supervise"], {
          detached: true, stdio: "ignore", windowsHide: true,
        });
        fb.unref();
        await new Promise((r) => setTimeout(r, 1500));
        supPid = Number((readJsonSafe(SKIN_STATE) ?? {}).supervisePid) || 0;
      }
    }
    if (supPid && (await processAlive(supPid))) {
      console.log("[codexskin] background mode active:");
      console.log(`  codexhost  pid ${app.pid}`);
      console.log(`  supervisor pid ${supPid} (logs: ${path.join(HUB_ROOT, "codexskin-supervise.log")})`);
      console.log("  safe to close this terminal. Use `codexskin down` to stop, `codexskin status` to inspect.");
    } else {
      console.log(`[codexskin] codexhost detached (pid ${app.pid}) but no supervisor detected yet.`);
      console.log("  If the endpoint never aligns, run `codexskin status` / `codexskin inject`.");
    }
    return;
  }

  console.log("[codexskin] starting codexhost (foreground)...");
  const child = spawnCodexhost({ stdio: "inherit", windowsHide: false });
  writeJsonNoBom(SKIN_STATE, {
    ...(readJsonSafe(SKIN_STATE) ?? {}),
    codexHostPid: child.pid,
    startedAt: new Date().toISOString(),
  });

  const supervisor = startSupervisorLoop({ log: (m) => console.log(m) });
  supervisor.unref?.();
  const bridge = startBridgeLoop({ log: (m) => console.log(m) });
  bridge.unref?.();

  child.on("exit", (code) => {
    clearInterval(supervisor);
    clearInterval(bridge);
    console.log(`[codexskin] codexhost exited (code ${code}).`);
    if (code === 1) {
      console.log("  If the output above shows an AppX error (e.g. 0x80070490 / element not found),");
      console.log("  run `codexskin repair` to fix the Codex Desktop registration, then start again.");
    }
    process.exit(code ?? 0);
  });
  process.on("SIGINT", () => {
    console.log("\n[codexskin] stopping codexhost...");
    plat.killTree(child.pid, execFileText).then(() => process.exit(0), () => process.exit(0));
  });
}

async function cmdTheme(argv) {
  if (argv.length > 0) {
    await switchTheme(argv[0]);
    return;
  }
  const { activeId, entries } = await listThemes();
  if (entries.length === 0) {
    console.log(`[codexskin] no themes in ${THEMES_DIR}`);
    return;
  }
  console.log("[codexskin] available themes:");
  for (const t of entries) {
    const mark = t.id === activeId ? " <- active" : "";
    console.log(`  ${t.id.padEnd(45)} ${t.name}${mark}`);
  }
  console.log('[codexskin] switch with:  codexskin theme <name-or-id>');
}

async function cmdStatus() {
  const ds = readJsonSafe(DS_STATE) ?? {};
  const endpoint = await discoverCdp();
  const { pid } = await liveInjectorPid();
  const active = readJsonSafe(path.join(THEME_DIR, "theme.json"));
  const skin = readJsonSafe(SKIN_STATE) ?? {};
  console.log("[codexskin] status");
  console.log(`  codexhost pid   : ${skin.codexHostPid ?? "-"}${(await processAlive(skin.codexHostPid)) ? " (running)" : ""}`);
  console.log(`  codex endpoint  : ${endpoint ? `port ${endpoint.port} (${endpoint.browser})` : "not running"}`);
  console.log(`  injector        : ${pid ? `pid ${pid}` : "not running"}${endpoint && pid && Number(ds.port) === endpoint.port ? " (aligned)" : endpoint && pid ? " (MISALIGNED)" : ""}`);
  console.log(`  active theme    : ${active ? `${active.name} (${active.id})` : "unknown"}`);
}

async function cmdDown() {
  await stopSupervisor();
  const skin = readJsonSafe(SKIN_STATE) ?? {};
  if (skin.codexHostPid && (await processAlive(skin.codexHostPid))) {
    await plat.killTree(skin.codexHostPid, execFileText);
    console.log(`[codexskin] stopped codexhost (pid ${skin.codexHostPid})`);
  }
  await stopInjector();
  console.log("[codexskin] done. Codex Desktop itself is left running.");
}

// Repair Codex Desktop AppX state after a failed launcher activation. The
// codexhost launcher activates the packaged app via IPackageDebugSettings; on
// some machines DisableDebugging fails with 0x80070490 (element not found) -
// typically broken per-user package registration or a crashed first launch
// that left stale cua_node staging dirs behind. Both are fixable from here.
function psRun(script, timeoutMs = 180000) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: timeoutMs },
      (err, stdout, stderr) => resolve({ err, out: String(stdout ?? ""), errText: String(stderr ?? "") }),
    );
  });
}

async function cmdRepair() {
  assertEngine();
  if (process.platform !== "win32") die("repair is only needed on Windows");

  console.log("[codexskin] repair - checking Codex Desktop AppX registration ...");
  const info = await psRun(
    "Get-AppxPackage OpenAI.Codex* | Select-Object Name, Version, PackageFullName, Status | Format-List",
  );
  const pkgText = info.out.trim();
  console.log(pkgText ? pkgText.split("\n").map((l) => `  ${l.trim()}`).filter(Boolean).join("\n") : "  (no OpenAI.Codex package visible to the current user)");
  if (!pkgText) {
    console.log("[codexskin] Codex Desktop is NOT registered for the current user.");
    console.log("  Install it from the Microsoft Store (or `winget install msstore:OpenAI.Codex`),");
    console.log("  launch it once, quit it, then re-run `codexskin repair`.");
    process.exit(1);
  }

  console.log("[codexskin] re-registering the package for the current user ...");
  const rereg = await psRun(
    'Get-AppxPackage OpenAI.Codex* | ForEach-Object { Add-AppxPackage -DisableDevelopmentMode -Register "$($_.InstallLocation)\\AppxManifest.xml" -ErrorAction Continue; "  re-registered: $($_.PackageFullName)" }',
  );
  const reregText = (rereg.out + rereg.errText).trim();
  // PowerShell writes errors in the console OEM encoding (garbled here); show
  // only ASCII lines and surface known HRESULTs as friendly hints instead.
  const asciiLines = reregText.split("\n").filter((l) => /^[\x20-\x7E\r]*$/.test(l) && l.trim());
  console.log(asciiLines.join("\n") || "  (no output from re-registration)");
  if (/0x80073D02/i.test(reregText)) {
    console.log("  -> Codex Desktop (or its background process) is still running.");
    console.log("     Quit it completely (tray icon too), then re-run `codexskin repair`.");
  } else if (/0x80073CF0|0x80070490/i.test(reregText)) {
    console.log("  -> re-registration still failing; reboot the machine and re-run `codexskin repair`.");
  }

  console.log("[codexskin] cleaning stale cua_node staging dirs ...");
  const stagingRoot = path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "runtimes", "cua_node");
  let removed = 0;
  try {
    for (const entry of await fsp.readdir(stagingRoot)) {
      if (!entry.startsWith(".staging-")) continue;
      await fsp.rm(path.join(stagingRoot, entry), { recursive: true, force: true });
      console.log(`  removed stale staging dir: ${entry}`);
      removed += 1;
    }
  } catch {
    console.log("  no cua_node runtime dir yet (normal on a fresh install)");
  }
  if (!removed) console.log("  no stale staging dirs found");

  console.log("[codexskin] repair finished. Now try `codexskin start` again.");
  console.log("  If it still exits with an AppX error: launch Codex Desktop once manually");
  console.log("  from the Start menu, let it fully load, quit it completely, and retry.");
}

async function cmdDoctor() {
  console.log("[codexskin] doctor");
  const check = (label, ok, detail = "") =>
    console.log(`  ${ok ? "OK  " : "MISS"} ${label}${detail ? ` - ${detail}` : ""}`);
  check("hub root", fs.existsSync(HUB_ROOT), HUB_ROOT);
  check("engine node", NODE_EXE !== process.execPath, NODE_EXE);
  check("injector", fs.existsSync(INJECTOR), INJECTOR);
  check("theme library", fs.existsSync(THEMES_DIR), THEMES_DIR);
  check("active theme dir", fs.existsSync(THEME_DIR), THEME_DIR);
  const { entries } = await listThemes();
  console.log(`  ${entries.length} theme(s) installed`);
  const shim = plat.shimPath();
  check("codexskin shim", fs.existsSync(shim), shim);
  const skin = readJsonSafe(SKIN_STATE) ?? {};
  const supPid = skin.supervisePid ?? skin.injectorPid;
  const supAlive = supPid ? await processAlive(supPid) : false;
  check("supervisor", supAlive, supPid ? `pid ${supPid}` : "not running");
  // Patch status of the installed codexhost package.
  const patcher = path.join(import.meta.dirname, "patch.mjs");
  const node = fs.existsSync(NODE_EXE) ? NODE_EXE : process.execPath;
  const r = spawnSync(node, [patcher, "status"], { encoding: "utf8", windowsHide: true });
  for (const line of String(r.stdout ?? "").split(/\r?\n/)) if (line.trim()) console.log(`  ${line.trim()}`);
}

// ---------- setup wizard: bootstrap missing prerequisites ----------

const DS_REPO_API = "https://api.github.com/repos/Fei-Away/Codex-Dream-Skin/releases/latest";

function proxyArgs() {
  const p = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? "";
  return p ? ["-x", p] : [];
}

function curlJson(url) {
  const r = spawnSync(plat.isWindows() ? "curl.exe" : "curl", ["-sSLf", "--max-time", "30", ...proxyArgs(), url], {
    encoding: "utf8", windowsHide: true, shell: false,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function downloadFile(url, dest, label) {
  console.log(`[codexskin] downloading ${label} ...`);
  const r = spawnSync(plat.isWindows() ? "curl.exe" : "curl", ["-L", "-f", "--retry", "2", "--max-time", "600", "-o", dest, ...proxyArgs(), url], {
    stdio: "inherit", windowsHide: true, shell: false,
  });
  return r.status === 0 && fs.existsSync(dest);
}

function detectCodexDesktop() {
  if (plat.isWindows()) {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "(Get-AppxPackage -Name 'OpenAI.Codex*').InstallLocation"],
      { encoding: "utf8", windowsHide: true, shell: false },
    );
    const loc = String(r.stdout ?? "").trim().split(/\r?\n/)[0];
    return loc && r.status === 0 ? loc : null;
  }
  // macOS: the desktop app is an ordinary /Applications bundle.
  for (const app of ["/Applications/Codex.app", "/Applications/ChatGPT.app"]) {
    if (fs.existsSync(app)) return app;
  }
  return null;
}

function detectCodexhost() {
  return findCodexhostPackage() !== null;
}

function detectDsEngine() {
  return fs.existsSync(path.join(DS_ROOT, "engine", "scripts", "injector.mjs"));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(`[codexskin] ${question}`, (a) => { rl.close(); resolve(a.trim()); }),
  );
}

async function cmdSetup(flags = {}) {
  const dry = flags.has("dry-run");
  const assumeYes = flags.has("yes");
  const isWin = plat.isWindows();
  console.log("[codexskin] setup - bootstrap prerequisites (Codex Desktop / codexhost / Dream Skin)");
  if (plat.IS_LINUX && !process.env.CODEXSKIN_ALLOW_NON_WIN32) {
    die("setup: Linux is not supported - the upstream Dream Skin engine has no Linux build");
  }

  // 1. Codex Desktop. Windows: MSIX via winget / Microsoft Store. macOS: an
  // /Applications bundle installed by the user from OpenAI's site.
  let desktop = detectCodexDesktop();
  if (desktop) {
    console.log(`  OK   Codex Desktop - ${desktop}`);
  } else if (dry) {
    console.log("  MISS Codex Desktop (would open the store / download page and guide installation)");
  } else if (isWin) {
    console.log("  MISS Codex Desktop - attempting winget / Microsoft Store ...");
    const w = spawnSync("winget", ["search", "OpenAI Codex", "--source", "msstore"], {
      encoding: "utf8", windowsHide: true, shell: true,
    });
    const hit = String(w.stdout ?? "").split(/\r?\n/).find((l) => /openai/i.test(l) && /codex|chatgpt/i.test(l));
    if (hit) {
      const id = hit.trim().split(/\s{2,}/)[0];
      console.log(`  -> winget install ${id} (msstore)`);
      spawnSync("winget", ["install", "--id", id, "--source", "msstore", "--accept-package-agreements", "--accept-source-agreements"], {
        stdio: "inherit", windowsHide: true, shell: true,
      });
      desktop = detectCodexDesktop();
    }
    for (let i = 0; !desktop && i < 3; i++) {
      plat.openUrl("ms-windows-store://search/?query=OpenAI%20Codex");
      await ask("Microsoft Store opened. Install \"Codex\" (or ChatGPT) there, launch it once, quit it, then press Enter to re-check ...");
      desktop = detectCodexDesktop();
    }
    console.log(desktop ? `  OK   Codex Desktop - ${desktop}` : "  MISS Codex Desktop still missing - codexhost cannot launch without it");
  } else {
    console.log("  MISS Codex Desktop - opening the OpenAI download page ...");
    plat.openUrl("https://chatgpt.com/download");
    for (let i = 0; !desktop && i < 3; i++) {
      await ask("Install the Codex / ChatGPT desktop app (drag to /Applications), launch it once, quit it, then press Enter to re-check ...");
      desktop = detectCodexDesktop();
    }
    console.log(desktop ? `  OK   Codex Desktop - ${desktop}` : "  MISS Codex Desktop still missing - codexhost cannot launch without it");
  }

  // 2. @codexhost/cli (npm global).
  if (detectCodexhost()) {
    console.log("  OK   @codexhost/cli");
  } else if (dry) {
    console.log("  MISS @codexhost/cli (would run: npm install -g @codexhost/cli)");
  } else {
    console.log("  -> npm install -g @codexhost/cli ...");
    spawnSync("npm", ["install", "-g", "@codexhost/cli", "--registry=https://registry.npmjs.org/"], {
      stdio: "inherit", windowsHide: true, shell: true,
    });
    console.log(detectCodexhost() ? "  OK   @codexhost/cli" : "  MISS @codexhost/cli install failed - check network / proxy and re-run setup");
  }

  // 3. Codex Dream Skin engine (GitHub release; Inno Setup .exe on Windows,
  // .dmg on macOS).
  if (detectDsEngine()) {
    console.log(`  OK   Dream Skin engine - ${DS_ROOT}`);
  } else if (dry) {
    console.log("  MISS Dream Skin engine (would download the latest installer from GitHub Releases)");
  } else {
    console.log("  -> fetching latest Codex Dream Skin release ...");
    const rel = curlJson(DS_REPO_API);
    const asset = rel?.assets?.find((a) =>
      isWin ? /^CodexDreamSkin-Setup-.*\.exe$/i.test(a.name) : /^CodexDreamSkin-v\d.*\.dmg$/i.test(a.name),
    );
    if (!asset) {
      console.log(`  MISS could not resolve a ${isWin ? "Windows" : "macOS"} installer from GitHub Releases - open https://github.com/Fei-Away/Codex-Dream-Skin/releases manually`);
    } else {
      const dest = path.join(plat.isWindows() ? (process.env.TEMP ?? HUB_ROOT) : "/tmp", asset.name);
      console.log(`  -> ${asset.name} (${Math.round((asset.size ?? 0) / 1048576)} MB, tag ${rel.tag_name ?? "?"})`);
      const ok = assumeYes || (await ask(`Download and run the Dream Skin installer? [Y/n] `)).match(/^n/i) === null;
      if (!ok) {
        console.log("  skipped Dream Skin installer");
      } else if (downloadFile(asset.browser_download_url, dest, asset.name) && fs.existsSync(dest)) {
        if (isWin) {
          console.log("  -> launching installer (close Codex first if it is running) ...");
          const inst = spawnSync(dest, assumeYes ? ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"] : [], {
            stdio: assumeYes ? "ignore" : "inherit", windowsHide: false, shell: false,
          });
          if (assumeYes && inst.status !== 0) console.log(`  installer exited with status ${inst.status}`);
        } else {
          console.log("  -> mounting the .dmg - drag the app / engine into Applications when it opens ...");
          plat.openPath(dest);
          await ask("Finish the Dream Skin installation, then press Enter to re-check ...");
        }
        if (detectDsEngine()) console.log(`  OK   Dream Skin engine - ${DS_ROOT}`);
        else console.log("  MISS engine not detected yet - finish the installer, then re-run `codexskin setup`");
      } else {
        console.log("  MISS download failed - check network / proxy and re-run setup");
      }
    }
  }

  // 4. Wire the integration (runtime copy + patches + shim), then doctor.
  if (dry) {
    console.log("  (dry-run: integration install + doctor skipped)");
    return;
  }
  const candidates = [
    path.join(HUB_ROOT, "install.mjs"),
    path.join(fileURLToPath(path.dirname(import.meta.url)), "..", "install.mjs"),
  ];
  const installer = candidates.find((p) => fs.existsSync(p));
  if (installer) {
    console.log(`  -> applying integration (${installer}) ...`);
    spawnSync(process.execPath, [installer], { stdio: "inherit", windowsHide: true });
  } else {
    console.log("  MISS install.mjs not found - re-run `npm install -g codexskin-hub` to apply the integration");
  }
  console.log("");
  await cmdDoctor();
}

// Exported for testing / tooling; importing this module has no side effects
// (the CLI only runs when the file is invoked directly).
export {
  listThemes,
  applyTheme,
  openThemesDir,
  openGallery,
  pickZipViaDialog,
  findThemeRoot,
  installThemeFromDir,
  runImportFlow,
  handleBridgeCommand,
  bridgeStatus,
};

// CLI dispatch - only when executed directly (importable as a library otherwise).
import { pathToFileURL } from "node:url";
// Resolve BOTH sides through the filesystem before comparing: on nvm-windows
// process.argv[1] reaches the entry through a symlinked prefix dir (e.g.
// D:\nvm4w\nodejs\...) while import.meta.url is the realpath (Node resolves
// the entry module), so a plain URL compare fails and the CLI silently did
// nothing with exit code 0 (issue #1).
const invokedDirectly = process.argv[1] && (() => {
  try {
    return fs.realpathSync(path.resolve(process.argv[1]))
        === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (invokedDirectly) {
  const [cmd = "start", ...rest] = process.argv.slice(2);
  try {
    if (cmd === "start") await cmdStart(rest);
    else if (cmd === "supervise") await cmdSupervise();
    else if (cmd === "stop-supervise") await stopSupervisor();
    else if (cmd === "theme") await cmdTheme(rest);
    else if (cmd === "list") await cmdTheme([]);
    else if (cmd === "status") await cmdStatus();
    else if (cmd === "inject") await cmdInject();
    else if (cmd === "down") await cmdDown();
    else if (cmd === "dir" || cmd === "open-dir") await openThemesDir();
    else if (cmd === "gallery") await openGallery(GALLERY_URL);
    else if (cmd === "import") await runImportFlow();
    else if (cmd === "import-worker") await runImportFlow();
    else if (cmd === "doctor") await cmdDoctor();
    else if (cmd === "repair") await cmdRepair();
    else if (cmd === "setup") await cmdSetup(new Set(rest.map((a) => a.replace(/^--+/, ""))));
    else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
      console.log("codexskin - codexhost + Codex Dream Skin fusion CLI");
      console.log("  codexskin setup [--yes] [--dry-run] bootstrap missing prerequisites (Codex Desktop, @codexhost/cli, Dream Skin engine) and wire the integration");
      console.log("  codexskin start [--theme <name>] [--background|-b]  start codexhost + injection supervisor (--background detaches, safe to close the terminal)");
      console.log("  codexskin supervise                standalone injector supervisor (used by codexhost hook)");
      console.log("  codexskin theme [<name>]           switch theme live / list themes");
      console.log("  codexskin import                   pick a theme ZIP and install it into the store");
      console.log("  codexskin dir                      open the theme store folder in Explorer");
      console.log("  codexskin gallery                  open dreamskin.cc/gallery in the browser");
      console.log("  codexskin status                   show endpoint / injector / theme state");
      console.log("  codexskin inject                   align injector to the running Codex once");
      console.log("  codexskin doctor                   health-check the whole integration");
      console.log("  codexskin repair                   fix Codex Desktop AppX state after a failed launch");
      console.log("  codexskin setup                    bootstrap prerequisites + wire the integration");
      console.log("  codexskin down                     stop supervisor, codexhost wrapper and injector");
    } else die(`unknown command: ${cmd}. Try "codexskin help".`);
  } catch (e) {
    die(e.message);
  }
}
