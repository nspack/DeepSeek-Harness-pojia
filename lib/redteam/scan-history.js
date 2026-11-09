/**
 * Read-only scan history backed by the manifests already written by scan-runner.
 * No secondary database or migration: the workspace is the source of truth.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f\d]{8}$/

function scanDirectory(store, engagement) {
  const id = String(engagement || '')
  if (!id || !store.listEngagements().some((x) => x.id === id)) {
    throw new Error('engagement not found: ' + id)
  }
  return join(store.dirOf(id), 'scan-output')
}

function safeReadManifest(folder, name) {
  const runId = name.endsWith('.json') ? name.slice(0, -5) : ''
  if (!RUN_ID.test(runId)) return null
  try {
    const data = JSON.parse(readFileSync(join(folder, name), 'utf8'))
    if (!data || data.runId !== runId || !['nmap', 'httpx'].includes(data.kind)) return null
    return data
  } catch {
    return null
  }
}

function summary(m) {
  const result = m.ingestion && typeof m.ingestion === 'object' ? m.ingestion : {}
  const imported = result.imported && typeof result.imported === 'object' ? result.imported : {}
  return {
    run_id: m.runId, kind: m.kind, target: m.target, status: m.status,
    started_at: m.startedAt || null, finished_at: m.finishedAt || null,
    bytes: Number(m.bytes) || 0, sha256: m.sha256 || null,
    source: m.source || null, output_file: m.outputFile || null,
    ingested: m.ingested === true,
    assets: Number(result.assets) || 0, ports: Number(result.ports) || 0,
    vulns: Number(result.vulns) || 0, scan_run_id: imported.scan_run_id || null,
    error: m.error || result.error || null,
  }
}

function nextAction(row) {
  switch (row.status) {
    case 'imported': return '已记录扫描发现；进入资产列表核对新增端口与服务。'
    case 'previewed': return '目前仅预览；确认输出后可用 redteam_ingest 导入文件。'
    case 'no-findings': return '执行已结束，但解析到的发现为零；检查原始输出与目标参数。'
    case 'import-failed': return '工具执行有输出，但导入失败；先看解析错误与原始文件。'
    case 'failed':
    case 'timeout': return '检查工具退出状态和诊断；不要把失败记为完成。'
    case 'empty': return '输出为空；检查工具实际运行与目标响应。'
    default: return '检查执行状态及原始文件。'
  }
}

export function listScanHistory(store, engagement, options = {}) {
  const folder = scanDirectory(store, engagement)
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 25))
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0))
  if (!existsSync(folder)) return {
    ok: true, engagement, total: 0, unreadable: 0, offset, limit, items: [],
  }
  const entries = readdirSync(folder, { withFileTypes: true })
    .filter((x) => x.isFile() && x.name.endsWith('.json') && RUN_ID.test(x.name.slice(0, -5)))
    .map((x) => x.name).sort().reverse()
  const items = []
  let unreadable = 0
  for (const name of entries) {
    const manifest = safeReadManifest(folder, name)
    if (!manifest) { unreadable++; continue }
    const row = summary(manifest)
    if (options.status && row.status !== options.status) continue
    items.push({ ...row, next: nextAction(row) })
  }
  return {
    ok: true, engagement, total: items.length, unreadable,
    offset, limit, items: items.slice(offset, offset + limit),
  }
}

export async function inspectScanArtifact(store, engagement, runId) {
  const folder = scanDirectory(store, engagement)
  const id = String(runId || '')
  if (!RUN_ID.test(id)) throw new Error('invalid scan run id')
  const manifest = safeReadManifest(folder, id + '.json')
  if (!manifest) return { ok: false, engagement, run_id: id, status: 'not-found', error: '扫描记录不存在或无法读取' }
  const extension = manifest.kind === 'nmap' ? 'xml' : 'jsonl'
  // Construct a local path from a validated ID, never from untrusted manifest.outputFile.
  const file = join(folder, id + '.' + extension)
  if (!existsSync(file)) return {
    ok: false, engagement, run_id: id, status: 'missing', path: file,
    error: '原始输出文件已不存在',
  }
  const hash = createHash('sha256')
  const digest = await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
  const actualBytes = statSync(file).size
  const valid = digest === manifest.sha256 && actualBytes === manifest.bytes
  return {
    ok: valid, engagement, run_id: id, kind: manifest.kind, status: valid ? 'verified' : 'changed',
    path: file, actual_bytes: actualBytes, expected_bytes: manifest.bytes,
    sha256: digest, expected_sha256: manifest.sha256,
    note: valid ? '原始输出与运行时记录的摘要一致；不代表扫描结果已经人工复核。'
      : '原始输出与记录不一致：可能被修改或不完整，请核对文件。',
  }
}
