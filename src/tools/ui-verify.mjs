// UI verify driver: opens the codexhost settings dialog on the Dream Skin
// page over browser-level CDP (flatten session) and takes a screenshot.
// Usage: node ui-verify.mjs <screenshot-out-path>
import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";

const OUT = process.argv[2] ?? "C:/Users/Administrator/WorkBuddy/2026-09-07-09-36-06/_settings_ui_new.png";
const DS = "C:/Users/Administrator/AppData/Local/CodexDreamSkin";

const execText = (cmd, args) =>
  new Promise((r) => execFile(cmd, args, { windowsHide: true, maxBuffer: 8 << 20 }, (e, o) => r(e ? "" : String(o))));

async function discoverPort() {
  // fast path: state.json
  try {
    const st = JSON.parse(await fsp.readFile(path.join(DS, "state.json"), "utf8"));
    if (st.port) {
      const ok = await fetch(`http://127.0.0.1:${st.port}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
      if (ok) return st.port;
    }
  } catch { /* fallthrough */ }
  // slow path: netstat scan for ChatGPT.exe pids
  const pids = new Set();
  const tl = await execText(path.join(process.env.SystemRoot ?? "C:\\windows", "System32", "tasklist.exe"), ["/FI", "IMAGENAME eq ChatGPT.exe", "/FO", "CSV", "/NH"]);
  for (const m of tl.matchAll(/"ChatGPT\.exe","(\d+)"/g)) pids.add(m[1]);
  const ns = await execText(path.join(process.env.SystemRoot ?? "C:\\windows", "System32", "netstat.exe"), ["-ano", "-p", "TCP"]);
  for (const line of ns.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[3] !== "LISTENING") continue;
    const pid = cols[4];
    if (!pids.has(pid)) continue;
    const port = Number(cols[1].split(":").pop());
    if (!port || port < 1024 || port > 65535) continue;
    const ok = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) }).then((r) => r.ok).catch(() => false);
    if (ok) return port;
  }
  throw new Error("no Codex CDP endpoint found");
}
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor() { this.seq = 0; this.pending = new Map(); this.sessions = new Map(); }
  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", () => reject(new Error("ws error")));
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        } else if (msg.method) {
          // ignore events
        }
      });
      ws.addEventListener("close", () => { for (const p of this.pending.values()) p.reject(new Error("ws closed")); });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 15000);
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

const port = await discoverPort();
console.log("CDP port:", port);
const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const cdp = new Cdp();
await cdp.connect(ver.webSocketDebuggerUrl);

const tree = await cdp.send("Target.getTargets");
const pages = (tree.targetInfos ?? []).filter((t) => t.type === "page" && String(t.url).startsWith("app://"));
if (pages.length === 0) throw new Error("no app:// page target");
console.log("app pages:", pages.map((p) => p.url.slice(0, 60)));

let sessionId = null;
let page = null;
for (const t of pages) {
  const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const has = await cdp
    .send("Runtime.evaluate", { expression: "typeof window.__codexhostSettingsShellV1?.openSettings", returnByValue: true }, sid)
    .then((r) => r.result?.value)
    .catch(() => "error");
  console.log(`  ${t.url.slice(0, 60)} -> shellV1=${has}`);
  if (has === "function") { sessionId = sid; page = t; break; }
  await cdp.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
}
if (!sessionId) throw new Error("no app:// page exposing __codexhostSettingsShellV1");
console.log("page:", page.url.slice(0, 60));

const evalIn = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  return r.result?.value;
};

// sanity: new payload present?
console.log("new UI present:", await evalIn(`String(document.querySelectorAll(".ds-wrap").length >= 0) + " bridge=" + typeof window.__codexskin + " shellV1=" + typeof window.__codexhostSettingsShellV1?.openSettings`));

// open settings on the dreamskin page
await evalIn(`window.__codexhostSettingsShellV1.openSettings(document.body, "dreamskin")`);
await sleep(3000); // let bridge pump list/status

// probe rendered content
const probe = await evalIn(`JSON.stringify({
  chips: document.querySelectorAll(".ds-chip").length,
  cards: document.querySelectorAll(".ds-card").length,
  activeBadge: document.querySelectorAll(".ds-active-badge").length,
  buttons: [...document.querySelectorAll(".ds-btn")].map((b) => b.textContent.trim()),
  gallery: Boolean(document.querySelector(".ds-gallery")),
  notice: document.querySelector(".ds-notice")?.textContent ?? null,
})`);
console.log("render probe:", probe);

// exercise a new bridge action end-to-end (status carries lastImport/themesDir now)
const status = await evalIn(`window.__codexskin.request("status").then((s) => JSON.stringify({ themesDir: s.themesDir, galleryUrl: s.galleryUrl, lastImport: s.lastImport }))`);
console.log("bridge status:", status);

const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
await fsp.writeFile(OUT, Buffer.from(shot.data, "base64"));
console.log("screenshot saved:", OUT);
cdp.close();
