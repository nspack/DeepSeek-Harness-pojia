/**
 * A truthful privacy/impact explanation derived only from persisted controls.
 * "protected" never implies that a target cannot log incoming connections.
 */
export function summarizeProtection(config) {
  const prefs = config?.scanPreferences || {}
  const protectedNow = [
    { id: 'local-index', label: '本地资产检索不联系测绘厂商', detail: 'SQLite 查询不会向第三方平台发送搜索词。' },
    { id: 'single-target', label: '主动测绘限定单个目标并复核项目范围', detail: '本机主动扫描会检查目标范围，不能直接提交任意批量网段。' },
    { id: 'timeout', label: '扫描设有本机执行时间上限', detail: '当前配置 ' + (Number(prefs.timeoutSeconds) || 180) + ' 秒。' },
  ]
  const optional = []
  const state = (on, id, label, detail) => (on ? protectedNow : optional).push({ id, label, detail })
  state(prefs.mode === 'low-impact', 'low-impact', '减少 Nmap 服务探测', '低影响模式跳过服务版本探测并降低重试次数；可能少发现服务。')
  state(prefs.noReverseDns === true, 'reverse-dns', '减少 Nmap 反向 DNS 查询', '仅抑制反向解析；使用域名作目标时仍可能发生正向 DNS 解析。')
  state(prefs.captureDiagnostics === false, 'diagnostics', '不保存扫描器 stderr 详细内容', '原始扫描发现与必要元数据仍会留在本地。')
  state(prefs.maskHistory === true, 'history-mask', '历史页遮蔽目标及本地文件路径', '保护屏幕展示；磁盘原始证据与 API 数据不受此选项影响。')
  state(prefs.maskAssetResults === true, 'asset-mask', '测绘中心隐藏资产 IP 与域名', '用于屏幕分享；本地数据库和扫描记录不删除。')
  return {
    protected: protectedNow,
    available: optional,
    limitations: [
      { id: 'target-logs', label: '目标侧网络日志与 IDS 仍可能记录请求', detail: '本页面不提供隐身、绕过监测或清理目标日志功能。' },
      { id: 'stored-evidence', label: '本地原始扫描输出仍被保存', detail: '保留必要的溯源与核验能力；请通过操作系统访问权限保护这些文件。' },
      { id: 'external-sites', label: '外部情报平台的账户与查询遵循其自身政策', detail: '手动访问第三方网站时，该网站可能记录访问与搜索内容。' },
    ],
  }
}
