  // [codexskin] Dream Skin theme page (bridge to the codexskin supervisor)
  window.__codexskinQueue = window.__codexskinQueue || [];
  if (!window.__codexskin) {
    window.__codexskin = {
      seq: 0,
      pending: /* @__PURE__ */ new Map(),
      request(action, payload) {
        const bridge = window.__codexskin; // avoid relying on `this` (pollution-proof)
        return new Promise((resolve, reject) => {
          const id = ++bridge.seq;
          const timer = setTimeout(() => {
            if (bridge.pending.delete(id)) reject(new Error("Dream Skin bridge timeout - is the codexskin supervisor running?"));
          }, 2e4);
          bridge.pending.set(id, { resolve, reject, timer });
          window.__codexskinQueue.push({ id, action, payload: payload ?? null });
        });
      },
      deliver(id, error, value) {
        const bridge = window.__codexskin; // avoid relying on `this` (pollution-proof)
        const waiter = bridge.pending.get(id);
        if (!waiter) return;
        bridge.pending.delete(id);
        clearTimeout(waiter.timer);
        if (error) waiter.reject(new Error(String(error)));
        else waiter.resolve(value);
      }
    };
  }
  const CODEXSKIN_GALLERY_URL = "https://dreamskin.cc/gallery";
  const CODEXSKIN_REPO_URL = "https://github.com/Alleyf/CodexSkinHub";
  const CODEXSKIN_UPDATE_CMD = "npm i -g codexskin-hub@latest";
  function codexskinEl(document2, tag, className, text) {
    const element = document2.createElement(tag);
    if (className) element.className = className;
    if (text !== void 0) element.textContent = text;
    return element;
  }
  function codexskinSvg(document2, name) {
    const icons = {
      folder: '<path d="M1.5 3.5h4.2l1.5 2h7.3v7.5h-13z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
      zip: '<path d="M8 1.8v6.7m0 0L4.9 5.4M8 8.5l3.1-3.1M2.2 12.7h11.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
      external: '<path d="M6.8 2.6H2.6v10.8h10.8V9.2M9.4 2h4.6v4.6M13.6 2.4 7.6 8.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
      check: '<path d="M2.8 8.6l3.4 3.4 7-8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
      palette: '<path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.6-.7 1.6-1.5 0-1.5 1.2-1.7 2.4-1.7 1.4 0 2.2-1 2.2-2.4A6.2 6.2 0 0 0 8 1.8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.1" cy="6.3" r="1" fill="currentColor"/><circle cx="8" cy="4.7" r="1" fill="currentColor"/><circle cx="10.9" cy="6.3" r="1" fill="currentColor"/>',
      spark: '<path d="M8 1.8l1.5 4.7L14.2 8l-4.7 1.5L8 14.2 6.5 9.5 1.8 8l4.7-1.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
      refresh: '<path d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9M13.5 1.9v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
      copy: '<rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.6 5.4V3.9a1.5 1.5 0 0 0-1.5-1.5H3.9a1.5 1.5 0 0 0-1.5 1.5v5.2a1.5 1.5 0 0 0 1.5 1.5h1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
      doc: '<path d="M4 1.8h5.2L12.8 5.2v9H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 2v3.4h3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.8 8.4h4.4M5.8 10.8h4.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
      restart: '<path d="M13.2 8.6a5.4 5.4 0 1 1-1.2-4.3M13.5 1.9v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
      star: '<path d="M8 1.6l2 4 4.4.6-3.2 3.1.8 4.4L8 11.6l-4 2.1.8-4.4-3.2-3.1 4.4-.6z" fill="currentColor"/>'
    };
    const svg = document2.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = icons[name] ?? "";
    return svg;
  }
  var CODEXSKIN_PAGE_CSS = `
.ds-wrap { display: flex; flex-direction: column; gap: 16px; }
.ds-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.ds-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 11px; border-radius: 999px; border: 1px solid var(--settings-border); background: var(--settings-hover); color: var(--settings-muted); font-size: 12px; line-height: 1.6; white-space: nowrap; }
.ds-chip svg { flex: none; opacity: .8; }
.ds-chip.ok { color: var(--settings-text); border-color: rgb(74 222 128 / 35%); background: rgb(74 222 128 / 9%); }
.ds-chip.warn { color: #fca5a5; border-color: rgb(248 113 113 / 35%); background: rgb(248 113 113 / 9%); }
.ds-label { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--settings-muted); }
.ds-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(215px, 1fr)); gap: 10px; }
.ds-empty { padding: 18px 16px; border: 1px dashed var(--settings-border); border-radius: 10px; color: var(--settings-muted); font-size: 13px; line-height: 1.6; grid-column: 1 / -1; }
.ds-card { position: relative; display: flex; flex-direction: column; gap: 5px; padding: 13px 14px 11px; border-radius: 10px; border: 1px solid var(--settings-border); background: var(--settings-hover); color: var(--settings-text); text-align: left; cursor: pointer; font: inherit; transition: border-color .14s ease, background .14s ease, transform .14s ease; }
.ds-card:hover { border-color: var(--settings-focus); background: var(--settings-active); transform: translateY(-1px); }
.ds-card:focus-visible { outline: 2px solid var(--settings-focus); outline-offset: 2px; }
.ds-card.active { border-color: var(--settings-focus); background: var(--settings-active); cursor: default; }
.ds-card.busy { opacity: .75; pointer-events: none; }
.ds-card.busy:hover { transform: none; }
.ds-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ds-name { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-active-badge { display: inline-flex; align-items: center; gap: 4px; flex: none; padding: 1px 8px; border-radius: 999px; background: var(--settings-focus); color: #fff; font-size: 10.5px; font-weight: 600; letter-spacing: .02em; }
.ds-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--settings-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-hint { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--settings-muted); opacity: .7; transition: opacity .14s ease, color .14s ease; }
.ds-card:not(.active):hover .ds-hint { opacity: 1; color: var(--settings-focus); }
.ds-toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
.ds-btn { display: inline-flex; align-items: center; gap: 7px; padding: 6px 13px; border-radius: 8px; border: 1px solid var(--settings-border); background: transparent; color: var(--settings-text); font: inherit; font-size: 12.5px; cursor: pointer; transition: border-color .14s ease, background .14s ease; }
.ds-btn:hover { background: var(--settings-hover); border-color: var(--settings-focus); }
.ds-btn:focus-visible { outline: 2px solid var(--settings-focus); outline-offset: 2px; }
.ds-btn.primary { background: var(--settings-active); border-color: var(--settings-focus); }
.ds-btn.primary:hover { background: rgb(51 156 255 / 22%); }
.ds-gallery { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 13px 15px; border: 1px dashed var(--settings-border); border-radius: 10px; }
.ds-gallery-title { display: flex; align-items: center; gap: 7px; font-weight: 600; font-size: 13px; color: var(--settings-text); }
.ds-gallery-desc { margin-top: 3px; font-size: 12px; line-height: 1.55; color: var(--settings-muted); }
.ds-notice { display: flex; align-items: center; gap: 8px; font-size: 12.5px; line-height: 1.5; color: var(--settings-muted); }
.ds-notice.ok { color: rgb(74 222 128); }
.ds-notice.error { color: #fca5a5; }
.ds-notice.info { color: var(--settings-text); }
.ds-cmd { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; margin-top: 9px; padding: 4px 4px 4px 10px; border: 1px solid var(--settings-border); border-radius: 8px; background: var(--settings-hover); }
.ds-cmd-text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--settings-text); white-space: nowrap; overflow-x: auto; }
.ds-copy { display: inline-flex; align-items: center; gap: 5px; flex: none; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--settings-border); background: transparent; color: var(--settings-muted); font: inherit; font-size: 11.5px; cursor: pointer; transition: color .14s ease, border-color .14s ease, background .14s ease; }
.ds-copy:hover { color: var(--settings-text); border-color: var(--settings-focus); background: var(--settings-active); }
.ds-copy:focus-visible { outline: 2px solid var(--settings-focus); outline-offset: 2px; }
.ds-copy.done { color: rgb(74 222 128); border-color: rgb(74 222 128 / 40%); }
.ds-spin { flex: none; width: 12px; height: 12px; border: 2px solid var(--settings-border); border-top-color: var(--settings-focus); border-radius: 50%; animation: ds-rotate .8s linear infinite; }
@keyframes ds-rotate { to { transform: rotate(360deg); } }
.ds-footer { display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap; padding-top: 2px; }
.ds-footer-text { font-size: 12px; color: var(--settings-muted); }
.ds-star-btn { border-color: rgb(250 204 21 / 45%); }
.ds-star-btn:hover { background: rgb(250 204 21 / 12%); border-color: rgb(250 204 21 / 70%); }
.ds-star-btn svg { color: rgb(250 204 21); }
`;
  function dreamSkinPage() {
    return Object.freeze({
      id: "dreamskin",
      label: "\u4e3b\u9898",
      icon: "star",
      mount(context) {
        const document2 = context.content.ownerDocument;
        const style = document2.createElement("style");
        style.textContent = CODEXSKIN_PAGE_CSS;
        const wrap = codexskinEl(document2, "div", "ds-wrap");

        const chipTheme = codexskinEl(document2, "span", "ds-chip");
        const chipCdp = codexskinEl(document2, "span", "ds-chip");
        const chipInj = codexskinEl(document2, "span", "ds-chip");
        const chips = codexskinEl(document2, "div", "ds-chips");
        chips.append(chipTheme, chipCdp, chipInj);

        const labelThemes = codexskinEl(document2, "div", "ds-label", "Installed themes");
        const grid = codexskinEl(document2, "div", "ds-grid");
        const empty = codexskinEl(
          document2, "div", "ds-empty",
          "No themes in the store yet. Import a theme ZIP below, or grab one from the Dream Skin gallery.",
        );

        const btnDir = codexskinEl(document2, "button", "ds-btn");
        btnDir.type = "button";
        btnDir.append(codexskinSvg(document2, "folder"), document2.createTextNode("Open folder"));
        const btnImport = codexskinEl(document2, "button", "ds-btn");
        btnImport.type = "button";
        btnImport.append(codexskinSvg(document2, "zip"), document2.createTextNode("Import ZIP"));
        const btnRestart = codexskinEl(document2, "button", "ds-btn");
        btnRestart.type = "button";
        btnRestart.append(codexskinSvg(document2, "restart"), document2.createTextNode("Restart Codex"));
        const toolbar = codexskinEl(document2, "div", "ds-toolbar");
        toolbar.append(btnDir, btnImport, btnRestart);

        const galleryTitle = codexskinEl(document2, "div", "ds-gallery-title");
        galleryTitle.append(codexskinSvg(document2, "spark"), document2.createTextNode("Theme gallery"));
        const galleryDesc = codexskinEl(
          document2, "div", "ds-gallery-desc",
          "Browse and download community themes on dreamskin.cc - opens in your default browser.",
        );
        const galleryLeft = codexskinEl(document2, "div");
        galleryLeft.append(galleryTitle, galleryDesc);
        const btnGallery = codexskinEl(document2, "button", "ds-btn primary");
        btnGallery.type = "button";
        btnGallery.append(codexskinSvg(document2, "external"), document2.createTextNode("Open gallery"));
        const gallery = codexskinEl(document2, "div", "ds-gallery");
        gallery.append(galleryLeft, btnGallery);

        const updTitle = codexskinEl(document2, "div", "ds-gallery-title");
        updTitle.append(codexskinSvg(document2, "refresh"), document2.createTextNode("Updates"));
        const updDesc = codexskinEl(document2, "div", "ds-gallery-desc", "Checking for updates...");
        const cmdText = codexskinEl(document2, "code", "ds-cmd-text", CODEXSKIN_UPDATE_CMD);
        const copyLabel = codexskinEl(document2, "span", null, "Copy");
        const btnCopy = codexskinEl(document2, "button", "ds-copy");
        btnCopy.type = "button";
        btnCopy.append(codexskinSvg(document2, "copy"), copyLabel);
        const updCmd = codexskinEl(document2, "div", "ds-cmd");
        updCmd.append(cmdText, btnCopy);
        const updLeft = codexskinEl(document2, "div");
        updLeft.append(updTitle, updDesc, updCmd);
        const btnUpdate = codexskinEl(document2, "button", "ds-btn primary");
        btnUpdate.type = "button";
        btnUpdate.append(codexskinSvg(document2, "refresh"), document2.createTextNode("Check now"));
        const updateCard = codexskinEl(document2, "div", "ds-gallery");
        updateCard.append(updLeft, btnUpdate);

        const diagTitle = codexskinEl(document2, "div", "ds-gallery-title");
        diagTitle.append(codexskinSvg(document2, "doc"), document2.createTextNode("Diagnostics"));
        const diagDesc = codexskinEl(
          document2, "div", "ds-gallery-desc",
          "Bundle all codexskin / Dream Skin logs into one text file and open the folder - attach it when reporting an issue.",
        );
        const diagLeft = codexskinEl(document2, "div");
        diagLeft.append(diagTitle, diagDesc);
        const btnExportLogs = codexskinEl(document2, "button", "ds-btn");
        btnExportLogs.type = "button";
        btnExportLogs.append(codexskinSvg(document2, "doc"), document2.createTextNode("Export logs"));
        const diagCard = codexskinEl(document2, "div", "ds-gallery");
        diagCard.append(diagLeft, btnExportLogs);

        const notice = codexskinEl(document2, "div", "ds-notice");
        notice.hidden = true;

        const starText = codexskinEl(
          document2, "span", "ds-footer-text",
          "If CodexSkinHub is useful to you, a star helps a lot:",
        );
        const btnStar = codexskinEl(document2, "button", "ds-btn ds-star-btn");
        btnStar.type = "button";
        btnStar.append(codexskinSvg(document2, "star"), document2.createTextNode("Star on GitHub"));
        const footer = codexskinEl(document2, "div", "ds-footer");
        footer.append(starText, btnStar);

        wrap.append(chips, labelThemes, grid, toolbar, gallery, updateCard, diagCard, footer, notice);
        context.content.append(style, wrap);

        let disposed = false;
        let busySwitch = false;
        let currentActiveId = "";
        let pollTimer = 0;
        let lastSeenImportAt;

        const setNotice = (text, kind, spinning) => {
          notice.replaceChildren();
          if (!text) { notice.hidden = true; return; }
          notice.hidden = false;
          notice.className = "ds-notice" + (kind ? ` ${kind}` : "");
          if (spinning) notice.append(codexskinEl(document2, "span", "ds-spin"));
          notice.append(document2.createTextNode(text));
        };
        const errText = (e) => (e instanceof Error ? e.message : String(e));

        const renderChips = (status) => {
          chipTheme.replaceChildren();
          chipTheme.append(codexskinSvg(document2, "palette"));
          chipTheme.append(document2.createTextNode(
            status.activeTheme ? `${status.activeTheme.name} (${status.activeTheme.id})` : "No active theme",
          ));
          chipTheme.classList.toggle("ok", Boolean(status.activeTheme));
          chipCdp.textContent = status.endpoint ? `CDP :${status.endpoint.port}` : "Codex not detected";
          const inj = status.injector;
          chipInj.textContent = inj ? (inj.aligned ? "Injector aligned" : "Injector misaligned") : "Injector stopped";
          chipInj.classList.toggle("ok", Boolean(inj && inj.aligned));
          chipInj.classList.toggle("warn", Boolean(inj && !inj.aligned) || !inj);
        };

        const renderGrid = (result) => {
          grid.replaceChildren();
          currentActiveId = String(result?.activeId ?? "");
          const entries = Array.isArray(result?.entries) ? result.entries : [];
          if (entries.length === 0) { grid.append(empty); return; }
          for (const theme of entries) {
            const isActive = theme.id === currentActiveId;
            const card = document2.createElement("button");
            card.type = "button";
            card.className = "ds-card" + (isActive ? " active" : "");
            const head = codexskinEl(document2, "div", "ds-card-head");
            head.append(codexskinEl(document2, "span", "ds-name", theme.name ?? theme.id));
            if (isActive) {
              const badge = codexskinEl(document2, "span", "ds-active-badge");
              badge.append(codexskinSvg(document2, "check"), document2.createTextNode("Active"));
              head.append(badge);
            }
            const hint = codexskinEl(document2, "span", "ds-hint", isActive ? "Currently applied" : "Click to apply");
            card.append(head, codexskinEl(document2, "span", "ds-id", theme.id), hint);
            card.addEventListener("click", async () => {
              if (busySwitch || isActive) return;
              busySwitch = true;
              card.classList.add("busy");
              hint.textContent = "Switching...";
              setNotice("", "", false);
              try {
                await window.__codexskin.request("switch", { id: theme.id });
                await loadList();
                await loadState();
              } catch (e) {
                setNotice(`Switch failed: ${errText(e)}`, "error");
                await loadList();
              } finally {
                busySwitch = false;
              }
            });
            grid.append(card);
          }
        };

        const applyImportState = (li) => {
          if (!li?.at) return;
          if (lastSeenImportAt === void 0) { lastSeenImportAt = li.at; return; }
          if (li.at !== lastSeenImportAt) {
            lastSeenImportAt = li.at;
            if (li.status === "pending") setNotice("Pick a theme ZIP in the dialog that just opened...", "info", true);
            else if (li.status === "ok") { setNotice(`Imported theme "${li.name}" (${li.id}).`, "ok"); void loadList(); }
            else if (li.status === "canceled") setNotice("Import canceled.");
            else if (li.status === "error") setNotice(`Import failed: ${li.error ?? "unknown error"}`, "error");
          } else if (li.status === "pending") {
            setNotice("Pick a theme ZIP in the dialog that just opened...", "info", true);
          }
        };

        const loadState = async () => {
          try {
            const status = await window.__codexskin.request("status");
            if (disposed) return;
            renderChips(status);
            applyImportState(status.lastImport);
          } catch (e) {
            if (!disposed) setNotice(`Dream Skin engine is not reachable: ${errText(e)}. Start Codex via codexhost (the supervisor runs automatically) and retry.`, "error");
          }
        };
        const loadList = async () => {
          try {
            const result = await window.__codexskin.request("list");
            if (!disposed) renderGrid(result);
          } catch (e) {
            if (!disposed) setNotice(`Dream Skin engine is not reachable: ${errText(e)}. Start Codex via codexhost (the supervisor runs automatically) and retry.`, "error");
          }
        };

        btnDir.addEventListener("click", async () => {
          try {
            const r = await window.__codexskin.request("open-dir");
            if (r && r.opened === false) setNotice(`Could not open the theme folder: ${r.error ?? "unknown error"}`, "error");
          }
          catch (e) { setNotice(`Could not open the theme folder: ${errText(e)}`, "error"); }
        });
        btnImport.addEventListener("click", async () => {
          setNotice("Pick a theme ZIP in the dialog that just opened...", "info", true);
          try { await window.__codexskin.request("import"); }
          catch (e) { setNotice(`Import failed to start: ${errText(e)}`, "error"); }
        });
        btnGallery.addEventListener("click", async () => {
          try { await window.__codexskin.request("open-gallery", { url: CODEXSKIN_GALLERY_URL }); }
          catch (e) { setNotice(`Could not open the gallery: ${errText(e)}`, "error"); }
        });

        // Update check: auto (throttled to once per 24h on the CLI side) on
        // page open, plus a manual "Check now" that always hits the network.
        let checkingUpdate = false;
        const cmpSemver = (a, b) => {
          const pa = String(a ?? "").split(".").map((n) => parseInt(n, 10) || 0);
          const pb = String(b ?? "").split(".").map((n) => parseInt(n, 10) || 0);
          for (let i = 0; i < 3; i += 1) {
            const d = (pa[i] ?? 0) - (pb[i] ?? 0);
            if (d !== 0) return d;
          }
          return 0;
        };
        const renderUpdate = (r) => {
          if (!r || typeof r !== "object") { updDesc.textContent = "Update check unavailable."; return; }
          const cur = r.current ?? "?";
          const lat = r.latest;
          if (!lat) {
            updDesc.textContent = `Installed: v${cur} - could not reach the npm registry${r.error ? ` (${r.error})` : ""}.`;
            return;
          }
          if (cmpSemver(lat, cur) > 0) {
            updDesc.textContent = `New version ${lat} available (installed: v${cur}). Run this to update:`;
          } else if (cmpSemver(lat, cur) < 0) {
            updDesc.textContent = `Up to date (v${cur}; published: v${lat} - this is a newer local build).`;
          } else {
            updDesc.textContent = `You are up to date (v${cur}).`;
          }
        };
        // Clipboard: app:// is not a secure context, so the async Clipboard API
        // is usually missing - fall back to a hidden textarea + execCommand.
        const copyText = async (text) => {
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(text);
              return true;
            }
          } catch { /* fall through to the legacy path */ }
          try {
            const ta = codexskinEl(document2, "textarea");
            ta.value = text;
            ta.readOnly = true;
            ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
            context.content.append(ta);
            ta.select();
            const ok = document2.execCommand("copy");
            ta.remove();
            return ok;
          } catch { return false; }
        };
        let copyResetTimer = 0;
        btnCopy.addEventListener("click", async () => {
          const ok = await copyText(CODEXSKIN_UPDATE_CMD);
          copyLabel.textContent = ok ? "Copied" : "Select + Ctrl+C";
          btnCopy.classList.toggle("done", ok);
          window.clearTimeout(copyResetTimer);
          copyResetTimer = window.setTimeout(() => {
            copyLabel.textContent = "Copy";
            btnCopy.classList.remove("done");
          }, 1800);
          if (ok) return;
          const selection = (document2.defaultView ?? window).getSelection?.();
          if (selection) {
            const range = document2.createRange();
            range.selectNodeContents(cmdText);
            selection.removeAllRanges();
            selection.addRange(range);
          }
        });

        const checkUpdate = async (force) => {
          if (checkingUpdate) return;
          checkingUpdate = true;
          btnUpdate.disabled = true;
          btnUpdate.style.opacity = ".6";
          updDesc.textContent = "Checking for updates...";
          try {
            renderUpdate(await window.__codexskin.request("check-update", { force: Boolean(force) }));
          } catch (e) {
            updDesc.textContent = `Update check failed: ${errText(e)}`;
          } finally {
            checkingUpdate = false;
            btnUpdate.disabled = false;
            btnUpdate.style.opacity = "";
          }
        };
        btnUpdate.addEventListener("click", () => void checkUpdate(true));

        // Diagnostics: bundle the supervisor / injector / import logs into one
        // text file (done by the supervisor) and reveal it in Explorer.
        let exportingLogs = false;
        const setExportButton = (label, busy) => {
          btnExportLogs.replaceChildren(codexskinSvg(document2, "doc"), document2.createTextNode(label));
          btnExportLogs.disabled = Boolean(busy);
          btnExportLogs.style.opacity = busy ? ".6" : "";
        };
        btnExportLogs.addEventListener("click", async () => {
          if (exportingLogs) return;
          exportingLogs = true;
          setExportButton("Exporting...", true);
          try {
            const r = await window.__codexskin.request("export-logs");
            if (!disposed) {
              if (r?.opened) setNotice(`Logs exported: ${r.path}`, "ok");
              else setNotice(`Logs exported to ${r?.path ?? "(unknown location)"} - auto-open failed${r?.error ? ` (${r.error})` : ""}; open the folder manually.`, "info");
            }
          } catch (e) {
            if (!disposed) setNotice(`Log export failed: ${errText(e)}`, "error");
          } finally {
            exportingLogs = false;
            if (!disposed) setExportButton("Export logs", false);
          }
        });

        // One-click restart: two-step confirm (this closes Codex Desktop!),
        // then show the notice BEFORE requesting - the page dies with the
        // app, so the bridge response will never arrive; swallow the timeout.
        const restartLabel = "Restart Codex";
        let restartArmed = false;
        let restartArmTimer = 0;
        const setRestartButton = (label, busy) => {
          btnRestart.replaceChildren(codexskinSvg(document2, "restart"), document2.createTextNode(label));
          btnRestart.disabled = Boolean(busy);
          btnRestart.style.opacity = busy ? ".6" : "";
        };
        btnRestart.addEventListener("click", async () => {
          if (!restartArmed) {
            restartArmed = true;
            setRestartButton("Click again to confirm", false);
            setNotice("Restarting will close and relaunch Codex Desktop. Click the button again to confirm.", "info");
            window.clearTimeout(restartArmTimer);
            restartArmTimer = window.setTimeout(() => {
              restartArmed = false;
              if (!disposed) { setRestartButton(restartLabel, false); setNotice("", "", false); }
            }, 5000);
            return;
          }
          window.clearTimeout(restartArmTimer);
          restartArmed = false;
          setRestartButton("Restarting...", true);
          setNotice("Restarting Codex Desktop - it will reopen automatically in a few seconds and the theme will be re-applied.", "info", true);
          try { await window.__codexskin.request("restart"); }
          catch (e) {
            // A fast error (e.g. a stale supervisor that predates this action)
            // arrives while the page is still alive - show it instead of
            // leaving the "Restarting..." notice up forever. The expected
            // 20s timeout from the page dying mid-request lands here too,
            // but by then Codex is closed anyway.
            if (!disposed) setNotice(`Restart request failed: ${errText(e)}. Codex was not restarted - update codexskin and try again.`, "error");
          }
        });

        // Star on GitHub - opens the repo in the default browser.
        btnStar.addEventListener("click", async () => {
          try { await window.__codexskin.request("open-gallery", { url: CODEXSKIN_REPO_URL }); }
          catch (e) { setNotice(`Could not open GitHub: ${errText(e)}`, "error"); }
        });

        void loadList();
        void loadState();
        void checkUpdate(false);
        pollTimer = setInterval(() => { void loadState(); }, 4000);
        return () => { disposed = true; clearInterval(pollTimer); };
      }
    });
  }
