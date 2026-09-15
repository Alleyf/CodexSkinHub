// Read the current notice text from every injected settings-page instance.
// Used to tell "one page flickering" from "several windows each showing a
// different stale message".
const fs = require("node:fs");

const state = JSON.parse(
  fs.readFileSync(process.env.LOCALAPPDATA + "/CodexDreamSkin/state.json", "utf8"),
);

const EXPR = `(() => {
  const ns = Array.from(document.querySelectorAll('.ds-notice'));
  const visible = ns.filter((n) => !n.hidden);
  return JSON.stringify({
    bridge: typeof window.__codexskin,
    noticeCount: ns.length,
    texts: visible.map((n) => (n.textContent || '').slice(0, 120)),
    themes: Array.from(document.querySelectorAll('.ds-id')).map((e) => (e.textContent || '')).slice(0, 10),
  });
})()`;

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${state.port}/json/list`)).json();
  const targets = list.filter((t) => String(t.url).startsWith("app://"));
  console.log(`app:// targets: ${targets.length} (endpoint ${state.port})`);
  for (const t of targets) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", rej);
    });
    let seq = 0;
    const pend = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) {
        pend.get(m.id)(m);
        pend.delete(m.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((res) => {
        const id = ++seq;
        pend.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const r = await send("Runtime.evaluate", { expression: EXPR, returnByValue: true });
    console.log(
      `${String(t.url).slice(0, 40).padEnd(42)} -> ${String(r.result?.result?.value).slice(0, 300)}`,
    );
    ws.close();
  }
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
