# AboutSecurity 技能库：独立按需安装与模型检索

来源：[wgpsec/AboutSecurity](https://github.com/wgpsec/AboutSecurity)。本维护分支**不重新分发上游技能正文**，也不默认安装上游。上游仓库检查时没有根目录 LICENSE 文件；使用、再分发应先核对上游权利声明。

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

脚本不挂在 `postinstall` 或插件启动过程上，不关闭 DSH，不更新宿主补丁，不改变现有资产、漏洞、凭据与任务台账。Git 拉取失败会报告错误，旧安装保持现状；首次安装失败时只清理由该次命令创建的外部技能检出目录。

## 在 DSH 的作战模式里使用

1. `redteam_skill_search(query="OSINT")` 列出相关技能，也可以传空查询列出最多 50 项。
2. 结果会给出稳定 `key`，如 `aboutsecurity:recon/passive-recon`。
3. `redteam_skill_read(key="aboutsecurity:recon/passive-recon")` 读取 Markdown 技能正文。

无外部安装时仍可检索 `redteam:web-injection` 等 purge 自带技能。上述两个模型工具只读本地，技能正文不会在搜索阶段整篇塞进上下文，只有实际读取时才会返回。

## 兼容边界

- 目前是**模型工具级别的技能检索和读取**，不等同于已通过 DSH 官方 `skills.registerProvider` 注册或经过端到端模型调用验收。
- REA 的既有集成原样保留。AboutSecurity 与 REA 是不同来源，不会因安装其中一个而覆盖另一个。
- 不能仅凭 `SKILL.md` 存在断言其中依赖的程序、环境变量或接口已经可用。需要执行时，仍用现有 `redteam_preflight` 或实际运行结果判断。
- 后续如需在「管理 → 技能库」增加按钮、状态与原生 Provider，可复用当前下载目录和工具，不再建第二套管理数据库。
