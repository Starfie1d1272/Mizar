# CS2 official asset provenance

本目录记录 `@mizar/cs2-assets` 中由 CS2 retail resources 导出的 presentation asset 的工程来源。它不作 Valve asset 的所有权、商标或再许可法律判断。

正式导入必须由维护者提供自己的 Counter-Strike 2 resource/VPK copy，并通过 `scripts/cs2-assets/import.mjs` 生成 checked-in normalized SVG 与 `generated/manifest.json`。仓库不下载或提交 VPK、raw compiled resource、VRF binary 或机器本地路径。

每个 manifest asset 必须能够回溯到：

- Steam App ID `730` 与 Steam build ID；
- repo-independent VPK path 与 compiled resource path；
- raw compiled resource SHA-256；
- normalized SVG SHA-256 与 content-hashed output path；
- ValveResourceFormat / Source2Viewer-CLI 的精确版本。

导出的 SVG 仍标记为 **Valve / Counter-Strike 2 game-resource origin**。ValveResourceFormat / Source2Viewer 是 reverse-engineered tooling，不是 Valve 官方 Source 2 SDK；工具的许可证与来源单独记录在仓库根目录 `THIRD-PARTY-NOTICES.md`。

当前 checked-in bundle 来自 Steam App ID `730`、Steam build `25218825` 的
公开 Windows depot 2347770；DepotDownloader 的 depot manifest ID
`2053759441494650084` 仅用于复现本次输入，不写入 runtime contract。
ammo semantic 的官方 game-data 证据与提取 hash 记录在
`provenance/ammo-evidence.md`。下载工具、VPK、raw compiled resource 和
VRF binary 均只存在于维护者本地导入工作目录，未进入仓库。

## Broadcast thumbnails and side marks

Series-strip scene thumbnails and CT/T one-color marks are packaged separately
from the VPK-imported item catalog. Their pinned extraction source, source and
output hashes, media type, and thumbnail transformation are recorded in
`generated/broadcast-assets.json`. The originals are Valve / Counter-Strike 2
artwork; the public extraction repositories do not grant ownership of that
artwork. These downloaded presentation assets do not change the production
import workflow or become runtime sources of telemetry facts.
