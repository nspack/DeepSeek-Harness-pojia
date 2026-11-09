# 作战台工具逐个注释（redteam_* 全量）

> 本文档目前人工维护。新增或删除工具时需同步修改，`test/tool-surface.test.mjs` 会检查工具名称与文档覆盖；不存在自动生成脚本。

具体工具数量及定义以 `lib/redteam/tools.js` 为准。分组只是使用习惯，不是权限边界。

## A. 开局与调度（主会话/指挥用）

_一次演练只开一个靶标；子智能体并发上限默认 3，派活前先占位。_

### `redteam_engagement_open`
打开或创建一次攻防演练靶标（按单位名称），并把**当前会话**绑定到该靶标（子智能体会自动继承）。后续所有资产工具默认作用于它。若靶标已存在则复用其资产库。写入的是本会话的绑定，不会改动其它会话正在用的靶标。

参数：
- `target` — 靶标单位名称，例如「示例科技有限公司」
- `scope` — 授权范围 CIDR 列表（可选：用户没给就不用问，按公开可见资产面自主推进）

### `redteam_session_bind`
把一个**已经存在**的靶标绑定到当前会话（多会话并行时用：每个会话绑自己的靶标，互不串写）。可用靶标 id 或单位名称，省略则列出可绑定的靶标。

参数：
- `engagement` — 靶标 id 或单位名称；省略只列出候选

### `redteam_session_info`
查看**当前会话绑定的是哪个靶标**（会话 id、父会话、根会话、绑定链）。多会话同时开工时，先跑它确认自己没串到别人的靶标上。

### `redteam_task_context`
对资产/关联漏洞任务卡，现在会一起返回最多 3 条公开 CVE 候选（`knowledge_candidates`）及本机已安装的相关技能摘要（`related_skills`）。它们复用 `redteam_cve_match`、`redteam_skill_search` 的只读索引，不修改数据库、不会因候选命中就确认漏洞，也不启动自动扫描。

【只读】把 `redteam_next_action` 返回的 `focus.target` 或 `focus.task_key` 直接作为输入，一次读取核查目标的必要上下文，减少多次查库。

参数：
- `engagement` — 当前靶标（默认会话绑定的靶标）
- `target` — 必填，`asset #8` / `vuln #12`，或者带动作前缀的 `focus.task_key`

返回内容：
- 资产任务：资产 IP、开放端口概要、最近三条测试记录、受阻次数、关联漏洞摘要以及直接挂在资产上的 HTTP 证据索引。
- 漏洞任务：该漏洞摘要、关联资产测试状态、按 `vuln_id` 关联的 HTTP 证据索引。
- 原始 HTTP 请求/响应**不会**放进任务上下文；需要时用 `redteam_http_evidence_query(id=...)` 取具体证据。
- 仅支持带 ID 的任务目标。其它任务仍按 `first_tool` 指引调用对应工具；本工具不执行扫描、不改变状态或分数。

### `redteam_task_block`
当前演练的**持久阻塞任务记录**，与 `redteam_next_action` 共享 SQLite。只有确认了真实阻塞原因才写入；不会自动执行测试或记分。

参数：
- `engagement` — 可选，默认当前会话演练
- `action` — 必填，`block` 记录阻塞、`unblock` 解除、`list` 查看已阻塞任务
- `task_key` — `block` / `unblock` 时必填，原样传入 `focus.task_key`
- `reason` — `block` 时必填，写清确切阻塞原因或缺失条件
- `limit` / `offset` — `list` 的分页参数，默认 30 条，最多 100 条

后续 `redteam_next_action` **自动读取**所有持久阻塞键；`previous_task` 与临时 `blocked_task_key(s)` 保持只读、不会自动落库。条件发生变化后要明确 `unblock`，不把暂时故障永久封禁。

### `redteam_agent_slot`
【主会话派活前后用】执行智能体的并发闸门：同一靶标**最多同时 3 个**在跑（可用 REDTEAM_MAX_AGENTS 配置）。action=status 看还剩几个名额与谁在跑；action=acquire 占一个名额（满了会直接拒绝，**不要重试硬塞**）；action=release 释放（子智能体结束时服务端也会自动释放）。

参数：
- `action` — status 查看 / acquire 占用 / release 释放
- `label` — acquire 时的任务标签，例如「信息收集：主域与 C 段」
- `key` — release 时指定要释放的键（省略则释放最早的一个预留）

### `redteam_preflight`
【开工前必须跑一次】平台技能与资源自检：逐个检查红队技能的必需环境变量（如 FOFA 测绘的 FOFA_KEY）、本机工具与二进制（suo5 / fscan / gogo / frp / 冰蝎 / 哥斯拉 / nmap / nuclei…）、外部基础设施（反弹 Shell 用的 VPS）。返回 available/broken 清单与每个坏掉的技能"缺什么、怎么补"。**缺 key / 缺 VPS 时直接向用户要，或改用替代方案，不要假装能跑。**

参数：
- `include` — 只检查这些技能（逗号分隔）；省略则检查全部红队技能

### `redteam_roles`
列出红队角色及其职责标题（信息收集 / 漏洞检测 / 漏洞利用 / 内网渗透）。

### `redteam_role_prompt`
取出某个红队角色当前生效的系统提示词，只供查看。派活时不要把全文抄进任务；在 subagent 的 prompt 第一行写 redteamRole: <code>，角色稿会进入子会话系统提示词。

参数：
- `engagement`
- `role`

### `redteam_role_prompt_reset`
把角色系统提示词恢复为内置默认（新版模板）。老靶标想用上最新版角色提示词时用它；省略 role 则四个角色全部重置。

参数：
- `engagement`
- `role`

## B. 资产测绘（recon / assess 用）

_每条资产必须带 provenance（passive/active）与 tool；assess 阶段用 asset_assess 打 priority/potential/reason。_

### `redteam_asset_add`
把一个资产及其端口/服务/指纹写入资产库（幂等 upsert）。每条发现必须标注 provenance：被动收集填 passive，主动探测填 active，并填写 tool（数据源或工具名）。

参数：
- `engagement` — 靶标 id；省略则用当前会话绑定的靶标
- `ip` — 资产 IP（IPv4）
- `state` — live | dead | unknown，默认 unknown
- `primary_name` — 主域名/主机名
- `provenance` — 本条发现的来源：被动或主动
- `tool` — 数据源或工具名，例如 crt.sh / nmap / nuclei / curl
- `discovered_at` — 【可选】这条资产的发现时间（ISO，如 2026-09-17T09:30:00Z）。不填则按"第一次入库的时刻"自动记录；数据源给出历史首次出现时间时传进来更准。**重复采集不会覆盖它**。
- `first_seen` — 【可选】数据源/工具报告的首次出现时间（与发现时间分开记）
- `properties` — domain | hostname | cert_cn，默认 domain
- `port`
- `proto` — tcp（默认）| udp
- `service` — 服务名，例如 http / mysql
- `product` — 产品名，例如 nginx
- `version` — 版本，例如 1.24.0
- `banner` — 原始 banner 片段
- `url` — Web 服务可直接访问的完整 URL，例如 https://oa.example.com:8443/portal
- `title` — Web 页面标题（HTTP 探测获取），例如「致远OA 登录」
- `provenance`
- `tool`
- `properties` — Web服务器 | 中间件 | 框架 | CMS | 数据库 | VPN网关 …

### `redteam_asset_query`
检索资产库。支持按 C 段、端口、服务、指纹、来源、内外网维度（scope）、排序（sort）、关键词（全文，覆盖 IP/域名/banner/服务/指纹）过滤。返回紧凑结果，含每个资产的开放端口与指纹及内外网归属。

参数：
- `engagement`
- `cidr` — C 段，例如 203.0.113.0/24
- `port` — 开放端口
- `service` — 服务/产品名关键词，例如 nginx
- `fingerprint` — 指纹关键词，例如 Tomcat / Spring
- `provenance` — 只看被动或主动来源
- `q` — 全文检索词（空格分隔多词为 AND）
- `state`
- `scope` — 内外网维度：internal=内网/私网地址，external=互联网可达
- `sort` — 排序：priority=易打性优先（默认），todo=待测优先，ports=端口多优先，ip=按 IP
- `limit` — 返回条数上限，默认 50，最大 200

### `redteam_asset_get`
取单个资产的完整详情：全部端口与服务、指纹、采集溯源时间线、关系边。用于深入分析某个目标。

参数：
- `engagement`
- `id` — 资产 id（来自 redteam_asset_query 结果）

### `redteam_skill_search`
【离线只读】检索当前 purge 随包技能，以及按需下载到 `$DSH_HOME/redteam/external-skills/aboutsecurity/skills` 的 AboutSecurity 技能。不需要另外安装 `dsh-prompt-custom` 插件。

参数：`query`（名称/主题/关键词；空值列出）、`limit`（默认 10，上限 50）。

返回稳定 `key`、名称、描述与来源，另外用 `aboutsecurity_installed` 明确该外部技能库是否已找到。没有安装外部技能时仍能搜索内置技能。

### `redteam_skill_read`
【离线只读】根据上一步的 `key` 读取技能 Markdown 正文；不会执行技能里面的命令，也不允许任意文件路径读取。查询结果里的 `key` 是唯一入口。

参数：`key`（必填，如 `aboutsecurity:recon/passive-recon` 或 `redteam:web-injection`）、`max_chars`（默认 16000）。

AboutSecurity 下载/更新命令见 [独立集成说明](ABOUTSECURITY_INTEGRATION.md)。

### `redteam_cve_match`
【离线只读】按现有 SQLite 资产的服务、指纹、产品与端口，或直接输入 CVE / 产品名，查找随包公开漏洞候选索引。只返回候选与原始资料链接，**不执行 PoC、不联网、不写漏洞库、不自动确认成功**。同产品命中不代表版本确实受影响。

参数：
- `asset_id` — 可选；传 `redteam_asset_query` 的资产 id 后读取现有资产详情
- `engagement` — 只有使用 `asset_id` 时才需要；可省略以继承会话绑定靶标
- `cve` — 可选，精确匹配如 `CVE-2021-44228`
- `product` / `banner` / `fingerprint` / `keyword` — 可选，附加产品、指纹或文字检索
- `port` — 观察到的端口，仅作为匹配加分，不能单独产生漏洞候选
- `limit` — 返回条数，默认 10，最多 30

示例：先 `redteam_asset_query` 找到资产 id，再 `redteam_cve_match(asset_id=12)`；没有数据库也可以 `redteam_cve_match(product="Grafana", port=3000)`。用 `redteam_poc_search` 查本地已验证 PoC / Nuclei 模板；这两套检索互补，不会相互覆盖。

### `redteam_data_quality`
只读核对资产库记录的完整性：区分候选漏洞缺证据与已确认/利用记录缺证据，统计 HTTP 请求/响应为空，以及漏洞、HTTP 证据、截图中的资产/漏洞孤立引用。只返回汇总数量，不返回原始证据或凭据，不迁移数据库，也不把记录完整当成漏洞已验证。

参数：`engagement`（可选；省略时继承当前或父会话靶标）。输出 `quality.status`、`quality.totals`、`quality.counts`、`quality.issues`。

### `redteam_asset_stats`
资产测绘概览：C 段数、资产数（存活）、开放端口、服务、指纹、被动/主动溯源条数，以及各 C 段的明细。

参数：
- `engagement`

### `redteam_asset_timeline`
资产「发现时间」视图：按天聚合"哪天收了多少资产"（区分内网/外网），并列出最近发现的资产。用于回答"这个资产是什么时候发现的"、检查信息收集有没有断层，也用于本轮收集的收口核对。

参数：
- `engagement`
- `limit` — 最近资产条数，默认 50

### `redteam_asset_graph`
导出资产图谱（C 段 → 资产 → 开放端口，含域名解析边），用于拓扑推理与横向移动路径规划。节点数超过上限时按 C 段缩小范围。

参数：
- `engagement`
- `cidr` — 只取某个 C 段的子图
- `maxNodes` — 节点上限，默认 300

### `redteam_asset_link`
在资产库中写入一条关系边（图谱与后续横向分析共用）。relation 例如 resolves / exposes / contains / trusts / shares_cert。

参数：
- `engagement`
- `src_kind` — segment | asset | domain | port …
- `src_id`
- `dst_kind`
- `dst_id`
- `relation`
- `confidence`

### `redteam_asset_assess`
给资产做「易打性评估」：预期能拿下哪些成果（账号权限/RCE/服务器权限/数据库权限/敏感数据/边界突破）、优先级多高、判断理由。信息收集收口时对每个资产调用一次，供指挥者按性价比排序。

参数：
- `engagement`
- `asset_id`
- `ip`
- `priority` — high 容易出成果 / medium 一般 / low 难打或价值低
- `potential` — 预期成果，如「账号权限+RCE」「数据库权限」「大量敏感信息」
- `reason` — 判断理由：指纹版本命中 Nday、接口未鉴权、口令弱、暴露数据库、WAF 强弱等
- `assessed_by`

### `redteam_asset_test`
记录对某个资产的测试情况：本次做了什么测试（`test`，追加式）、还剩什么攻击面（`surface`，覆盖式）、当前测试状态、是否被 WAF 封禁。**每个资产开始测之前先调一次（status=testing），测完/放弃再调一次**——资产测绘页面据此显示「未测试 / 测试中 / 已测试 / 被封禁 / 已放弃 / 无攻击面」。排除结论、登录失败原因、重测理由都写在 `test` 里。

参数：
- `engagement`
- `asset_id` — 资产 id（与 ip 二选一，优先 asset_id）
- `ip` — 资产 IP
- `status` — 测试状态：未测试/测试中/已测试/被封禁/已放弃/无攻击面
- `test` — 本次做了什么测试（**追加**到测试记录，例如「nmap 全端口 + nuclei cve 模板 + 接口越权」）。排除结论、登录失败原因、重测理由都写这里。
- `notes` — test 的兼容别名（老提示词里的写法），效果与 test 相同，会一并追加到测试记录。
- `surface` — 还剩什么攻击面可测（覆盖式，例如「SMB 445 未测；Web /api 未做越权」）
- `blocked` — 本次是否被 WAF/防护封禁（true 时封禁计数 +1）
- `updated_by` — 记录角色，例如 recon / vuln-scan

### `redteam_domain_index`
按域名维度聚合资产：每个域名关联了哪些 IP/资产。用于梳理主域名、子域与 C 段的关系。

参数：
- `engagement`

### `redteam_web_list`
列出 Web 资产（含可直接访问的 URL 与页面标题）。做 Web 渗透前先看这里，优先从接口入手。

参数：
- `engagement`
- `cidr`
- `limit`

## C. 漏洞与证据（vuln-scan / exploit 用）

_confirmed/exploited 才算成果；claimed 必须用 evidence_upgrade 升级成 observed 才能进报告。_

### `redteam_vuln_add`
记录一条漏洞发现（漏洞检测角色）。带 cve 时按 (asset_id, cve, target) 幂等更新。severity：critical|high|medium|low|info；status：candidate（待验证）|confirmed（已验证）|false-positive|exploited|fixed。必须附证据（请求/响应片段、复现命令、证据文件路径）。

参数：
- `engagement`
- `asset_id` — 资产 id（来自 redteam_asset_query）
- `cve` — CVE / CNVD 编号（无编号可省略）
- `title` — 漏洞标题
- `severity`
- `status`
- `target` — 受影响的目标，如 https://host:443/path 或 ip:port
- `source` — 发现方式：nuclei / sqlmap / curl / manual …
- `confidence` — 0–1
- `evidence` — 证据：请求/响应摘要、命令、证据文件路径
- `found_by_agent` — 发现角色，默认 vuln-scan
- `gained` — 【重要】通过这个漏洞拿到了什么权限/成果，写得分口径的短标签，多项用顿号或逗号分隔，例如「服务器权限、内网隧道」「后台管理员账号」「数据库权限」

### `redteam_vuln_query`
检索漏洞库：按严重级、状态、CVE、资产、C 段或关键词过滤。用于挑选待利用目标或核对误报。

参数：
- `engagement`
- `severity`
- `status`
- `cve`
- `asset_id`
- `cidr`
- `q` — 标题/CVE/目标/证据关键词
- `limit` — 默认 50，最大 200

### `redteam_candidate_queue`
只读领取按证据准备程度分类的候选漏洞队列：ready（已有证据待核对）、needs_evidence（缺可复核证据）、needs_scope（缺资产关联）、deferred（失活或阻塞目标）。返回全量分类计数与分页后的候选 ID；不会自动确认漏洞、执行扫描或计分。

参数：
- `engagement`
- `category` — ready / needs_evidence / needs_scope / deferred，默认 ready
- `limit` — 默认 15，最大 50
- `offset` — 从 0 开始分页，返回 nextOffset

### `redteam_vuln_update`
更新漏洞状态/严重级/证据（例如验证后置为 confirmed、利用成功后置为 exploited、误报置为 false-positive）。

参数：
- `engagement`
- `id` — 漏洞 id
- `status`
- `severity`
- `evidence`
- `confidence`
- `gained` — 通过这个漏洞拿到了什么权限/成果（得分口径短标签，多项用顿号分隔）
- `title`

### `redteam_http_evidence_add`
保存一条 HTTP 证据：原始请求与响应。报告会把它渲染成可粘贴进 Burp Suite / Yakit 的原始报文，因此 request 必须是完整可重放的原始请求（含请求行、Host 等头部、必要时 body）。

参数：
- `engagement`
- `vuln_id` — 关联的漏洞 id（建议填）
- `asset_id`
- `label` — 这条证据的用途，例如「越权读取用户列表」
- `method` — GET/POST/…
- `url`
- `status` — 响应状态码
- `request` — 原始请求全文（Burp 可直接粘贴）
- `response` — 响应全文或关键片段
- `note`
- `captured_by` — 采集角色

### `redteam_evidence_record`
记录一条作战证据。核心纪律：confidence 必须如实填写——claimed（子智能体口头报告，禁止直接采信）/ observed（你亲自核实过）/ derived（从 observed 推理）/ inferred（推测，必须标注）。ev_id 由内容哈希生成，改一字就变，落库后可防篡改核对。相关技能：evidence-discipline。

参数：
- `engagement`
- `operation` — 操作名，如 "nmap_scan"、"webshell_established"、"sql_injection_confirmed"
- `parameters` — 调用参数（JSON 对象，会参与哈希）
- `result` — 规范化结果（JSON 对象，会参与哈希）
- `confidence` — claimed | observed | derived | inferred，默认 observed
- `authority` — tool-output | database-record | screenshot | request-replay | subagent-report | operator-input，默认 tool-output
- `limitations` — 局限性说明，如 ["只扫了 Top1000 端口"]
- `supporting_ev_ids` — 支撑这条证据的其他 ev_id
- `source_agent` — 哪个子智能体产出的（claimed 时必填）

### `redteam_evidence_list`
列出证据账本条目，可按 operation / confidence 过滤。汇报前先确认没有未升级的 claimed。

参数：
- `engagement`
- `operation`
- `confidence` — claimed | observed | derived | inferred
- `limit`
- `offset`

### `redteam_evidence_upgrade`
把 claimed / inferred 升级为 observed。必须带 verified_result（亲自验证的回显/数据）。

参数：
- `engagement`
- `claimed_ev_id` — 要升级的证据 ID
- `verified_result` — 亲自验证后的实际结果
- `verified_by` — 谁核实的，默认 coordinator

### `redteam_evidence_verify`
核对子智能体回报与证据账本是否一致（hash 级核对）。matched=false 表示子智能体改口、夸大或库里没有。

参数：
- `engagement`
- `operation`
- `parameters`
- `result`
- `confidence`
- `authority`
- `limitations`
- `supporting_ev_ids`

### `redteam_unverified_count`
当前靶标还有多少条 claimed/inferred 没有闭环核实。返回 >0 时汇报必须提醒未核实条数。

参数：
- `engagement`

## D. 权限与入口（exploit / internal 用）

_隧道必须写 entry_kind（target-http / target-outbound / target-agent）；只在自己 VPS 上开的不算突破。马必须冰蝎/哥斯拉。_

### `redteam_webshell_add`
登记一个已上线的 WebShell。**必须上传冰蝎马（behinder）或哥斯拉马（godzilla）的加密马**——用户在控制台要用对应客户端直连，一句话马/自研马/MemShell 用户连不上，不算可交付的入口。shell_type 只能填 godzilla | behinder；确实只能用其它形式时填 other 并在 note 里写清为什么。同一 url+pass_key 重复登记会合并刷新。登记后所有角色智能体都能复用它，不要重复打点。

参数：
- `engagement`
- `url` — WebShell 完整 URL
- `shell_type` — godzilla（哥斯拉）| behinder（冰蝎）；其它形式才用 antsword/other 并说明原因
- `pass_key` — 连接密码 / 密钥（冰蝎马写 pass，哥斯拉写 key）
- `privilege` — 当前权限，例如 www-data / root / iis
- `secret_ref` — 凭据/证据引用，例如 runs/ws-10.0.0.5.txt（不要把明文口令写进库）
- `asset_id`
- `note`
- `found_by_agent`

### `redteam_webshell_list`
列出已登记的 WebShell（含在线状态与最后检查时间）。

参数：
- `engagement`
- `status` — online | offline | unknown
- `asset_id`

### `redteam_webshell_update`
更新 WebShell 状态（被删/掉线/权限变化）或补充说明。

参数：
- `engagement`
- `id` — WebShell 记录 id
- `status` — online | offline | dead | unknown
- `privilege`
- `note`
- `check_note`

### `redteam_tunnel_add`
登记一条内网隧道。**打进内网必须先用技能 suo5-tunnel 通过 WebShell/HTTP 建 socks5（kind=suo5）**；没有隧道就不要手搓内网探测脚本。listen 写本机可用地址（如 127.0.0.1:1080），reach 写它能到达的网段。登记后扫描器可直接 -socks5 <listen>。 **红线：自己的 VPS / 自己配置的服务器不算隧道。** 只在你自己服务器上开的 socks5、frp 服务端、代理，没有碰到目标，**不算跨越靶标边界、不算边界突破或内网突破**（这类填 entry_kind=self-only，会被标成"不算突破"）。**必须说清目标侧的那一端**： · target-outbound — 目标主动连出到我方（**自己服务器收目标反弹 shell**、目标上跑 frp/Stowaway 客户端）； · target-http — 经目标 WebShell/HTTP 通道（suo5、Neo-ReGeorg、reGeorg）； · target-agent — 经目标已控进程/会话转发（SSH -R 由目标发起等）。

参数：
- `engagement`
- `kind` — suo5（首选，走 WebShell/HTTP）| socks5 | ssh-r | frp | chisel | other
- `listen` — 本地监听地址 host:port
- `entry` — 入口：WebShell URL / 跳板机 / 命令
- `reach` — 可达网段，例如 10.0.0.0/8
- `entry_kind` — 【重要】通道的目标侧那一端是什么：target-outbound（目标反弹 shell 到我方/目标上跑 frp 客户端）| target-http（经目标 WebShell 的 suo5/Neo-ReGeorg）| target-agent（经目标已控进程转发）| self-only（只在自己 VPS/自建服务器上，**不算突破**）
- `webshell_id` — 由哪个 WebShell 建立
- `asset_id`
- `command` — 建立命令，便于重建
- `pid`
- `note`
- `found_by_agent`

### `redteam_tunnel_list`
列出已登记的内网隧道（含状态、监听地址、可达网段、entry_kind 与 legit 判定）。**legit=false 表示只在自己 VPS/自建服务器上开的通道，不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind。

参数：
- `engagement`
- `status` — active | down | unknown

### `redteam_tunnel_update`
更新隧道状态（关闭/失效/更换监听地址）或补 entry_kind 判定。用完隧道务必标为 down 并说明，避免后续误用。**老记录没声明入口归属的（legit=null，界面显示"待确认"），用 entry_kind 补上目标侧那一端**，补完才算突破凭证。

参数：
- `engagement`
- `id`
- `status` — active | down | closed | unknown
- `listen`
- `reach`
- `entry` — 入口：WebShell URL / 跳板机 / 命令
- `entry_kind` — 补声明目标侧那一端：target-outbound | target-http | target-agent | self-only（只在自己服务器上，不算突破）
- `note`
- `check_note`

### `redteam_credential_add`
记录一条凭据（漏洞利用/内网渗透角色）。**必须把口令/密钥明文写进 secret_value**——面板要直接显示明文供随时复用；同时用 secret_ref 指向 runs/ 下的证据文件。注意：本库只在本机，禁止把库文件或导出内容提交到任何仓库。

参数：
- `engagement`
- `host` — 所属主机（IP 或域名）
- `username`
- `secret_type` — password | hash | key | token | connection-string，默认 password
- `secret_value` — 【必填】凭据明文：口令 / Hash / 私钥 / Token / 连接串
- `secret_ref` — 证据引用路径，例如 runs/cred-vnc-10.0.0.5.txt
- `privilege` — 该凭据的权限级别，如 admin / user / db-read
- `asset_id`
- `source` — 来源：exploit / dump / config-leak …
- `tool`
- `note`
- `found_by_agent`

### `redteam_credential_list`
列出已收集的凭据（含明文 secret_value），用于凭据复用与横向移动。

参数：
- `engagement`
- `host`
- `username`

### `redteam_access_add`
记录一次成功获得的访问会话（横向移动起点）。method 例如 vnc/rdp/ssh/web-shell/webshell/db；privilege 例如 admin/user/system。

参数：
- `engagement`
- `host`
- `username`
- `method` — 获得访问的方式
- `privilege`
- `asset_id`
- `session_ref` — 会话/证据引用，例如 runs/session-vnc-10.0.0.5.md
- `note`
- `found_by_agent`

### `redteam_access_list`
列出已获得的访问会话。

参数：
- `engagement`
- `host`

### `redteam_session_check`
实测所有 WebShell 与隧道的连通性（由 host 侧真实发起 HTTP / TCP 连接），并把在线/离线状态回写数据库。开工前和长时间任务后各跑一次。

参数：
- `engagement`
- `timeoutMs` — 单次探测超时，默认 6000ms

### `redteam_sessions`
【每次决策前后都要看】一屏总览当前所有可复用入口：已上线的 WebShell、可用的内网隧道（含监听地址与可达网段）、凭据、访问会话，并给出在线/离线统计。打内网前先看这里，不要重复造轮子，也不要忘记已有的隧道。

参数：
- `engagement`

## E. 攻击链与得分（全程都在写）

_每步都要写 tool（命令原文）与 result（回显），否则报告无法复现；得分点 code 先用 score_list 查。_

### `redteam_http_evidence_query`
按 HTTP 证据 ID、关联漏洞或资产 ID 查询原始 HTTP 证据。列表默认仅返回摘要、是否有请求/响应、文本长度和分页信息；指定证据 `id` 时默认返回单条完整内容（请求和响应各限制 60000 字符）。这是 `redteam_http_evidence_add` 的只读配套工具，和哈希证据账本 `redteam_evidence_list` 是两类记录。

参数：
- `engagement`
- `id` — HTTP 证据条目 ID（指定时默认 full）
- `vuln_id` — 关联漏洞 ID
- `asset_id` — 关联资产 ID
- `detail` — summary / full（full 需要具体 id）
- `limit` — 默认 20，最大 100
- `offset` — 从 0 开始分页

### `redteam_chain_add`
记录一个攻击链步骤。**报告里「这一步怎么来的」完全靠这条记录**：账号密码怎么来的、冰蝎马怎么上的、隧道怎么搭的，都要在这里用 `tool`（实际命令原文）+ `detail`（为什么这么做、线索从哪来）+ `result`（实际回显/结果）写清楚。攻击链页面与报告按 seq 排序展示。

参数：
- `engagement`
- `stage` — 动作类型（兼容字段）：recon 信息收集 | vuln 漏洞发现 | exploit 利用 | access 获得权限 | pivot 内网突破 | data 敏感数据 | other。**阶段归属用 stage_code**，这个字段只用于老数据兜底。
- `title` — 一句话描述这一步做了什么，例如「通过后台模板上传点上传冰蝎马」「用 suo5 建 socks5 隧道」
- `detail` — 为什么这么做、线索从哪来，例如「登录页泄露版本 Coremail XT 5.0 → 匹配 CVE-2023-xxxx → 后台模板管理可上传」
- `tool` — 【报告复现的关键】**实际执行的命令原文**，例如 `nuclei -t CVE-2021-xxxx.yaml -u http://x`、`suo5-linux-amd64 -t http://x/shell.jsp -l 1080`、`sqlmap -u "http://x?id=1" --dump`。不写这条，报告里这一步就没法复现。
- `result` — 【报告复现的关键】实际结果/回显摘要，例如 `uid=0(root) gid=0(root)`、「返回 200，含 1.2 万条用户数据」、「后台管理员 tomcat 登录成功」
- `asset_id`
- `vuln_id`
- `access_id`
- `evidence_ref` — 证据文件/会话引用，例如 runs/session-vnc.md
- `recorded_by`
- `point_code` — 【这一步拿了分就填】得分点 code（如 rce / webshell / boundary），服务端会自动记一次分并把步骤与得分互相挂上。**必须同时给 evidence，否则不会记分**（步骤照常入库）。
- `stage_code` — 所属作战阶段（只有这 5 个合法值）：recon(信息收集) | internet(互联网资产权限) | boundary(边界突破·搭隧道) | internal(内网资产权限) | target(靶标系统权限)。写别的值（如外部工具常见的 external/foothold/tunnel/privilege）会被忽略并退回按 stage 兜底，步骤就不落在任何阶段。
- `evidence` — 配合 point_code 使用：这一分拿到了什么（目标资产 + 账号/权限/数据量）——**不填就不记分**。
- `self_created` — 配合 point_code 使用：这一步拿到的账号/权限是**自己注册/自建**的吗？是则 true（只留过程，不计分）
- `target` — 配合 point_code 使用：目标资产
- `seq` — 不填则自动追加到链尾

### `redteam_chain`
读取完整攻击链（按步骤顺序），用于汇报与检查链路是否闭合（入口 → 权限 → 内网突破）。

参数：
- `engagement`

### `redteam_attack_chain`
攻击链：按攻击面位置串起来的五个阶段 —— ① 信息收集（互联网侧）→ ② 互联网资产权限 → ③ 边界突破（搭隧道）→ ④ 内网资产权限 → ⑤ 靶标权限。返回每阶段的阶段目标、**实际拿到多少分与累计分**、涉及资产、以及边界突破阶段的真实隧道。开工时看它明确"现在在第几阶段、下一步该打哪一阶段"，汇报时按阶段给结论。

参数：
- `engagement`

### `redteam_attack_path`
导出攻击图谱：资产拓扑 + 漏洞节点 + 已控制资产（meta.owned）。用于横向移动路径规划与战果汇报。节点过多时用 cidr 缩小范围。

参数：
- `engagement`
- `cidr`
- `maxNodes` — 默认 400

### `redteam_score_list`
查看得分目标面板：所有得分点（名称/分类/分值/是否已拿下/命中证据）与总分进度。**每次规划下一步之前先看这里**，按分值高低决定先打什么。

参数：
- `engagement`

### `redteam_score_hit`
记录一次得分。得分规则已按《突破入侵类得分规则（合并版）》重构为 **25 项**（一、获取权限 21 项 + 二、突破网络边界 4 项，共 8 个类别），另有 8 条通用规则 G1–G8 横切全部条目。**记分前先用 `redteam_score_list` 读实际 code 与该条的上限/口径**，不要凭记忆写。 **证据只写结果**：目标资产 + 拿到了什么（账号/密码/权限/数据量），不要写取得过程与路径——过程由攻击得分链路的步骤负责。能指向"用哪个漏洞拿到的"时带上 vuln_id，报告会自动附上该漏洞的原始请求。 **多档条目用 `points` 指定本档分值**：《合并版》把同一项的多个档位并成一条（如「服务器主机权限」普通 10 / 管理员 50、「域名控制权限」一级 50 / 二级 20、「网络设备权限」普通 100 / 管理员 200）。记分时把 `points` 填成本次实际档位的分值；不填就用该条的主档默认值。**同一系统只按最高权限计一次**（G1）——先记了普通档、后来提权到管理员档，再记一条管理员档（points 填高档值），系统会自动顶掉普通档那条。 **红线一：账号类得分必须先实测能登录。** 拿到账号/口令后要用浏览器（browser-automation / kimi-webbridge）或等价会话实测登录成功、能交互访问页面，才记账号权限分——**只有凭据不算拿到账号**；登不进去的写进 redteam_asset_test 的 `test` 参数。 **红线二：自己注册的账号不算得分权限。** 自助注册、自己新建的用户/角色/后台账号、自己给自己开的权限都不算——演练得分针对**拿到别人已有的**账号与权限。这类用 self_created=true 记录（留过程），不计分、不计数、不进报告。 **红线三：注意该条的计分口径（G1/G3）。** 每条得分点自带口径：`同一系统只算最高权限一次`／`同一服务只算最高一条`／`整个目标只算一次`（突破网络边界）／`按台·卡·个累加`（终端、云节点、算力卡）。且每条有自己的**上限**（如服务器主机 600 分、Web 应用 2000 分、集权系统 4000 分），到上限后同条不再累计（G3）——返回里会用 warning 告诉你"已达上限/已被顶掉"，把它当**停止信号**，换别的条目或别的资产推进，不要在同一条上刷。 **数据成果单独计分（G2）**：邮件数据、业务数据、数据资产等按重要程度另行记录，不与权限分混算；evidence 必须写出**实际数据量**（如「导出 1,320,000 条用户数据」）。

参数：
- `engagement`
- `code` — 得分点 code（或 point_id / point_name 任选其一）；先用 redteam_score_list 核对实际 code
- `point_id`
- `point_name`
- `points` — 【多档条目必填】本次命中按哪一档计分（如服务器主机权限：普通权限填 10、管理员填 50；域名控制：一级 50、二级 20）。不填则用该条主档默认值。
- `target` — 目标资产：URL / ip:port / 主机名（**带上端口**，服务/系统口径按它判定）
- `asset_id` — 目标资产在库里的 id
- `port` — 【建议填】这条得分落在哪个端口（口径判定按「资产 + 端口」；target 里已带端口时可不填）
- `vuln_id` — 【建议填】用哪个漏洞拿到的分（报告据此附原始请求）
- `step_id` — 对应的攻击链步骤 id（可选）
- `evidence` — 【必填】结果：拿到的东西，例如「后台管理员 tomcat/Tomcat@2024（已实测浏览器可登录）」「数据库账号 root/xxx」「导出 132 万条用户数据」。多档条目请写明档位（如"管理员权限"）。
- `self_created` — 【重要】这个账号/权限是不是**自己注册、自己创建**的？是则填 true —— 只作过程记录，不计分、不进报告。拿到别人已有的账号/权限不要填（默认 false）。
- `note`
- `recorded_by`

### `redteam_score_point_save`
新增或修改得分点（分值/名称/分类/说明/启用）。用户也会在界面上编辑；智能体只在必要时用（例如发现规则里还有未被记录的得分项）。带 id 为修改，不带 id 为新增。

参数：
- `engagement`
- `id` — 已有得分点 id（修改时传）
- `name`
- `code` — 短代码（新增时建议给，便于记录得分）
- `category` — 分类，如 账号权限 / 服务器权限 / 数据库 / 网络突破 / 数据 / 核心目标
- `points` — 分值
- `description` — 得分条件说明
- `enabled`

## F. POC 与攻击文件

_跨靶标可复用的进 poc_*；只对本次有效的脚本进 attack_file_*；验证有效后回填 verified。_

### `redteam_poc_add`
把**通用可复用**的 POC/EXP 落进知识库（跨靶标共享）。从互联网拿到的、自己手搓的、或已经调通验证过的都往这里放——只收录真正有效的，并写清来源与验证证据。判断标准：**换个目标还能用**的进知识库；只对本次靶标有效的脚本走 redteam_attack_file_add（攻击文件页）。同名（同一 code）会合并刷新，可用于更新版本。 **回填三件套（缺了面板里就没有归类、追溯不到来源）**：① `category` 归类；② `engagement` + `asset_target` —— 这条知识是在哪个靶标、哪台资产上发现并验证的；③ `verified` + `verified_note` 验证证据。

参数：
- `title` — 标题：组件 + 漏洞名/编号，例如「Weblogic T3 反序列化 CVE-2023-21839」
- `kind` — poc（验证）| exp（利用）| script | template | payload
- `category` — 【归类，建议必填】rce 远程命令执行 | deserialization 反序列化 | file-upload 文件上传 getshell | sqli SQL 注入 | unauthorized 未授权访问 | auth-bypass 认证绕过/越权 | weak-password 弱口令 | ssrf | xxe | path-traversal 目录穿越/任意文件读 | info-leak 信息泄露 | privesc 提权/横向 | tunnel 隧道/代理 | other 其它
- `cve` — CVE / CNVD 编号
- `component` — 组件/产品名（便于按组件检索）
- `versions` — 影响版本范围
- `severity` — critical | high | medium | low
- `language` — python | go | java | bash | http | nuclei | js | php
- `source` — web（互联网扒的）| self（自己手搓）| manual（人工）| nuclei-template
- `source_url` — 来源链接（互联网来源必填，便于复核）
- `description` — 这个 POC 干什么、原理要点、前提条件
- `usage` — 用法：完整命令行示例 + 需要替换的参数
- `content` — 正文：脚本/POC 源码、原始请求包、nuclei 模板、调用步骤
- `path` — 也可以给本机已有文件路径（相对 pocs/ 或绝对路径），由知识库读取正文
- `filename` — 正文落盘文件名，默认按语言给（poc.py / poc.sh / poc.yaml…）
- `verified` — 是否已实测验证（**只有在真实目标上验证过的才填 true**）
- `verified_note` — 验证证据：在哪台目标、什么回显/结果、是否需要认证
- `engagement` — 【来源靶标】这条知识是在哪个靶标上发现/验证的（填靶标 id 或单位名称）
- `asset_target` — 【发现资产】具体是在哪台资产/哪个目标上验证成功的，例如 10.1.2.3:8080 或 http://oa.demo.com
- `found_by_agent` — 发现它的角色 code（recon / assess / vuln-scan / exploit / internal）
- `tags` — 逗号分隔标签，例如「java,反序列化,rce」
- `created_by` — 哪个角色/智能体沉淀的

### `redteam_poc_search`
【打 Nday/1day 前的第一步】先查"现成的"两层：① **知识库**（本机沉淀的通用 POC/EXP，跨靶标共享，按"已验证 → 复用次数"排序）② **本机 nuclei 模板库**（上万条模板，CVE/组件名直接命中）。命中就取用：知识库用 redteam_poc_get 拿全文，模板直接 `nuclei -t <相对路径>`。**不要重复去互联网找或重新手搓**。两层都没有，再去互联网搜索或自己手搓，验证有效后用 redteam_poc_add 回填知识库。

参数：
- `q` — 关键字：组件+版本、漏洞名、路径片段、正文里的特征串都行
- `cve` — CVE / CNVD 编号，例如 CVE-2023-21839
- `component` — 组件/产品名，例如 Weblogic、Shiro、泛微 OA、Nacos
- `kind` — poc | exp | script | template | payload
- `category` — 按**归类**筛（可多值，逗号分隔）：rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other
- `engagement` — 按**来源靶标**筛（靶标 id 或名称关键词）：只看"在某个单位上验证过的"经验
- `asset_target` — 按**发现资产**筛（IP / 域名 / URL 片段）
- `language` — python | go | java | bash | http | nuclei | js | php
- `source` — web（互联网）| self（手搓）| manual（人工）| nuclei-template
- `verified` — true 只看实测验证过的（优先用这些）
- `templateLimit` — 本机 nuclei 模板最多返回几条，默认 20
- `limit` — 知识库条目上限，默认 200

### `redteam_poc_get`
取一条知识库 POC/EXP 的**完整内容**（正文 + 用法 + 验证记录 + 落盘路径），可直接照用或改造成目标专用脚本。不传 id 时可用 code（redteam_poc_search 返回里的 code 字段）。

参数：
- `id` — 知识库条目 id
- `code` — 知识库条目的稳定标识（search 结果里的 code）

### `redteam_poc_list`
列出知识库里的 POC/EXP（可按 kind/source/component/verified 过滤，不带条件就是全部）。用于盘点"我们手上已经有哪些现成武器"，避免重复搜集。

参数：
- `kind`
- `source`
- `component`
- `verified`
- `limit`

### `redteam_poc_update`
更新知识库条目：补验证结论（verified + verified_note）、修正影响版本、补用法或正文、改标签。**在真实目标上验证通过后，一定要回来把 verified 置 true 并写清证据**——后续智能体会优先用已验证的。

参数：
- `id` — 知识库条目 id
- `code` — 或用 code 指定条目
- `patch` — { verified, verified_note, versions, usage, description, content, tags, severity, component, cve, source, source_url, language }
- `verified` — 便捷写法：直接传 verified
- `verified_note` — 便捷写法：直接传验证证据

### `redteam_poc_use`
记一次知识库 POC/EXP 的复用（用在哪个靶标/目标）。复用次数高的条目会排前面，方便后来者优先选经过实战的武器。

参数：
- `id`
- `code`
- `used_on` — 用在哪：靶标名 / 目标 IP / URL

### `redteam_attack_file_add`
保存一个**实际生效**的攻击文件（脚本/POC/EXP/字典）到目标文件夹，供复用与交付。目录结构：attack-files/<IP|URL主机|C段>/<文件名>。evidence 必填且必须写清验证效果（例如"回显 uid=0"、"未授权返回 200 并含数据"）——**没打通的、只是尝试过的脚本不要放进来**。

参数：
- `engagement`
- `target` — 目标：IP、URL 或 C 段（同一 IP 的多个端口会归到该 IP 文件夹）
- `name` — 文件名，例如 cve-2021-22893.sh / vnc_brute.py
- `kind` — 类型：poc 验证 / exp 利用 / script 脚本 / wordlist 字典
- `description` — 这个文件做什么（一句话）
- `evidence` — 有效性证据：实际打通的输出/回显/影响，或对应漏洞/证据 id
- `content` — 文件内容（与 path 二选一）
- `path` — 已存在的文件路径（相对靶标目录或绝对路径），会复制进目标文件夹（与 content 二选一）
- `asset_id`
- `vuln_id`
- `created_by`

### `redteam_attack_file_list`
列出已保存的攻击文件（按目标文件夹分组）。开始打某个目标前先看这里，避免重复造轮子。

参数：
- `engagement`
- `target` — 只看某个目标

## G. 疑点与报告

_交付用 score_report（只收已得分项，附可重放原始请求）；report/report_targets 是旧接口。_

### `redteam_unknown_record`
记录一个还没解决的作战问题。question+domain 相同会去重。

参数：
- `engagement`
- `question`
- `severity` — low | medium | high | critical，默认 medium
- `domain` — 如 internal-recon / boundary-break / lateral-movement
- `recommended_probe` — 建议的验证手段
- `supporting_ev_ids`

### `redteam_unknown_list`
列出未解决的作战问题，派活前先看 open 项。

参数：
- `engagement`
- `status` — open | investigating | blocked | contradicted | resolved
- `severity`
- `limit`

### `redteam_unknown_resolve`
把未解决问题标为 resolved / contradicted / withdrawn。

参数：
- `engagement`
- `unk_id`
- `disposition` — resolved | contradicted | withdrawn
- `resolution` — 解决说明

### `redteam_score_report`
攻击得分链路复现报告：只收录"拿到了分"的成果（没得分的漏洞不进报告），每一项都尽量附上可直接粘贴进 Yakit Repeater 复现的原始请求。需要交付报告时用这个，而不是 redteam_report。

参数：
- `engagement`
- `limit` — 最多多少项，默认 500
- `markdown` — true=返回 markdown 全文（默认 true）；false=只返回条目摘要

### `redteam_report`
【已弃用，改用 redteam_score_report】生成成果报告（Markdown）：只收录**已验证/已利用且中危以上**的成果漏洞（每条附可粘贴进 Burp/Yakit 的原始请求）、攻击链、已获权限与凭据、修复建议。信息收集的资产清单、待验证/误报、低危与信息级水洞都不会出现在报告里。想让发现进报告：先 redteam_vuln_update 置为 confirmed（验证通过）或 exploited（利用成功），再 redteam_http_evidence_add 补原始请求。

参数：
- `engagement`

### `redteam_report_targets`
【已弃用，改用 redteam_score_report】按目标查看成果报告（每个 IP / URL / C 段一份）：成果漏洞（含可粘贴进 Burp/Yakit 的原始请求）、已获权限、凭据、攻击文件、攻击链。用于按目标汇报或检查某个目标还缺什么。

参数：
- `engagement`
- `target` — 只看某个目标的报告

### `redteam_shot_add`
登记一张证据截图：把图片拷进靶标目录并关联到得分点/命中（面板展开得分点即可看图，报告里也会嵌入）。批量得分点（如终端权限）每个得分点最多展示 3 张代表图，不必逐台截图。

参数：
- `engagement`
- `path` — 图片在本机的路径（相对靶标目录或绝对路径）；与 data_base64 二选一
- `data_base64` — 图片内容（base64，可带 data: 前缀）；截图工具没落盘时用这个
- `label` — 图片说明，例如「域控 WEB-SHDC1 atexec 回显 nt authority\\system」
- `kind` — screenshot（现场截图，默认）| card（由记录生成的证据摘录卡，报告里会标注）
- `point_code` — 关联的得分点 code，如 terminal-access / central-system
- `hit_id` — 关联到具体某条得分命中（score_hit id）；给了它这张图就只挂在那一条上
- `asset_id`
- `target` — 这张图对应的目标（IP / URL）
- `note` — 补充说明：这张图证明了什么
- `source_ref` — 原始来源：截图的落盘路径或 runs/ 下的证据文件
- `captured_at` — 截图时间（ISO），缺省用当前时间

### `redteam_shot_list`
列出已登记的证据截图（含所属得分点、目标、类型、落盘文件）。

参数：
- `engagement`
- `point_code`
- `hit_id`
- `asset_id`

### `redteam_shot_delete`
删除一张证据截图（连同磁盘文件）。

参数：
- `engagement`
- `id` — shot id（redteam_shot_list 里返回的 id）

## 注册工具补充说明

以下工具已在 `lib/redteam/tools.js` 注册，此处补全此前遗漏的说明。

### `redteam_ingest`
批量解析本地扫描文件，支持 nuclei、httpx、nmap、ffuf。默认只预览计数；只有 `commit: true` 才写入资产或漏洞。ffuf 仅返回路径，不会写库。

参数：`engagement`（可选）、`file`（必填）、`kind`（可选）、`commit`（默认 false）、`max`（默认 5000，上限 20000）。

### `redteam_credential_check`
对已记录或明确输入的凭据进行 TCP 连通性检查；mysql/redis 支持一次协议认证并返回错误诊断。会访问指定主机，须在允许的测试范围内使用。

参数：`engagement`、`credential_id`；或 `host`、`port`、`username`、`password`、`database`、`kind`（mysql/redis/ssh/tcp）、`timeout`。

### `redteam_score_suggest`
只读对账已确认漏洞、证据、实际成果与计分规则；`can_score` 是待复核建议，不会自动生成 `score_hit`。

参数：`engagement`、`limit`（默认 8，最多 20）。

### `redteam_scope_review`
离线只读地把库内资产与用户明确列出的允许范围进行匹配，支持 IPv4/IPv6、CIDR、域名与通配子域名。匹配结果不是授权证明；超过查询上限时会报告部分覆盖。

参数：`engagement`、`allowed`（必填，逗号或换行分隔）、`limit`（默认 25，最多 100）。

### `redteam_delivery_audit`
只读检查已记录得分的目标、证据结果与来源关联缺口；文本完整不代表漏洞已可复现，也不会自动加分。

参数：`engagement`、`limit`（默认 25，最多 100）。

### `redteam_progress_check`
只读比较前后分数、资产、漏洞、测试状态及 HTTP 证据数量，不会把变化推断成真实突破。

参数：`engagement`、`before`（必填，原样传入上次 `redteam_next_action` 的 `focus.before` JSON 字符串）、`task_key`（可选）。

## 典型调用链

```
redteam_engagement_open          建靶标（一次演练一个）
redteam_preflight                开工前自检：技能/工具/FOFA/VPS
redteam_agent_slot acquire      占一个执行名额（≤3）
  recon      → asset_add / asset_query / domain_index / web_list
  assess     → asset_assess（priority/potential/reason）+ asset_test
  vuln-scan  → vuln_add → http_evidence_add（原始请求/响应）
  exploit    → webshell_add → tunnel_add → session_check → access_add → score_hit
  internal   → asset_add（新网段）→ vuln_add → tunnel_update
redteam_chain_add                每步写 tool + result（报告复现靠它）
redteam_evidence_upgrade         claimed → observed（核实后才算拿到）
redteam_score_report             出交付报告
```
