/**
 * Convert already-recorded local scan outcomes into read-only task feedback.
 * Never treats a successful process invocation as a confirmed finding.
 */
const REVISIT = new Map([
  ['import-failed', { priority: 2, title: '修复扫描结果导入', detail: '工具已有输出，但入库失败；先复核原始文件与解析错误，不重新扫描同一目标。' }],
  ['previewed', { priority: 2, title: '核对尚未导入的扫描', detail: '已有预览输出，先核对并选择是否导入，不要直接重复扫描。' }],
  ['timeout', { priority: 3, title: '排查扫描超时', detail: '上次执行超时；检查诊断、目标响应和执行环境，再决定是否重试。' }],
  ['failed', { priority: 3, title: '排查扫描执行失败', detail: '上次执行失败；先查看错误与工具环境，再决定是否重试。' }],
  ['empty', { priority: 3, title: '复核空扫描输出', detail: '命令没有输出；核对执行环境及目标设置，不将空结果当作完成。' }],
  ['no-findings', { priority: 4, title: '核对未发现结果的扫描', detail: '运行完成但没有可导入的发现；先确认输出与扫描范围，不自动重跑。' }],
])

const keyOf = (row) => String(row.kind || '') + '\u0000' + String(row.target || '').trim()

export function summarizeScanFeedback(rows = []) {
  const seen = new Map()
  for (const row of rows) {
    if (!row || !row.kind || !row.target || !row.run_id) continue
    const key = keyOf(row)
    let entry = seen.get(key)
    if (!entry) {
      entry = {
        kind: row.kind, target: row.target, run_id: row.run_id,
        status: row.status || 'unknown', started_at: row.started_at || null,
        assets: Number(row.assets) || 0, ports: Number(row.ports) || 0,
        attempts: 0,
      }
      seen.set(key, entry)
    }
    entry.attempts++
  }
  const latest = [...seen.values()]
  const pending = latest.filter((x) => REVISIT.has(x.status))
    .sort((a, b) => REVISIT.get(a.status).priority - REVISIT.get(b.status).priority
      || String(b.run_id).localeCompare(String(a.run_id)))
  const duplicates = latest.filter((x) => x.attempts >= 2)
  const first = pending[0] || null
  const recommendation = first ? {
    ...REVISIT.get(first.status), kind: first.kind, target: first.target,
    run_id: first.run_id, status: first.status,
    tab: 'scan-history',
  } : null
  return {
    total_scans: rows.length,
    distinct_targets: latest.length,
    pending_review: pending.length,
    repeated_targets: duplicates.length,
    latest: latest[0] || null,
    recommendation,
    pending: pending.slice(0, 10),
    duplicates: duplicates.slice(0, 10),
    recent_by_target: latest.slice(0, 100),
    note: '只读扫描反馈：仅同工具和完全相同的目标字符串合并历史；不自动跳过、不重试、不把扫描输出当作确认漏洞。',
  }
}

export function scanFeedbackTask(feedback) {
  const r = feedback && feedback.recommendation
  if (!r) return null
  return {
    priority: r.priority,
    action: r.title,
    target: 'scan #' + r.run_id,
    why: r.detail + ' 上次工具：' + r.kind + '，目标：' + r.target,
    expected: '依据已有输出明确导入或执行问题，并记录解决结果；不要虚构新发现',
    tool: 'redteam_scan_history(run_id="' + r.run_id + '")',
    scan_run_id: r.run_id,
  }
}

export function matchTaskScan(actions = [], assets = [], feedback) {
  const rows = feedback?.recent_by_target || []
  const assetById = new Map(assets.map((x) => [String(x.id), x]))
  return actions.map((a) => {
    const match = /^asset #(\d+)$/.exec(String(a.target || ''))
    const asset = match && assetById.get(match[1])
    if (!asset) return a
    const names = new Set([asset.ip, asset.primary_name].filter(Boolean).map(String))
    const recent = rows.find((r) => {
      if (names.has(String(r.target))) return true
      try { return names.has(new URL(r.target).hostname) } catch { return false }
    })
    if (!recent) return a
    return {
      ...a,
      prior_scan: {
        kind: recent.kind, status: recent.status, run_id: recent.run_id,
        attempts: recent.attempts,
      },
      why: a.why + '；已有 ' + recent.kind + ' 记录 ' + recent.run_id
        + '（' + recent.status + '），先用 redteam_scan_history 核对原始记录再决定是否重复探测。',
    }
  })
}
