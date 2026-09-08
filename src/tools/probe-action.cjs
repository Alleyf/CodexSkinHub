// Probe: call an arbitrary bridge action via page-level CDP and print the
// returned value. Usage: node probe-action.cjs <action> [jsonPayload]
const fs = require("fs");
const action = process.argv[2] || "status";
const payload = process.argv[3] ? JSON.parse(process.argv[3]) : null;
const state = JSON.parse(fs.readFileSync(process.env.LOCALAPPDATA + "/CodexDreamSkin/state.json", "utf8"));
(async () => {
  const list = await (await fetch("http://127.0.0.1:" + state.port + "/json/list")).json();
  // main page: exact app://-/index.html, skip the avatar-overlay target
  const t = list.find((t) => String(t.url) === "app://-/index.html");
  if (!t) { console.log("ERR no main app target"); process.exit(1); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let seq = 0; const pend = new Map();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const expr = `window.__codexskin.request(${JSON.stringify(action)}, ${JSON.stringify(payload)}).then(r => JSON.stringify(r)).catch(e => "ERR:" + e.message)`;
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  console.log("result:", JSON.stringify(r.result?.result?.value));
  ws.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
