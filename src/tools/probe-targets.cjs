// Probe: report per-target injection state with exception details.
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(process.env.LOCALAPPDATA + "/CodexDreamSkin/state.json", "utf8"));
(async () => {
  const list = await (await fetch("http://127.0.0.1:" + state.port + "/json/list")).json();
  const targets = list.filter((t) => String(t.url).startsWith("app://"));
  console.log("app:// targets:", targets.length);
  for (const t of targets) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    let seq = 0; const pend = new Map();
    ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    const r = await send("Runtime.evaluate", {
      expression: 'JSON.stringify({ cs: typeof window.__codexskin, wrap: document.querySelectorAll(".ds-wrap").length })',
      returnByValue: true,
    });
    const v = r.result?.result?.value;
    const ex = r.result?.exceptionDetails ? " EXC:" + (r.result.exceptionDetails.text ?? "") : "";
    console.log(String(t.url).slice(0, 60), "->", v ?? "null", ex);
    ws.close();
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
