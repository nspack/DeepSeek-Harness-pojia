# AboutSecurity 技能库：独立按需安装与模型检索

来源：[wgpsec/AboutSecurity](https://github.com/wgpsec/AboutSecurity)。本维护分支**不重新分发上游技能正文**，也不默认安装上游。上游仓库检查时没有根目录 LICENSE 文件；使用、再分发应先核对上游权利声明。

## 作战台图形界面（本轮新增）

在 **dsh-purge → 作战台 → 管理 → 技能库** 中，可以直接查看 **AboutSecurity 扩展技能库**：

- **从上游安装**：显式点击后，通过本机 Git 稀疏检出 `wgpsec/AboutSecurity` 的 `skills/`，只安装到当前 `DSH_HOME`；插件启动时不会自动下载。
- **更新技能**：已有 Git 安装目录时按需执行快进更新；安装/更新进度会在页面显示，完成后刷新技能目录。
- **检查状态**：显示是否安装及本机可检索技能数量。
- **浏览正文**：左侧列表有独立的 AboutSecurity 分类，选择条目可以查看 Markdown；宿主提供原生 Skills 服务时，安装后自动注册并在列表中显示“宿主已列出”。没有这个服务时仍能通过 `redteam_skill_search` / `redteam_skill_read` 读取。

需要 Git 可执行程序在运行 DSH 的那台 Windows/Linux 设备的 PATH 里；若缺少 Git，页面会给出明确错误，不影响已有功能。

## 一次安装

在当前 `dsh-purge` 仓库根目录或其完整安装包目录运行（需能访问 GitHub，且本机有 Git）：

```powershell
node scripts/install-aboutsecurity.mjs
```

默认 DSH_HOME 取环境变量，否则取当前用户目录的 `~/.dsh`。若宿主 DSH_HOME 不在默认位置，指定实际目录：

```powershell
node scripts/install-aboutsecurity.mjs --home "D:\MyDSH"
```

脚本使用 Git `--sparse`，只检出上游的 `skills/` 工作目录至：

```
$DSH_HOME/redteam/external-skills/aboutsecurity/skills
```

已安装时不会覆盖当前副本。用户明确希望更新时才执行：

```powershell
node scripts/install-aboutsecurity.mjs --update
```

### 卸载

```powershell
node scripts/install-aboutsecurity.mjs --remove
```

只删本脚本创建的那一个检出目录（`$DSH_HOME/redteam/external-skills/aboutsecurity`），三条例外一律拒绝：

- 路径不在 `$DSH_HOME/redteam/external-skills/` 下 → 拒绝；
- 目录里没有 `.git`（不是本脚本的检出，例如你自己放的同名目录）→ 拒绝，文件原样保留；
- 目录不存在 → 打印 `Nothing to remove` 并退出 0，不创建任何东西。

卸载后作战台的 AboutSecurity 分类会消失；`redteam_skill_search` 也不再返回对应条目。宿主的原生技能列表需要下一次刷新才同步。图形界面里同样有安装/更新状态，卸载走上面这条命令（界面不提供删除按钮，避免误点）。

脚本不挂在 `postinstall` 或插件启动过程上，不关闭 DSH，不更新宿主补丁，不改变现有资产、漏洞、凭据与任务台账。Git 拉取失败会报告错误，旧安装保持现状；首次安装失败时只清理由该次命令创建的外部技能检出目录。

## 原生技能提供器

本插件现在可以通过 `dsh-purge-aboutsecurity` 原生 Provider 发布 AboutSecurity 技能；为避免与原有插件/用户技能重名，原生名称带 `aboutsecurity-` 前缀，例如 `aboutsecurity-recon-passive-recon`。原来的稳定工具检索键 `aboutsecurity:recon/passive-recon` 仍然可用。技能只从本机安装目录读取，**不会在宿主启动时自动下载**。

## 在 DSH 的作战模式里使用

1. `redteam_skill_search(query="OSINT")` 列出相关技能，也可以传空查询列出最多 50 项。
2. 结果会给出稳定 `key`，如 `aboutsecurity:recon/passive-recon`。
3. `redteam_skill_read(key="aboutsecurity:recon/passive-recon")` 读取 Markdown 技能正文。

无外部安装时仍可检索 `redteam:web-injection` 等 purge 自带技能。上述两个模型工具只读本地，技能正文不会在搜索阶段整篇塞进上下文，只有实际读取时才会返回。

## 兼容边界

- 下载进程在宿主后台执行并由界面轮询状态；不影响其他技能显示。用户明确点击才会发起 Git 网络请求。


- 原生接线采用上游公开的 `ctx.inject(['skills'])` / `skills.registerProvider()` 接口，插件启动时已有本地技能则注册，页面安装或更新成功后同步刷新；安装失败时保留旧的可用注册。**是否在当前宿主真正可调用仍以 `skills.list` 的结果和 Desktop 实机为准**，不能仅因本地文件存在就宣称成功。
- REA 的既有集成原样保留。AboutSecurity 与 REA 是不同来源，不会因安装其中一个而覆盖另一个。
- 不能仅凭 `SKILL.md` 存在断言其中依赖的程序、环境变量或接口已经可用。需要执行时，仍用现有 `redteam_preflight` 或实际运行结果判断。
- 如果使用独立命令行脚本在 DSH 运行期间安装或更新（而不是使用作战台按钮），原生 Provider 可能需要重启宿主后才能重新注册；模型工具的本地检索不受影响。
