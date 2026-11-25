# Mizar Windows 安装与更新架构重构落地规范（v2 Execution Spec）

> **文档定位**：本规范为**零决策执行文档**。所有架构选型、边界约束、磁盘布局、进程协议与分 PR 改动清单均已拍板，开发 Agent 必须严格按本规范落地，**禁止**自行新增状态机、兼容框架、跨进程握手协议或将旧 PowerShell 逻辑逐行翻译成 Rust。

---

## 1. 背景、现场根因与重构目标

### 1.1 真实线上故障结论（诊断包 `mizar-support-2026-11-25T05-22-44Z.zip`）
- **故障版本**：`v1.11.26`（`1564f42a`），用户安装路径为 **D 盘中文自定义路径**。
- **故障现象**：更新准备、提交、复核、Companion 正常停止、Host 退出收尾均成功，但 PowerShell 更新工具在启动后 **约 1.2 秒**以 `exit code 1` 提前退出（**非** 15 秒超时）。
- **直接暴露的架构缺陷**：
  1. `updates.rs` 丢弃了子进程 `stdout/stderr`，导致无法得知具体异常；
  2. `main.rs` 将更新接力失败冒泡进 `start_gui()` 的错误分支，误记为 `startup_failed` 并把用户送进无关的 CS2 配置恢复界面；
  3. **引导悖论**：旧版 Host 运行的是旧安装目录里的 `update-install.ps1` 来安装新版，修完 `main` 救不了已安装旧版的用户；
  4. **过度防御与职责交叉**：4 种语言（Rust / PowerShell / C# / NSIS）超 5,000 行代码互相反调，维护多份重复状态（`journal` / `pending` / `RunOnce` / `.mizar-update-owner` / 5 步 Host↔Companion 握手）。

### 1.2 重构目标
- 用 **来自已验签新包的单一 Rust 原生执行器（`mizar-applier.exe`）** + **Side-by-side 版本目录 + 稳定启动器（`Mizar.exe`）** 彻底替换 PowerShell 安装事务、C# 重复编排与 5 步握手协议。
- 便携版（Portable）与用户数据目录（`%LOCALAPPDATA%\Mizar`）保持现有行为不变。
- 核心验收标准：**即使安装或更新遇到外部错误，旧版仍可正常重启、用户可直接覆盖重装，且全部比赛/OBS/用户资料完整保留。**

---

## 2. 硬性原则（ADR 约束，禁止违背）

### 2.1 四条不可违背的铁律
1. **打破引导悖论**：`mizar-applier.exe` **必须**来自刚通过验签的新安装包（或由新包解压提取），绝不允许由旧安装目录中的旧执行器安装新版。
2. **护栏三分法**：
   - **必须保留（真实安全边界）**：TUF / Sigstore 发布来源证明、包字节数与 SHA-256 校验、新版本载荷完整清单校验。
   - **必须保留（防误删/正确性护栏）**：递归删除前拦截重解析点 / junction（防止穿透删掉用户挂载的素材盘）、进程 `PID + StartTime` 校验（防 PID 复用）。
   - **彻底删除（过度防御）**：`NtQueryMutant`、`DuplicateHandle` 跨进程借锁、写死旧脚本字节哈希（`Test-LegacyHelperHash`）、`Preserve-ExtraFiles` 逐文件搬运、要求**旧版程序目录必须完整**才能升级的门禁、无差别 3000 端口阻断。
3. **安全与活性解耦**：
   - **安全（防切换期间重开旧版）**：由 OS 内核对象存活语义保证——Host 在 `CreateProcessW` 时通过 `STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 白名单继承 `Global\MizarDesktop` 句柄给 Applier。
   - **活性（进度展示）**：进度窗口独立于事务线程运行，窗口创建失败仅降级为无窗执行，**绝不**阻断安装。
   - **失败兜底**：Host 启动 Applier 后若接力失败，Host 直接重启旧版（绝不进 CS2 恢复）；Host 正常退出后零职责，安装未切换前失败由 Applier 负责重新拉起旧版。
4. **旧版策略（不背历史包袱）**：
   - **不提供**旧架构（`<= 1.11.27`）到新架构（`>= 1.12.0`）的内置自动升级。在 `scripts/qualification/update-release.json` 中将 `minimumVersion` 设为新架构首个版本号（如 `1.12.0`），旧版客户端通过现有 `isCompatible()` 自动进入 `manual` 提示用户前往发布页下载新版安装包完成一次性覆盖迁移。
   - **不兼容**历史崩溃恢复记录（`legacy handoff`）。新安装器运行时仅顺手删除 `HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce` 下的 `!MizarUpdateRecovery`，并将旧安装目录整体改名归档。

### 2.2 统一数据故障处理策略（Fail-Open for Recovery）

| 数据类型 | 故障处理方式 |
| --- | --- |
| 下载缓存（`updates/download-*`） | 损坏即删除并重新下载，不禁用更新功能 |
| 更新偏好（`updates/settings.json`） | 损坏即改名归档并回退默认值，不锁死更新页面 |
| 历史安装记录（旧 `updates/install-*`、`fresh-install.pending`） | 统一改名归档，绝不阻塞新安装 |
| 程序目录文件 | 可直接修复或覆盖安装，不要求旧程序完整 |
| 用户比赛资料、OBS 配置、素材、日志（`%LOCALAPPDATA%\Mizar`） | 独立保留，升级、修复、卸载均不删除 |
| 清理旧版本/缓存失败 | 记录诊断并在下次启动/安装时重试，**绝不**否定已提交的安装 |

---

## 3. 磁盘目录布局与持久化契约

### 3.1 安装目录结构（支持任意盘符与中文路径，如 `D:\工具\Mizar`）

```text
<InstallDir>\                          # 默认 %LOCALAPPDATA%\Programs\Mizar
├── Mizar.exe                          # 稳定 Launcher Stub（极少变更，快捷方式与注册表固定指向此文件）
├── current.json                       # 唯一原子版本指针（见 3.2）
├── Uninstall.exe                      # 卸载入口（薄壳调用 mizar-applier.exe uninstall）
├── versions\
│   ├── 1.12.0-a1b2c3d4\               # 当前生效版本（<version>-<gitSha前8位>）
│   │   ├── Mizar.exe                  # 真正的 Tauri Desktop 主程序
│   │   ├── mizar-applier.exe          # 本版本自带的原生安装执行器
│   │   ├── installed.flag             # 安装版模式标记（保留，兼容 Host 与 product-runtime.mjs）
│   │   └── resources\                 # runtime/node.exe, app/, web/, metadata/artifact.json & SHA256SUMS
│   └── 1.11.27-e5f6a7b8\              # 上一个可回退版本（保留 1 个，延迟清理更早版本）
└── staging\                           # 正常 v2 更新的临时解包目录（提交后移动至 versions\<id>）
```

> **为什么目录名用 `<version>-<gitSha8>`**：支持同版本覆盖修复/重装（若同 ID 已存在，追加短随机后缀或先移至 `staging/old-<nonce>` 再替换），无需原地覆盖正在运行的二进制。

### 3.2 `current.json` 精确 Schema 与原子写入

```json
{
  "schemaVersion": 2,
  "current": "1.12.0-a1b2c3d4",
  "previous": "1.11.27-e5f6a7b8",
  "updatedAt": "2026-11-25T15:00:00Z"
}
```

- **字段约束**：
  - `schemaVersion`: 固定为整数 `2`。
  - `current`: 字符串，匹配 `^[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{8}(-[a-f0-9]{6})?$`，且对应 `versions\<current>\Mizar.exe` 存在。
  - `previous`: `string | null`，首次安装为 `null`，升级/修复时指向上一个版本目录名。
- **原子写入步骤**：写入同目录 `current.json.<pid>.tmp` → `file.sync_all()` → `MoveFileExW(tmp, current.json, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`。

### 3.3 历史旧布局（v1.11.x）一次性迁移规则
当 `mizar-applier.exe install` 目标目录 `<InstallDir>` 满足：**存在旧版 `installed.flag` 或旧版 `resources\metadata\artifact.json`，且不存在 `current.json`** 时：
1. **先在 `<InstallDir>` 同级目录**（如 `<InstallDir>.mizar-staging-<nonce>`）完成新载荷暂存与校验，避免后续归档旧目录时把新载荷一并移走；
2. 确认旧 `<InstallDir>` 内无正在运行的 `Mizar.exe`（仅检查可执行文件路径位于 `<InstallDir>` 下的进程）；
3. 将整个旧 `<InstallDir>` **整体改名归档**为 `<InstallDir>-legacy-<yyyyMMddTHHmmssZ>`（保留用户可能自行放入的未知文件，绝不逐文件拷贝或校验旧文件）；
4. 重建干净的 `<InstallDir>`，将同级暂存目录移入 `<InstallDir>\versions\<id>` 并写入 `Mizar.exe` 与 `current.json`（若本步失败，直接将旧目录移回原位）；
5. 顺手清理 `HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce` 中的 `!MizarUpdateRecovery`（若存在），并将 `%LOCALAPPDATA%\Mizar\updates` 中旧的 `install-*` 与 `bootstrap-cache\fresh-install.pending` 改名归档（失败仅记日志，不阻塞安装）。

---

## 4. 组件详细实现规格

### 4.1 新增 Rust Crates（位于 `apps/desktop/` 下，独立于 Tauri/WebView2）
在 `apps/desktop/` 下建立轻量原生二进制（不引入 `tauri`、`wry`、`webview2`）：
- **`mizar-launcher`**（输出 `Mizar.exe`，放到 `<InstallDir>\Mizar.exe`）
- **`mizar-applier`**（输出 `mizar-applier.exe`，随每个版本的载荷打包在 `versions\<id>\mizar-applier.exe`）
- 共享依赖：`windows`（复用现有 `0.62.2`，补充 `Win32_System_Registry`、`Win32_Storage_FileSystem`、`Win32_Security`、`Win32_UI_Shell_PropertiesSystem`）、`serde` / `serde_json`、`sha2`。

### 4.2 稳定 Launcher（`<InstallDir>\Mizar.exe`）精确行为
1. **更新期检查**：检测 `Global\MizarUpdateActive` 事件是否存在；若存在且非 `--stop` / `--app-version`，尝试聚焦标题为 `Mizar 应用更新` 的窗口并退出（exit code `1`），不阻塞更新。
2. **解析目标版本（严格只读，不修改安装状态）**：
   - 读取同目录 `current.json` → 定位 `target = versions\<current>\Mizar.exe`。
   - 若 `current.json` 缺失/损坏，或 `target` 不存在：仅做只读兜底——按语义化版本号从高到低挑选 `versions\` 下包含 `Mizar.exe` 与 `installed.flag` 的已完成版本目录直接启动（**不重写 `current.json`**，不按目录修改时间猜测）；若完全无可用版本，弹原生 `MessageBoxW` 提示“程序文件不完整，请下载官方安装包覆盖修复（用户资料已保留）”。
3. **透传启动与任务栏固定保护**：
   - **完整透传所有 CLI 参数**（`--stop`、`--export-logs`、`--app-version`、`--no-browser`、`--observer-process`）与工作目录。
   - 若传入 `--stop`、`--export-logs`、`--app-version`、`--no-browser`，等待子进程退出并返回**相同退出码**。
   - 常规 GUI 启动时：拉起 `versions\<current>\Mizar.exe` 后立即退出（不常驻后台、不占内存）。
   - **任务栏固定保护（在 Tauri 主程序 `main.rs` 窗口创建后执行）**：通过 Win32 `SHGetPropertyStoreForWindow` 设置 `System.AppUserModel.ID = "Starfie1d1272.Mizar"` 与 `System.AppUserModel.RelaunchCommand = "<InstallDir>\Mizar.exe"`，确保用户固定到任务栏后始终指向根目录稳定 Launcher。
4. **`bundle_root()` 与安装版识别零改动**：子进程位于 `<InstallDir>\versions\<id>\Mizar.exe`，其 `std::env::current_exe().parent()` 自动解析为 `versions\<id>`，且该目录内保留 `installed.flag`，所有 `gsi_host`、`observer_hud`、`cs2_frame_rate_live`、`mulnx_launch`、`product-runtime.mjs`、`startup_log.rs` 与便携版逻辑均**无需改动**。

### 4.3 唯一安装执行器（`mizar-applier.exe`）精确规格

#### 4.3.1 CLI 接口（元数据直接读自载荷 `artifact.json`，避免重复传参）
```text
mizar-applier.exe install \
  --payload-dir <解压好的新版本目录> \
  --install-dir <目标安装目录> \
  [--state-root <用户数据目录，默认 %LOCALAPPDATA%\Mizar>] \
  [--expected-content-digest <64hex>] \
  [--core-archive-sha256 <64hex> --installer-sha256 <64hex> --installer-bytes <u64>] \
  [--desktop-shortcut] [--no-ui] [--no-launch] [--result-file <path>]

mizar-applier.exe apply-update \
  --payload-dir <解压好的新版本目录> \
  --install-dir <目标安装目录> \
  [--state-root <用户数据目录，默认 %LOCALAPPDATA%\Mizar>] \
  --expected-content-digest <64hex> \
  [--core-archive-sha256 <64hex> --installer-sha256 <64hex> --installer-bytes <u64>] \
  --host-pid <u32> --host-start-time <u64> \
  [--desktop-mutex-handle <usize>] [--no-ui] [--result-file <path>]

mizar-applier.exe uninstall \
  --install-dir <目标安装目录> \
  [--no-ui] [--result-file <path>]
```
> `version`、`gitSha`、`contentDigest` 统一由 Applier 从 `--payload-dir\resources\metadata\artifact.json` 读取并与 `SHA256SUMS` 交叉校验；在线安装器与内置更新额外传入 `--expected-content-digest` 绑定已认证清单。

#### 4.3.2 结构化结果与退出码（彻底消灭 stderr 字符串匹配）
- 退出码：
  - `0`: 成功（含“已提交但非关键清理失败”，详见 `result.json`）
  - `10`: 另一个安装事务正在进行（`writer_busy`）
  - `11`: 目标程序仍在运行且等待退出超时（`app_running`）
  - `12`: 新载荷校验失败（`payload_invalid`）
  - `13`: 素材包准备失败（`resources_failed`）
  - `14`: 磁盘权限或空间不足（`io_error`）
  - `15`: 用户取消（`cancelled`）
  - `16`: 新版启动确认失败且已自动回退旧版（`rolled_back`）
  - `17`: 内部未知错误（`internal_error`）
- 结构化结果文件（写入 `--result-file` 及 `%LOCALAPPDATA%\Mizar\logs\last-applier-result.json`）：
  ```json
  {
    "status": "installed | rolled_back | cancelled | failed",
    "code": "ok | writer_busy | app_running | payload_invalid | resources_failed | io_error | launch_failed",
    "version": "1.12.0",
    "previousVersion": "1.11.27",
    "cleanupWarning": null,
    "logPath": "C:\\Users\\...\\AppData\\Local\\Mizar\\logs\\applier-20261125-150000.log"
  }
  ```

#### 4.3.3 仅有的 2 个内核同步对象
| 名称 | 语义 | 用途 |
| --- | --- | --- |
| `Global\MizarUpdateWriter` | 互斥锁（`WaitForSingleObject(0)`，允许接管 `WAIT_ABANDONED`） | 保证全局同一时刻只有一个安装/更新/卸载事务 |
| `Global\MizarDesktop` | 对象存在语义（`CreateMutexW(..., 0, name)`） | `apply-update` 模式下由 Host 通过白名单句柄继承传入；`install`/`uninstall` 模式下自行创建；在提交后、拉起新版前关闭句柄 |
| `Global\MizarUpdateActive` | Event（存在即表示正在更新） | 仅用于稳定 Launcher 阻止用户中途双击并聚焦进度窗 |

#### 4.3.4 精确 5 阶段事务流程
1. **Acquire & UI（并行无阻塞）**：
   - 立即获取 `Global\MizarUpdateWriter` 与 `Global\MizarUpdateActive`；
   - 若未传 `--no-ui`，在后台线程启动轻量原生 Win32 进度窗（`Mizar 应用更新`），**窗口初始化失败仅写日志并继续执行事务**。
2. **Stage（完全可逆，支持用户取消）**：
   - 验证 `--install-dir` 合法（非盘符根目录、非系统目录、非 `%LOCALAPPDATA%\Mizar` 内部、无路径穿越）；
   - 逐文件核验 `--payload-dir` 内的 `resources/metadata/artifact.json` 与 `SHA256SUMS`（核验所有文件 SHA-256、整体 `contentDigest` 及可选 `--expected-content-digest`）；
   - 将验证通过的载荷移入暂存目录：**正常 v2 安装/更新放入 `<InstallDir>\staging\<ver>-<sha8>`，首次旧布局迁移按 3.3 放入同级 `<InstallDir>.mizar-staging-<nonce>`**（跨卷则复制并校验），并在暂存目录内写入 `installed.flag`。
   - 取消语义：在进入 `Switch & Commit` 之前，若用户点击取消，立即中止当前非破坏性步骤、清理暂存目录、记录 `cancelled`（exit `15`）并保留旧版不动。
3. **Quiesce（仅等待旧版退出）**：
   - `apply-update` 模式：等待 `--host-pid`（校验 `StartTime` 防 PID 复用）退出，最长 60 秒；
   - `install` / `uninstall` 模式：检查可执行路径位于 `<InstallDir>` 下的 `Mizar.exe` 进程（不再扫描无关 3000 端口），若存活提示用户关闭或返回 `app_running`（exit `11`）；
   - Core 包素材准备：调用新载荷内 `resources\runtime\node.exe` 执行 `installed-entry.mjs`（独立 `ResourceStore.open()` 模式）完成素材授权与激活。
   - **重要**：本阶段及之前任何失败，清理暂存目录，保持旧版原封不动；若为 `apply-update` 且非用户取消，**释放 `Global\MizarDesktop` 后由 Applier 重新拉起旧版 `<InstallDir>\Mizar.exe`**。
4. **Switch & Commit（唯一原子提交点，进入后禁止取消）**：
   - 若检测到旧布局（无 `current.json`），按 3.3 执行一次性整体归档迁移；
   - 将暂存目录移入 `<InstallDir>\versions\<id>`；
   - 更新 `<InstallDir>\Mizar.exe`（仅当新包内 `mizar-launcher.exe` 哈希与根目录不同时才原子替换；若被占用重试 5 次每次 200ms，仍失败则跳过替换 Launcher 仅记告警，不阻断升级）；
   - **原子写入 `current.json`**（`current = <new_id>`, `previous = <old_id>`）——**此为唯一提交点**；
   - 写入固定 HKCU 注册表项（`HKCU\Software\Mizar` 的 `InstallDir`/`StateRoot`，以及 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar` 的 8 个标准值）与开始菜单/桌面快捷方式（指向 `<InstallDir>\Mizar.exe`）。
5. **Post（独立于 Commit，清理失败不影响成功）**：
   - 释放 `Global\MizarDesktop` 与 `Global\MizarUpdateActive`；
   - 若未传 `--no-launch`：生成一次性事件 `Local\MizarUpdateStarted-<32hex>`，注入环境变量 `MIZAR_UPDATE_READY_EVENT` 并**直接拉起真实新程序 `<InstallDir>\versions\<new_id>\Mizar.exe`**（不经由会立即退出的 Launcher），等待最多 60 秒：
     - 收到事件 → 启动确认成功；
     - 若真实新进程在收到事件前提前退出（且存在 `previous`）→ **自动将 `current.json` 翻回 `previous`**（若本次激活了新版 Core 素材，顺带调用现有 Resource Store 恢复 `previous` 资源快照），再拉起 `<InstallDir>\versions\<previous>\Mizar.exe`，结果记为 `rolled_back`（exit `16`）；
     - 若 60 秒超时但进程仍存活 → 保留新版不强杀，记告警并结束；
   - **延迟清理（尽力而为）**：删除 `versions\` 下除 `current` 和 `previous` 之外的更早版本目录（递归删除前**必须**检查每一级不含 `FILE_ATTRIBUTE_REPARSE_POINT` / junction），清理 `staging\`；任何清理失败仅写入 `cleanupWarning`，返回 exit `0`。

### 4.4 Resource Store 独立入口（`scripts/web-installer/installed-entry.mjs`）
- **删除**：`const { buildApp } = await import('../app.js')`、`app = buildApp(...)`、`await app.ready()`。
- **替换为**：
  ```js
  import { ResourceStore, defaultResourceRoot } from '../resource-store/store.js';
  import { createRuntimeVerifier } from '../resource-store/runtime-adapter.js';

  const store = await ResourceStore.open({
    root: defaultResourceRoot(),
    diagnostic: (packId, error) => { /* 写 stderr 脱敏日志 */ },
    verifyTrustedPack: createRuntimeVerifier(undefined, undefined, {
      appVersion: artifact.appVersion,
      gitSha: artifact.gitSha,
    }),
    // 安装器执行时已持有全局写入锁且旧版已退出，直接执行激活并返回 true
    activateWhenSafe: async (commit) => {
      await commit();
      return true;
    },
  });
  try {
    // 保留现有 restoreResourceAuthorization / authenticatePublishedBootstrap / installOfficialPack 逻辑
  } finally {
    await store.shutdown();
  }
  ```

### 4.5 Host（`main.rs`、`updates.rs`、`windows_startup.rs`）与 Companion（`routes.ts`、`manager.ts`）瘦身
1. **`apps/desktop/src-tauri/src/main.rs`**：
   - 将 `updates::launch(...)` 从 `start_gui()` 中移出到 `main()` 顶层，彻底脱离 `startup_failed` 与 `startup_recovery::show`（CS2 恢复）：
     ```rust
     // start_gui() 仅返回桌面会话是否正常退出及待执行的更新信息
     if let Some(pending) = ready_update {
         if let Err(err) = updates::launch_applier(&pending, &desktop_mutex, &log) {
             log.event("update_handoff_failed", "failure", Some(&err));
             // 接力未开始且子进程已确认停止：直接重启旧版 Mizar，绝不进 CS2 恢复
             drop(desktop_mutex);
             restart_self(&root, &args, &log);
         }
         return;
     }
     ```
2. **`apps/desktop/src-tauri/src/updates.rs` & `windows_startup.rs`**：
   - **删除**：`PendingUpdate` 中的 `attempt`、`generation`、`gui_ticket`、`recover_plan`、`check_on_startup` 孤儿恢复、`recheck`、`cancel` 的多轮 HTTP 握手，以及 `UpdateHandoff`（`ReadyEvent`）。
   - **保留并简化**：
     - Host 请求 Companion `POST /operator/updates/install-plan`（仅 1 个接口，检查 OBS 推流/录制并返回已验签的新包路径、版本、sha256、contentDigest 及 Core 资源参数）；
     - Host 在退出前调用新安装包静默解包模式（`Setup.exe /S /MIZAREXTRACT=<temp_dir>`），将完整新载荷与新包 `mizar-applier.exe` 解压至 `%LOCALAPPDATA%\Mizar\updates\extract-<nonce>\`；
     - Host 走现有正常退出流程（OBS/CS2 制播收尾 + 停止 Companion）；
     - 调用 Win32 `CreateProcessW` + `InitializeProcThreadAttributeList` + `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &[desktop_mutex_handle])` 拉起 `<temp_dir>\mizar-applier.exe apply-update --payload-dir <temp_dir> ...`，**将 `stdout`/`stderr` 重定向到 `%LOCALAPPDATA%\Mizar\logs\applier-launch.log`**；
     - **`CreateProcessW` 失败**：记录日志、释放句柄并直接重启旧版（绝不进 CS2 恢复）；**`CreateProcessW` 成功**：Host 立即正常退出，不再额外等待 1 秒（接管后由 Applier 负责，若 Applier 意外崩溃用户仍可通过 Launcher 正常打开当前版本）。
3. **`apps/companion/src/updates/routes.ts` & `manager.ts`**：
   - `routes.ts`：删除 `updateOwner`、`updatePreparing`、`updateReserved`、`recover`、`commit`、`recheck`、`release` 状态机，改为单一“检查安装资格 + 返回已验证包路径”接口（保留 OBS 推流/录制检查）。
   - `manager.ts`：`settings.json` 解析失败时改为 `rename` 归档为 `settings.json.corrupt-<ts>` 并使用默认配置，**不再设置 `settingsInvalid = true` 锁死整个更新系统**。
   - **保留**：GitHub + `gh-proxy.com` 双源探测回退、Sigstore / TUF 来源证明验证、防回退检查、Core/Full 识别。

### 4.6 前端外壳瘦身（Phase 1 保留向导与下载 UI，抽空事务）
1. **`scripts/qualification/windows-setup.nsi`**：
   - 保留 5 页简体中文向导（欢迎 / 安装目录 / 桌面快捷方式选项 / 进度 / 完成）与品牌图。
   - **全部删除**：`AcquireUpdateWriter`、`CheckRunning`、`update-handoff.ps1` 提取与所有 `Handoff` PowerShell 反调、`.mizar-update-owner`、`installed.flag`、调用旧 `Uninstall.exe`、注册表写入、开始菜单与桌面快捷方式创建、`Section "Uninstall"` 中的旧逻辑。
   - 新执行流程：支持两种模式——① 静默解包模式（`/S /MIZAREXTRACT=<dir>`）：仅将 `${PAYLOAD}\*` 解包至 `<dir>` 后退出（供内置更新与在线安装器提取新载荷与新 `mizar-applier.exe`）；② 交互/静默安装模式：将 `${PAYLOAD}\*` 解包至 `$PLUGINSDIR\payload`，随后 `ExecWait` 调用 `"$PLUGINSDIR\payload\mizar-applier.exe" install --payload-dir "$PLUGINSDIR\payload" --install-dir "$INSTDIR" --no-ui [--desktop-shortcut] --result-file "$PLUGINSDIR\result.json"`，根据退出码与 `result.json` 展示结果。
2. **`scripts/web-installer/Nsis.cs` & `Bootstrap.cs`**：
   - **删除**：`PendingInstall`、`fresh-install.pending`、`RecoverPending`、`RecoverUpdate`、`RollbackUpdateOwned`、`FinalizeUpdate`、`RetireUpdateState`、`NativeFailure` 字符串匹配、`update-install.ps1` 嵌入资源。
   - 新执行流程：`Bootstrap.cs` 下载并验证完安装包后，先用 `/S /MIZAREXTRACT=<temp_dir>` 解包，再调用 `<temp_dir>\mizar-applier.exe install --payload-dir <temp_dir> --install-dir <target> --expected-content-digest <digest> [--core-archive-sha256 ...] --no-ui --no-launch --result-file <result>`，按结构化结果展示完成/错误。

---

## 5. 分 PR 实施清单（严格按顺序，3 个 PR）

> **关于可选止血补丁**：仅当你计划在 `1.12.0` 之前再发一版 `1.11.x` 时才单独做（只改 `main.rs` 移出 CS2 恢复 + `updates.rs` 捕获 `stderr` + 接力失败重启旧版，**禁止**提前发 `ReadyEvent`）。若直接推进 `1.12.0`，跳过止血，直接从 PR 1 开始。

### PR 1：规范重写 + Rust Applier & Launcher + 手动安装路径切换
- **文档**：重写 `docs/reference/updates.md`，删除所有已废除的旧条款（旧版完整门禁、`Preserve-ExtraFiles`、设置损坏锁死、`RunOnce` 恢复、旧脚本交接）。
- **新增代码**：
  - `apps/desktop/installer/`（或对应 workspace crates）：实现 `mizar-launcher`（稳定 `Mizar.exe`）与 `mizar-applier`（`install` / `apply-update` / `uninstall`、原子 `current.json`、一次性旧目录归档迁移、轻原生 Win32 进度窗、junction 防护）。
  - `apps/desktop/src-tauri/src/main.rs`：窗口初始化后设置 `AppUserModelID` 与 `RelaunchCommand`。
- **修改代码**：
  - `scripts/qualification/build.mjs` & `create-windows-setup.ps1` & `.github/workflows/release-qualification.yml`：构建并打入 `mizar-launcher.exe` 与 `mizar-applier.exe`。
  - `scripts/qualification/windows-setup.nsi`：抽空事务逻辑，改为解包到 `$PLUGINSDIR` 后委托 `mizar-applier.exe install`。
  - `scripts/web-installer/Nsis.cs`、`Bootstrap.cs`、`build.ps1`：删除 `fresh-install.pending` 与 PowerShell 编排，改为委托新执行器并读结构化结果。
- **验收**：离线完整包与在线轻量包均通过新 `mizar-applier.exe` 完成全新安装、D 盘中文路径安装、从 `v1.11.27` 一次性迁移、覆盖修复与卸载。

### PR 2：独立 Resource Store + 内置更新接入新包 Applier
- **修改代码**：
  - `scripts/web-installer/installed-entry.mjs`：直接调用 `ResourceStore.open()`，移除 `buildApp()` 与 Fastify 依赖。
  - `apps/desktop/src-tauri/src/main.rs`：将更新启动移出 `start_gui()` 的 `startup_recovery`（CS2 恢复）通道。
  - `apps/desktop/src-tauri/src/updates.rs` & `windows_startup.rs`：删除 5 步握手与 `ReadyEvent`，实现 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 继承 `Global\MizarDesktop` 拉起新包 `mizar-applier.exe` 并记录 `stdout/stderr`。
  - `apps/companion/src/updates/routes.ts` & `manager.ts`：删掉多阶段预留状态机，损坏 `settings.json` 改归档重建。
  - `scripts/qualification/update-release.json`：将 `minimumVersion` 设为新架构版本号（如 `1.12.0`）。
- **验收**：内置一键更新端到端跑通（含 Core + Resource Pack）、旧版客户端正确识别不兼容并进入 `manual` 提示、新版启动失败自动翻指针回退旧版。

### PR 3：彻底删除旧实现 + 精简实机验收
- **删除文件/代码**：
  - 整文件删除 `scripts/qualification/bundle/update-install.ps1`（1,749 行）；
  - 删除 `apps/desktop/src-tauri/src/updates.rs` 中手写 HTTP 客户端与全部遗留死代码（复用 `companion_http.rs`）；
  - 清理 `scripts/qualification/verify-update-recovery.mjs` 中针对旧 PowerShell / `RunOnce` / `legacy handoff` 的废弃用例，替换为第 6 节的 10 条核心实机验证。

---

## 6. Windows 实机关键路径验收清单（10 条必过）

1. **全新安装（默认路径 + D 盘中文路径）**：目录生成 `Mizar.exe`、`current.json`、`versions\<id>\`，快捷方式与控制面板卸载项正常，正常启动。
2. **旧版一次性迁移（`v1.11.27` → `v1.12.0`）**：旧目录整体归档为 `*-legacy-*`，历史自放文件未丢，旧 `RunOnce\!MizarUpdateRecovery` 被清理，用户 `%LOCALAPPDATA%\Mizar` 资料完好。
3. **正常内置一键更新（Full & Core+素材包）**：旧版退出后由新包 `mizar-applier.exe` 接管，原子切换 `current.json`，新版启动确认成功。
4. **损坏重装（删掉旧版 `Mizar.exe` 或篡改 `artifact.json`）**：覆盖安装直接成功，不拒绝升级，用户资料保留。
5. **Applier 提前退出（模拟 exit code 1）**：Host 捕获完整 stderr 到日志，**不进入 CS2 恢复界面**，自动重启旧版继续可用。
6. **进度窗创建失败（模拟 UI 异常）**：降级无窗完成安装，不中断事务。
7. **文件占用（资源管理器打开旧版目录）**：新版本解包与 `current.json` 切换照常成功；旧目录清理失败仅记录 `cleanupWarning`，不报安装失败。
8. **新版启动秒崩自动回退**：模拟新版进程启动后 1 秒内 exit 1，Applier 自动将 `current.json` 翻回 `previous` 并拉起旧版。
9. **制播保护**：OBS 推流/录制中发起内置更新被拦截；正常停播后更新顺利完成。
10. **卸载保留资料**：通过控制面板卸载后程序目录、快捷方式、注册表清空，`%LOCALAPPDATA%\Mizar` 与用户挂载的 junction 目标目录完好无损。
11. **用户取消安装**：在 Stage/Quiesce 阶段取消后清理暂存，返回 `cancelled`，原版本继续正常可用。
12. **安装过程中断**：在解包或切换前强杀 Applier 进程，重新打开软件或再次运行安装器均能正常使用或直接覆盖重装。

---

## 7. 历次讨论沉淀的 6 条工程最佳实践

1. **区分“本质复杂度”与“偶然复杂度”**：保留 TUF/Sigstore 验签、国内镜像回退、Core+素材包、OBS/CS2 门禁；砍掉所有跨语言反调、分布式多阶段预留和重复状态机。
2. **绝不用“对抗同用户攻击者”的威胁模型写用户态桌面安装器**：保留防误删（junction 检查、PID+StartTime）和包真实性校验，其余异常一律 **Fail-Open for Recovery**（归档/重建/允许覆盖重装），绝不把正常用户锁死在报错里。
3. **打破引导悖论**：安装/更新执行器永远随新包分发并在验签后执行，绝不让旧版代码去承担新版安装逻辑。
4. **用 OS 语义替代用户态脆弱协议**：用内核句柄白名单继承替代 `ReadyEvent` 竞态等待；用 Side-by-side 版本目录 + 原子指针替代易被句柄锁死的两次目录重命名。
5. **先修退路，再切主路径**：先让手动离线/在线安装器切到新执行器，确保用户任何时候都有 100% 可靠的覆盖重装退路，再切换自动更新。
6. **规范文档先瘦身，再让 Agent 动手**：先删掉 `docs/reference/updates.md` 里的历史防御条款，再让代码 Agent 实现，否则 Agent 会忠实按照旧文档把复杂度重新写回来。
