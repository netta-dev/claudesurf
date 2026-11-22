# Capabilities

- **visual_testing**: browser (the claudesurf tools: `claudesurf_read` with `screenshot` and `page`)
- **test**: `npm --prefix server test` (node:test; live tests skip without Chrome; `CLAUDESURF_LIVE_HEADFUL=1` adds the headful window test, the act cases, and the taskbar case, which reads the urgency bit and demands-attention back with `xprop`). A fix pass runs it without `CLAUDESURF_LIVE_HEADFUL`; the headful run comes once, at `build.md`'s full-suite step, after asking the human whether the display is free.
- **setup**: `npm --prefix server ci --ignore-scripts` (the three browser-side libraries the renderer injects)
- **toolchain_check**: `npm --prefix server outdated`
- **deploy_other_user**: `npm --prefix server ci --ignore-scripts && systemctl --user restart claudesurf`; after a change to the tools' schemas, restart each running Claude Code session too (README.md, Upgrading)
