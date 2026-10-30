# Issue 111 v2 visual review

This is an **independent review branch**, based on visual candidate `6eee78e23427774f9a397baab306c1fc8b4c6c2a`. It adds a temporary review harness, not a production feature or permanent test matrix. Do not merge this review-only directory into the release. The candidate itself contains the new React views, CSS, `statsProgramInserts` mapping, standalone product page, Companion-page rotation, and tests; this branch adds only `review/issue111/`. `run.sh` temporarily copies harness/projection files into the web and Companion directories, then removes them on exit. It refuses to overwrite existing temporary files.

## Authorized inputs

Obtain these through the current Library workflow. Do not download another archive from the old source-site endpoint or query production for replacement facts. The script verifies all SHA-256 values before rendering.

| Input | Library identity / repository path | SHA-256 |
| --- | --- | --- |
| Original v2 source ZIP, `mizar-stats-v2-source-691910af.zip`, 3,254,227 bytes | `libfile_0dadf47ecc0881919f5c2d061d1963f2`, file `file_000000008c608230a1998127dbf61f79` | `573149412b240c56245bce2435f2c3bacbccb2fff930193f3b271ba97e6042c3` |
| First supplied real JSON, 15,807 bytes | `libfile_060bd1f11f9881918035231ca5499588`, file `file_000000002bcc81f58c09e69acc2c769c` | `4df7d24ef20fb3209d48263c1d8e29d5bf3b51ea2c982939b43f2fdb8d2e2799` |
| Second supplied real JSON, 30,559 bytes | `libfile_7405fd7e68088191bcf5cae261ca1986`, file `file_000000004d6c81f7b6f3b5f78e0564d2` | `05e7fce93791ae867271faa876607aaba4d2287809bdb91aedc3e156d6f8b601` |
| Synthetic Companion projection | `apps/web/test/fixtures/stats-program.json` | `b7fa6b71e917e073eeb01c98f99c9ae66ea7d699245a4911451fb802deeff741` |
| Synthetic upstream fixture for phase projection | `tests/fixtures/rivalhub-provider-stats-v1-extended.json` | `72fd89eae31080f16e0ecbd50f0c0ea7b53e7db9377e029f2f59ec1286446e3d` |

The ZIP is extracted to a temporary directory. The reference is `original-site/dist/renderers.mjs` with the original v2 CSS and assets, in clean mode. Although the original app is booted with `scenario=r3`, the comparison replaces its board with `renderPage(ctx, page)` using the synthetic projection; **it does not use reconstructed R3 statistics**. The source adapter is in `compare.cjs` and `phases.cjs` and is available for independent inspection.

## Run

Use Node 24, pnpm 12, Python 3, `unzip`, `curl`, Chromium, and project dependencies installed from the lockfile. Build the workspace packages first (`pnpm build:packages`) so `@mizar/hud-view` and other package exports contain this candidate's source and CSS. The project dependency tree needs Playwright. The script finds the installed Playwright package and `chromium` by default; set `ISSUE111_PLAYWRIGHT` to the absolute directory containing its `package.json` or `ISSUE111_CHROMIUM` to a browser executable if needed. Chromium is launched with `--no-sandbox` for a container environment.

```sh
export ISSUE111_SOURCE_ZIP=/absolute/path/mizar-stats-v2-source-691910af.zip
export ISSUE111_REAL_1930=/absolute/path/first-supplied.json
export ISSUE111_REAL_2000=/absolute/path/second-supplied.json
export ISSUE111_OUTPUT=/absolute/path/new-review-output
review/issue111/run.sh
```

`ISSUE111_OUTPUT` may be omitted; a fresh temporary output directory is then printed. An existing output directory must not already contain `synthetic/` or `real/`. The script opens two local ephemeral ports. It projects the real snapshots and generates synthetic phase fixtures with the repository's actual `projectHistoricalProgram`, starts the original site's static assets and the candidate's Vite component harness, takes the screenshots, validates counts and dimensions, and removes temporary harness files. It does not launch production services. Browser errors and per-page image counts are recorded in the JSON inventories.

Image URLs in the two supplied JSONs are the only external asset requests: `cache-assets.py` downloads the referenced team logos and avatars with `curl`, the inherited proxy and system TLS verification, then rewrites image URLs in temporary projections to local copies of those exact bytes. Failed downloads stay unavailable and are counted in `real/results.json`; do not disable TLS verification or invent substitute identities. No website statistical endpoint is queried.

## What to review

- `synthetic/`: 23 regular source/candidate pairs plus six pairs for map-pool information, BP, series, halftime, intermap and postmatch single-map view: **58 PNGs, all 1920×1080**. `results.json` and `phases.json` identify each page. The 23-page fixture is the checked-in projection with identical locally generated **test-only** logo/avatar graphics on each side; phase tests use synthetic five-player K/A/D data. Both renderers receive equivalent supplied fields; inspect `compare.cjs` for its transformation into the original renderer's input shape. Original renderer sample captions sometimes use source-shaped map/round fields while the candidate uses the projected metric's own sample; compare the values and their actual contracts before declaring an error. Never infer Rating or ADR denominators from visual map counts.
- `real/`: **24 candidate PNGs**, 12 from each supplied JSON. The real inputs provide neither match phase, event name, format, official map pool nor support amount. `project-real.ts` passes a temporary `waiting` scene to the existing projection, and `harness.tsx` removes the resulting phase label and uses `本届 · 统计快照`; the match hero is excluded. This is a real-data presentation check, not a same-input original-site comparison. It does not fabricate scores, support, identities, or missing statistical fields.
- The screenshot harness calls `statsProgramInserts` and `StatsInsertView` directly. The candidate product page and automatic rotation separately consume the same projection; check `apps/web/src/program/StatsInsertPage.tsx`, `useStatsRotation.ts`, and their tests. A successful rendering or unchanged layout is evidence for review, not an independent visual approval.
- Source titles and facts can have justified differences: in particular the current lineup is labelled `本场阵容` because the current contract does not prove it was formally submitted. Inspect long names, unavailable images, missing values, real zeroes, one-sided data, pagination, custom Program themes and HUD isolation separately; the 29 pairs are not a complete edge-case matrix.

The original task requested screenshot delivery through Library. The prepared batch failed with HTTP 401 during app discovery; no successful screenshot upload was confirmed. These scripts generate local review artifacts only. They do not retry that failed upload, publish anything, or make local paths available to a different container.
