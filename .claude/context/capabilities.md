# Capabilities

- **visual_testing**: browser (the claudesurf tools: `claudesurf_read` with `screenshot` and `page`)
- **test**: `npm --prefix server test` (node:test; live tests skip without Chrome; `CLAUDESURF_LIVE_HEADFUL=1` adds the headful window test)
- **toolchain_check**: `npm --prefix server outdated` (reports nothing until a dependency is added)
