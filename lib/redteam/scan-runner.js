/**
 * Explicit, single-target discovery execution for the existing redteam_ingest.
 * The runner preserves raw output and provenance, but never declares a target
 * verified on the strength of a tool's exit status alone.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { loadPlatformConfig, normalizeScanPreferences, resolveTool } from './platform-config.js'
import { reviewScope } from './review-tools.js'

function targetFor(kind, target) {
  const raw = String(target || '').trim()
  if (!raw || raw.length > 512 || /\s|[\u0000-\u001f]/.test(raw) || raw.startsWith('-')) {
    throw new Error('target required: provide one IP, hostname or (for httpx) HTTP URL')
  }
  if (kind === 'nmap') {
    if (isIP(raw)) return raw
    const label = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?'
    if (raw.length > 253 || !new RegExp('^' + label + '(?:\\.' + label + ')*$').test(raw)) {
      throw new Error('nmap target must be one IP or hostname')
    }
    return raw
  }
  if (kind === 'httpx') {
    let url
    try { url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw) }
    catch { throw new Error('httpx target must be one hostname or HTTP URL') }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error('httpx target must be one HTTP(S) endpoint without embedded credentials')
    }
    return raw
  }
  throw new Error('unknown scan kind: ' + String(kind))
}

export function scanCommand(kind, target, options = {}) {
  const value = targetFor(kind, target)
  if (kind === 'nmap') {
    const args = options.mode === 'low-impact'
      ? ['-sT', '--open', '-oX', '-', '--max-retries', '1']
      : ['-sT', '-sV', '--open', '-oX', '-']
    if (options.ports !== undefined && String(options.ports).trim() !== '') {
      const ports = String(options.ports).trim()
      if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(ports)) {
        throw new Error('ports must be a comma-separated port list or ranges')
      }
      args.push('-p', ports)
    }
    if (isIP(value) === 6) args.push('-6')
    args.push(value)
    return { kind, target: value, args, extension: 'xml' }
  }
  return { kind, target: value, args: ['-u', value, '-json', '-silent'], extension: 'jsonl' }
}

export async function runDiscoveryScan({ kind, target, ports, outputDir }, options = {}) {
  const config = options.config || loadPlatformConfig(options.root)
  const preferences = normalizeScanPreferences(config.scanPreferences)
  const command = scanCommand(kind, target, { ports, mode: preferences.mode })
  const binary = resolveTool(kind, { ...options, config })
  if (!binary.path) return { ok: false, status: 'tool-missing', kind, target: command.target, error: kind + ' executable not found' }
  const root = outputDir || join(options.root || process.cwd(), 'scan-output')
  mkdirSync(root, { recursive: true })
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
  const outputFile = join(root, runId + '.' + command.extension)
  const manifestFile = join(root, runId + '.json')
  const startedAt = new Date().toISOString()
  const runner = options.execFileFn || execFile
  const outcome = await new Promise((resolve) => {
    try {
      runner(binary.path, command.args, {
        shell: false, windowsHide: true, timeout: preferences.timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout, stderr) => resolve({
        error, stdout: String(stdout || ''), stderr: String(stderr || ''),
      }))
    } catch (error) { resolve({ error, stdout: '', stderr: '' }) }
  })
  const finishedAt = new Date().toISOString()
  writeFileSync(outputFile, outcome.stdout, 'utf8')
  const status = outcome.error ? (outcome.error.killed ? 'timeout' : 'failed')
    : outcome.stdout.trim() ? 'executed' : 'empty'
  const manifest = {
    runId, kind, target: command.target, executable: binary.path, source: binary.source,
    argv: command.args, startedAt, finishedAt, status, outputFile,
    scanPreferences: { mode: preferences.mode, timeoutSeconds: preferences.timeoutSeconds,
      captureDiagnostics: preferences.captureDiagnostics },
    sha256: createHash('sha256').update(outcome.stdout).digest('hex'),
    bytes: Buffer.byteLength(outcome.stdout, 'utf8'),
    error: outcome.error
      ? (preferences.captureDiagnostics
        ? String(outcome.error.message || outcome.error).slice(0, 500)
        : 'scanner-exit-' + String(outcome.error.code || (outcome.error.killed ? 'timeout' : 'error')))
      : null,
    stderr: preferences.captureDiagnostics ? outcome.stderr.slice(0, 1200) : '',
  }
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8')
  return { ok: status === 'executed', ...manifest, manifestFile }
}

/** Run, then call the existing ingest path; a scan failure never imports data. */
export async function executeScanAndIngest(request, options = {}) {
  const run = await (options.run || runDiscoveryScan)(request, options)
  if (!run.ok) return { ...run, ingested: false }
  const commit = request.commit !== false
  let ingest
  try {
    ingest = await options.ingest({ file: run.outputFile, kind: run.kind, commit, argv: run.argv })
  } catch (error) {
    ingest = { ok: false, error: String(error?.message || error) }
  }
  const hasFindings = Number(ingest.assets || 0) > 0 || Number(ingest.vulns || 0) > 0
  const imported = ingest.ok === true && commit && hasFindings
  const final = { ...run, ok: ingest.ok === true, ingested: imported, ingest,
    status: ingest.ok === true ? (commit ? (hasFindings ? 'imported' : 'no-findings') : 'previewed') : 'import-failed' }
  // Keep the original tool result and the ingestion outcome together.
  if (run.manifestFile && existsSync(run.manifestFile)) {
    const original = JSON.parse(readFileSync(run.manifestFile, 'utf8'))
    writeFileSync(run.manifestFile, JSON.stringify({
      ...original, status: final.status, ingested: final.ingested, ingestion: ingest,
    }, null, 2), 'utf8')
  }
  return final
}

/**
 * 扫描目标是否落在演练登记的授权范围内（纯函数，便于单测）。
 *
 * 规则：
 *   · 登记了 scope → 必须命中其中的 IP / CIDR / 域名 / *.子域名；
 *   · 没登记 scope → 必须显式 confirm，而不是默认放行。
 * 这道检查以前完全不存在：模型写错一个 IP 就会扫到无关资产。
 */
export function targetInScope(scopes, target, options = {}) {
  const list = (Array.isArray(scopes) ? scopes : []).filter((item) => typeof item === 'string' && item.trim() !== '')
  const raw = String(target || '').trim()
  if (!raw) return { ok: false, reason: 'target required' }
  if (!list.length) {
    return options.confirm === true
      ? { ok: true, reason: 'scope-empty-confirmed' }
      : { ok: false, reason: 'scope-empty-needs-confirm' }
  }
  /* httpx 允许直接给 URL，范围里登记的却是主机/CIDR：先取 hostname 再比对。 */
  let host = raw
  if (/^https?:\/\//i.test(raw)) {
    try { host = new URL(raw).hostname } catch { host = raw }
  }
  const family = isIP(host)
  const probe = {
    id: 'target',
    /* IPv4 与 IPv6 都交给 reviewScope 的字节比较；域名走名字匹配。 */
    ip: family === 4 || family === 6 ? host : '',
    primary_name: host,
    names: host === raw ? [host] : [host, raw],
  }
  const audit = reviewScope([probe], list.join(','), 1)
  const hit = (audit.items || []).find((item) => item.status === 'ip-matched' || item.status === 'name-only')
  return hit ? { ok: true, reason: hit.status, rule: hit.rule } : { ok: false, reason: 'outside-scope', scopes: list }
}