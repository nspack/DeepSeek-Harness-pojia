# 富江破甲离线 CVE 候选索引

来源：[FJNB5/fujiang-pojia](https://github.com/FJNB5/fujiang-pojia) 的 `plugin/knowledge/` 目录，
固定参考提交 [cf086fc](https://github.com/FJNB5/fujiang-pojia/commit/cf086fc329011c6f8eeb3b67f0adbcc3f005debb)。

## 本轮吸收的内容

- **105 条公开漏洞元数据**，覆盖 Java 反序列化、Java Web、云与容器、边界设备、Exchange / AD、Linux 提权及 Web / CMS。
- 仅保留分类、标题、CVE、产品、受影响版本声明、端口、关键词和每条原始资料链接。**未复制上游的 PoC 正文或利用步骤**。
- 数据以 JSON 放在 `lib/redteam/cve-catalog/`，随当前插件包发布，默认纯离线检索。
- `redteam_cve_match` 可直接从现有 SQLite 的 `asset_id` 读取服务/产品/banner/指纹，也可不依赖数据库按 `cve` 或 `product` 查询。不创建第二套任务台账，不自动导入现有漏洞库。
- 匹配返回 `matched_score` 和 `matched_reasons`，结果一律 `status: candidate`、`verified: false`。通用端口不能单独推断漏洞，受影响版本由人工复核或后续证据验证。
- 已有 `redteam_poc_search`（本机 PoC/模板）与 `redteam_vuln_add` / `redteam_http_evidence_add`（真实验证记录）继续原样工作。

## 为什么不直接安装富江破甲到当前 profile

它会安装 `@deepseek-ai/dsh-prompt-custom`、单独管理提示词文件与 UI。直接并装容易造成提示词、服务及 UI 入口重复。我们吸收检测数据和索引思路，复用自己已经有的存储、工具、权限与回退路径。

## 来源与许可

原仓库的 `plugin/package.json` 声明 MIT；其 `plugin/LICENSE` 写有：

```
MIT License
Copyright (c) 2026 DSH Desktop contributors
```

本分支只提取元数据并保留每条原始链接；尊重上游署名及源码许可。上游条目中的 `verified: false` 没有变成实测结论。对外使用时按具体厂商安全公告与 NVD 再核对版本。

## 后续优化

AboutSecurity 的按需启停和技能搜索可接现有「管理 → 技能库」，不直接复制另一个插件的安装器。自动作业链在已有任务、证据及智能体调度基础上增强，不再增加第二套 `campaigns.json`。
