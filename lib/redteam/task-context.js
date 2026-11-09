/**
 * One-call read-only context for a next_action focus target.
 * Only summarize locally recorded data: no scan, credential disclosure or score mutation.
 */
import { compactVuln } from './query-options.js'
import { matchCveCandidates } from './cve-knowledge.js'
import { searchLocalSkills } from './skill-catalog.js'

function parseTaskTarget(target) {
  const match = typeof target === 'string'
    ? target.trim().match(/^(?:[^:\r\n]{1,100}:)?(asset|vuln)\s*#([1-9]\d*)$/i)
    : null
  if (!match) throw new TypeError('target must be focus.target (asset #ID or vuln #ID) or its focus.task_key')
  const id = Number(match[2])
  if (!Number.isSafeInteger(id)) throw new TypeError('task record ID must be a positive safe integer')
  return { kind: match[1].toLowerCase(), id }
}

function assetBrief(asset) {
  if (!asset) return null
  const openPorts = Array.isArray(asset.ports) ? asset.ports.filter((port) => port.state === 'open') : []
  const notes = String(asset.test_notes || '').split('\n').filter(Boolean)
  return {
    id: asset.id, ip: asset.ip, name: asset.primary_name || null,
    state: asset.state, test_status: asset.test_status || 'untested',
    test_updated_at: asset.test_updated_at || null,
    test_surface: String(asset.test_surface || '').slice(0, 240),
    recent_test_notes: notes.slice(-3).map((note) => note.slice(0, 240)),
    blocked_count: Number(asset.blocked_count) || 0,
    segment: asset.segment_cidr || null, scope: asset.scope || null,
    open_ports_total: Number(asset.open_ports) || openPorts.length,
    open_ports: openPorts.slice(0, 20).map((port) => ({
      port: port.port, proto: port.proto, service: port.service || null, product: port.product || null,
    })),
    fingerprints: (Array.isArray(asset.fingerprints) ? asset.fingerprints : []).slice(0, 10)
      .map((fp) => [fp.vendor, fp.product, fp.version].filter(Boolean).join(' ')),
  }
}

/** Small, read-only hints from public CVE metadata and already installed skills. */
function taskHints(asset, cve = '') {
  const knowledge = matchCveCandidates({ asset, cve, limit: 3 }).items
  let relatedSkills = []
  if (knowledge.length && asset) {
    const product = (asset.ports || []).find((p) => p.state === 'open' && p.product)?.product
      || (asset.fingerprints || []).find((p) => p.product)?.product
    if (product) relatedSkills = searchLocalSkills(product, { limit: 3 }).items
  }
  return {
    knowledge_candidates: knowledge,
    related_skills: relatedSkills,
  }
}

/**
 * Compose existing exact-ID lookup APIs into a short, actionable context.
 * HTTP bodies remain available only through redteam_http_evidence_query(id=...).
 */
export function taskContext(store, engagement, target) {
  const { kind, id } = parseTaskTarget(target)
  const record = kind + ' #' + id
  if (kind === 'asset') {
    const asset = store.getAsset(engagement, id)
    if (!asset) return { ok: false, engagement, target: record, error: 'asset not found' }
    const hints = taskHints(asset)
    const linked = store.listVulns(engagement, { asset_id: id, withHttpEvidence: false, limit: 10 })
    const directEvidence = store.queryHttpEvidence(engagement, { asset_id: id, detail: 'summary', limit: 10 })
    return {
      ok: true, engagement, target: record, kind, asset: assetBrief(asset),
      ...hints,
      related_vulns: {
        total: linked.total, returned: linked.items.length, hasMore: linked.hasMore,
        nextOffset: linked.nextOffset, items: linked.items.map(compactVuln),
      },
      direct_http_evidence: directEvidence,
      next: '用 redteam_vuln_query(id=...) 核对关联漏洞；用 redteam_http_evidence_query(vuln_id=...) 找漏洞证据；测试记录通过 redteam_asset_test 更新。',
      note: '仅是数据库事实摘要。scope 只表示地址内外网分类，不证明授权；证据存在不代表漏洞已确认。direct_http_evidence 不包含仅通过 vuln_id 关联的证据。',
    }
  }
  const found = store.listVulns(engagement, { id, withHttpEvidence: false, limit: 1 })
  const vuln = found.items[0]
  if (!vuln) return { ok: false, engagement, target: record, error: 'vuln not found' }
  const asset = vuln.asset_id == null ? null : store.getAsset(engagement, vuln.asset_id)
  const hints = taskHints(asset, vuln.cve)
  const evidence = store.queryHttpEvidence(engagement, { vuln_id: id, detail: 'summary', limit: 10 })
  return {
    ok: true, engagement, target: record, kind, vulnerability: compactVuln(vuln),
    ...hints,
    linked_asset: assetBrief(asset),
    asset_link_status: vuln.asset_id == null ? 'unlinked' : asset ? 'linked' : 'missing',
    http_evidence: evidence,
    next: '用 redteam_vuln_query(id=...) 查看完整漏洞记录；需要单条原始 HTTP 报文时按证据 id 调 redteam_http_evidence_query(id=...)。',
    note: '只读资料聚合，不执行探测、不变更漏洞状态或计分；存在候选/证据不等于已验证。',
  }
}
