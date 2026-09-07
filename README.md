# CodexSkinHub

Standalone theme management for **codexhost-launched Codex**, extracted from the
Codex Dream Skin x codex-host integration so it can be versioned, distributed
and upgraded on its own. Non-invasive: neither the **Codex Dream Skin**
installation nor the **codex-host** source repository is modified - everything
happens through runtime patches on the installed `@codexhost/cli` npm package,
applied by an anchor-based idempotent patcher that refuses to write when
upstream anchors drift.

## Features

- `codexskin theme` / `codexhost theme` - list and **hot-switch** themes on
  every running Codex window (no restart)
- `codexskin import` - import a theme ZIP (native file dialog, nested
  `theme.json` detection, upsert by id)
- `codexskin gallery` / `dir` - open the dreamskin.cc gallery or the theme
  library in Explorer
- **In-app settings page** ("Dream Skin" in the CodexHost settings nav):
  theme cards with live switching, status chips, Import ZIP, Open folder and
  gallery buttons
- `codexskin doctor` - health check for the whole integration
- `codexskin status` / `inject` / `down` - endpoint / injector / supervisor
  control

## Install

Prerequisites: [Codex Dream Skin](https://github.com/Fei-Away/Codex-Dream-Skin)
installed (provides the injection engine + theme library) and
`@codexhost/cli` installed globally via npm.

```cmd
git clone <this repo> && cd CodexSkinHub
node install.mjs            # add --startup to register a per-user startup entry
```

`install.mjs` copies the runtime to `%LOCALAPPDATA%\CodexSkinHub`, writes a
config pointing at the Dream Skin engine, patches the installed codexhost
package, and writes the `codexskin.cmd` PATH shim into
`%USERPROFILE%\.local\bin`. Re-running it after a `git pull` upgrades in place
(fully idempotent).

## Uninstall

```cmd
node uninstall.mjs
```

Strips both patches back to stock, removes the shim / startup entry / runtime
directory. The Dream Skin installation and your theme library are untouched.

## Upstream compatibility

The patcher anchors on stable symbol names (`startupTrace("entry")`,
`createDefaultRendererSettingsPages`, `aboutPage(messages)` pages entry, the
`node:url` import). Verified byte-for-byte against codexhost **0.6.0**
windows-x64. When a future codexhost version moves these anchors the patcher
**fails loudly and leaves files untouched** instead of writing garbage - run
`codexskin doctor` to see what drifted.

## Layout

```
src/cli.mjs               CLI + supervisor + CDP bridge (theme/import/gallery/dir/status/down/doctor)
src/hook.mjs              loaded by the patched codexhost bin (theme dispatch + supervisor autostart)
src/patch.mjs             idempotent patcher: apply / status / --revert
src/payload/renderer.js   in-app settings page payload
src/tools/ui-verify.mjs   CDP screenshot driver for UI verification
scripts/sync-port.ps1     legacy port-alignment helper
install.mjs / uninstall.mjs
```

Runtime state lives in `%LOCALAPPDATA%\CodexSkinHub` (config, supervisor state,
logs, import temp dirs); the Dream Skin engine and theme library stay in
`%LOCALAPPDATA%\CodexDreamSkin` and are only referenced (override the root via
`config.json -> dreamSkinRoot`).
