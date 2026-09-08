// Probe: verify the bridge answers with current code (status action).
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(process.env.LOCALAPPDATA + "/CodexDreamSkin/state.json", "utf8"));
(async () => {
  const list = await (await fetch("http://127.0.0.1:" + state.port + "/json/list")).json();
  const t = list.find((t) => t.url === "app://-/index.html") ?? list.find((t) => String(t.url).startsWith("app://-/index.html") && !String(t.url).includes("initialRoute"));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  let seq = 0; const pend = new Map();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const expr = 'window.__codexskin.request("status").then(s => JSON.stringify({endpoint: s.endpoint && s.endpoint.port, injector: s.injector && s.injector.aligned, themes: (s.themes||[]).length})).catch(e => "ERR:" + e.message)';
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const exc = r.result?.exceptionDetails;
  console.log("status:", JSON.stringify(r.result?.result?.value));
  if (exc) console.log("exception:", JSON.stringify(exc).slice(0, 400));
  ws.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
