#!/usr/bin/env node
// Runtime smoke test for the injected settings-page payload.
//
// `node --check` only parses; it cannot see a `const` declared inside an
// `if/else` branch and referenced outside it. That exact mistake shipped as
// "Dream Skin engine is not reachable: btnDel is not defined" - a page bug
// masquerading as a connectivity problem, invisible to every syntax check.
//
// This extracts the render functions from the payload and EXECUTES them
// against a mock DOM, so ReferenceErrors/TypeErrors surface here instead of
// in a user's Codex window.
//
//   node src/tools/check-payload-render.cjs

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const payload = path.join(__dirname, "..", "payload", "renderer.js");
const src = fs.readFileSync(payload, "utf8");

// Extract `const NAME = (...) => { ... };` by brace matching.
function extractFn(name) {
  const marker = `const ${name} = `;
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const braceStart = src.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1) + ";";
    }
  }
  return null;
}

// A mock element that swallows unknown property access and returns chainable
// stubs - enough for building a card grid without a real DOM.
const mockClassList = { add() {}, remove() {}, toggle() {}, contains: () => false };
function mockEl() {
  const target = { classList: mockClassList, dataset: {}, style: {}, hidden: false, isConnected: true, children: [] };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return () => mockEl();
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const results = [];
function runCase(label, fnName, args, deps) {
  const body = extractFn(fnName);
  if (!body) { results.push([label, `SKIP (${fnName} not found)`]); return; }
  const names = Object.keys(deps);
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(...names, `"use strict"; ${body}; return ${fnName}(...ARGS);`);
    const call = factory.toString().replace("...ARGS", JSON.stringify(args).slice(1, -1));
    // Rebuild so the call gets the real objects rather than JSON.
    // eslint-disable-next-line no-new-func
    const real = new Function(...names, "ARGS", `"use strict"; ${body}; return ${fnName}(...ARGS);`);
    void call;
    real(...names.map((n) => deps[n]), args);
    results.push([label, "ok"]);
  } catch (e) {
    results.push([label, `${e.constructor.name}: ${e.message}`]);
  }
}

const document2 = {
  createElement: () => mockEl(),
  createTextNode: () => mockEl(),
};
const codexskinEl = () => mockEl();
const grid = mockEl();
const empty = mockEl();
const notice = mockEl();
let disposed = false;
const setNotice = () => {};
const errText = (e) => (e instanceof Error ? e.message : String(e));

// Two entries: one active, one not - the non-active branch is where the
// delete button (and the original ReferenceError) lives.
const listResult = {
  activeId: "active-theme",
  entries: [
    { id: "active-theme", name: "Active One", dir: "active-theme" },
    { id: "other-theme", name: "Other One", dir: "other-theme" },
    { id: "third-theme", name: "Third One", dir: "third-theme" },
  ],
};

// State used by renderGrid from the enclosing scope.
const shared = `
  let currentActiveId = "";
  let busySwitch = false;
  let lastSeenImportAt;
`;

// renderGrid closes over document2/codexskinEl/grid/empty and the shared state.
(function runRenderGrid() {
  const body = extractFn("renderGrid");
  if (!body) { results.push(["renderGrid", "SKIP (not found)"]); return; }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "document2", "codexskinEl", "codexskinSvg", "grid", "empty", "setNotice", "errText",
      "loadList", "loadState",
      `"use strict"; ${shared} ${body}; return renderGrid;`,
    );
    const renderGrid = fn(document2, codexskinEl, () => mockEl(), grid, empty, setNotice, errText, async () => {}, async () => {});
    renderGrid(listResult);
    results.push(["renderGrid (3 entries, 1 active)", "ok"]);
  } catch (e) {
    results.push(["renderGrid (3 entries, 1 active)", `${e.constructor.name}: ${e.message}`]);
  }
})();

(function runRenderChips() {
  const body = extractFn("renderChips");
  if (!body) { results.push(["renderChips", "SKIP (not found)"]); return; }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "document2", "codexskinEl", "codexskinSvg", "chipTheme", "chipCdp", "chipInj",
      `"use strict"; ${body}; return renderChips;`,
    );
    const renderChips = fn(document2, codexskinEl, () => mockEl(), mockEl(), mockEl(), mockEl());
    renderChips({ activeTheme: { id: "a", name: "A" }, endpoint: { port: 1234 }, injector: { aligned: true } });
    results.push(["renderChips (active + aligned)", "ok"]);
  } catch (e) {
    results.push(["renderChips (active + aligned)", `${e.constructor.name}: ${e.message}`]);
  }
})();

void runCase;
void notice;
void disposed;

let failed = 0;
for (const [label, status] of results) {
  if (status !== "ok") failed += 1;
  console.log(`${status === "ok" ? "ok  " : "FAIL"}  ${label}${status === "ok" ? "" : `  -> ${status}`}`);
}
if (failed > 0) {
  console.error(`\n${failed} payload render check(s) failed`);
  process.exit(1);
}
console.log("\nall payload render checks passed");
