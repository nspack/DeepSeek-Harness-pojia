/**
 * Preview ARTEX's SARIF 2.1.0 findings as cross-tool handoff data.
 * Read-only: never alters DSH engagements, findings, evidence, or scores.
 * Mirrors the fields produced by wxcvm/ARTEX/report/sarif.go.
 */
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function short(value, max = 260) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function reviewArtexSarif(input, limit = 50) {
  const doc = object(input)
  if (doc.version !== '2.1.0' || !Array.isArray(doc.runs)) {
    throw new Error('需要 ARTEX 导出的 SARIF 2.1.0 报告')
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('limit must be an integer between 1 and 200')
  }
  const findings = []
  const seen = new Set()
  const statuses = Object.create(null)
  let runs = 0
  let duplicates = 0
  for (const run of doc.runs) {
    if (object(object(run).tool).driver?.name !== 'ARTEX') continue
    runs++
    if (!Array.isArray(run.results)) throw new Error('ARTEX SARIF run missing results[]')
    for (const item of run.results) {
      const result = object(item)
      const properties = object(result.properties)
      const id = properties.findingId
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('ARTEX SARIF findingId 无效')
      if (seen.has(id)) { duplicates++; continue }
      seen.add(id)
      const taskId = properties.taskId
      const assets = Array.isArray(properties.assetIds)
        ? properties.assetIds.filter((x) => Number.isSafeInteger(x) && x > 0)
        : []
      const status = short(properties.status, 64) || 'unknown'
      statuses[status] = (statuses[status] || 0) + 1
      findings.push({
        source: 'ARTEX SARIF',
        finding_id: id,
        task_id: Number.isSafeInteger(taskId) && taskId > 0 ? taskId : null,
        asset_ids: assets,
        rule_id: short(result.ruleId, 100) || null,
        severity: short(properties.severity, 32) || 'unknown',
        reported_status: status,
        reported_kind: short(result.kind, 32) || null,
        summary: short(object(result.message).text, 280),
        // ARTEX's status is a report from another store, not a DSH finding verdict.
        dsh_status: 'candidate',
        proof_included: false,
        independent_review_required: true,
      })
    }
  }
  if (!runs) throw new Error('没有找到 ARTEX 的 SARIF run')
  return {
    ok: true,
    source: 'ARTEX SARIF 2.1.0',
    read_only: true,
    artex_runs: runs,
    unique_findings: findings.length,
    duplicates_skipped: duplicates,
    status_counts: statuses,
    independently_confirmed_by_dsh: 0,
    items: findings.slice(0, limit),
    omitted: Math.max(0, findings.length - limit),
    note: '仅供跨项目核对：保留 ARTEX 漏洞 / 任务 / 资产 ID 和原始状态；未导入 DSH、未附原始证据、未进行独立确认或计分。',
  }
}
