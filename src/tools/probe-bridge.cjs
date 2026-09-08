// Probe via page-level CDP endpoints (same as desktop-controller).
(async () => {
  const list = await (await fetch('http://127.0.0.1:' + JSON.parse(require('fs').readFileSync(process.env.LOCALAPPDATA + '/CodexDreamSkin/state.json', 'utf8')).port + '/json/list')).json();
  for (const t of list.filter((t) => String(t.url).startsWith('app://'))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let seq = 0; const pend = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    const expr = `JSON.stringify({ codexskin: typeof window.__codexskin, q: Array.isArray(window.__codexskinQueue) ? window.__codexskinQueue.length : -1, shell: typeof window.__codexhostSettingsShellV1, dsWrap: document.querySelectorAll(".ds-wrap").length })`;
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    console.log(String(t.url).slice(0, 50), '->', JSON.stringify(r).slice(0, 300));
    ws.close();
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
