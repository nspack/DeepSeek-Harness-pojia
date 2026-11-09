# 1.1.92-wxcvm.5

## 中文

- **ARTEX 只读集成**：清理台自动识别本机 ARTEX Desktop 布局，复用其**已安装**的 Go 后端与工具路径；只读解析、不改 ARTEX 配置、不启动其进程，受保护目录与离线共享盘分别标注。
- **清理台增强**：补丁可搜索；新增只读补丁重扫；诊断结果可筛选导出；同一补丁下子状态不一致时显式显示「混合」，不再用父状态覆盖。
- **CVE 候选更硬**：候选匹配只认实际观测到的指纹，不再靠版本号猜；新增伏匠离线 CVE 索引；任务上下文里直接带出相关 CVE 与技能提示。
- **AboutSecurity 技能库（可选）**：界面「管理 → 技能库」可显式安装/更新上游 `wgpsec/AboutSecurity` 的 `skills/`，启动与 `postinstall` 都不会自动拉取；新增 `node scripts/install-aboutsecurity.mjs --remove` 卸载，只删本脚本创建的检出，遇到非 git 目录一律拒绝（4 条守卫用例覆盖）。
- **装配契约**：`rewritePromptAssembly` 不再凭空补 `tools` 字段，`interpolate:false` 的正文逐字保留，装配失败原样冒泡；用例由 `test-pending/` 收编进 `test/prompt-compat.test.mjs`。
- **Windows 桌面**：新增插件注册校验；pnpm junction 场景下的**完整回滚**已被自动化测试覆盖。
- **测试口径统一**：`npm test` 固定为 `node --test test/*.test.mjs`，与 CI 的显式文件清单一致（裸 `node --test` 会把需要真实宿主的手工脚本当测试跑）。另提供 `test:pending` / `test:all`。
- **仍未验证**：真实 Windows Desktop 的升级/回滚、AboutSecurity 技能的模型实际调用、ARTEX 布局差异、以及长时间演练下的性能表现。

## English

- Read-only ARTEX integration: reuse locally installed ARTEX tool paths, never mutate its config or start its processes.
- Cleaning console: searchable patches, read-only rescan, filtered diagnostic export, honest mixed child states.
- CVE candidates now require observed fingerprints; add the offline Fujiang index and surface CVE/skill hints in task context.
- Optional AboutSecurity skill library with explicit install/update and a guarded `--remove` (only the checkout this script created; non-git directories are refused).
- Prompt assembly contract: no invented `tools`, literal `interpolate:false` bodies, assembly errors bubble up unchanged.
- Windows desktop: plugin registration validation and a full pnpm-junction rollback test.
- `npm test` now uses the same explicit glob as CI; `test:pending` / `test:all` remain available.
- Still unverified: real Windows Desktop upgrade/rollback, live model invocation of AboutSecurity skills, ARTEX layout variants, long-running performance.

# 1.1.92-wxcvm.4

## 中文

- **Windows Desktop 升级故障恢复**：升级前完整保存旧插件文件与 profile 关键配置，记录 SHA-256；失败时先尝试按原锁文件重装依赖，如无法恢复，再使用插件快照。被占用或部分回退失败会保留备份与错误，**不宣称真实 Desktop 已通过验收**。
- **源码诊断更准确**：优先与已安装版本对应的 GitHub Release 标签比较 6 个关键文件，不再默认用持续变化的 master 误判旧发布版；UI 显示比较基准。标签不存在才回退 master。
- **可选分享版报告**：命令行报告增加 `--shareable`，基础脱敏常见凭据、目标名称和 IPv4，省略原始截图，原版完整导出不变。自动脱敏并不等于完整匿名，分享前仍需人工复核。
- **交付核对总账**：`docs/DELIVERY_AUDIT.zh-CN.md` 对照旧备份、研究结论、已修复项与真实 Desktop 验收缺口。
- **固定安装来源**：桌面安装深链与 package.json 内的发布包 URL 指向本次 `v1.1.92-wxcvm.4` 标签，避免版本号与 master 漂移导致包内容不一致。
- **测试与发布**：Windows/Linux 宿主兼容矩阵保持不变，发布文件同时提供 ZIP 与 SHA256SUMS.txt。默认依然为 fork 手动发版；本次仅使用精确指定的单次发布提交。
- **仍未验证**：用户真实 Windows Desktop 的 DSH profile、技能的实际模型调用、更新与回滚时的真实 pnpm junction、进程占用场景。

## English

- Snapshot prior plugin files and profile metadata before updating on Windows; verify hashes and restore files after failed pnpm recovery.
- Compare installed key files with the exact release tag rather than moving master.
- Opt-in `--shareable` report bundle with basic masking and omitted screenshot evidence; full original export remains unchanged.
- Add a concrete historical-backup/delivery audit ledger.
- Pin release install metadata and desktop deep links to `v1.1.92-wxcvm.4` rather than branch HEAD.
- Publish SHA256SUMS.txt alongside the GitHub Release ZIP; real Desktop integration acceptance remains pending.
