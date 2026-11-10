/**
 * On-demand local discovery for a single explicitly selected engagement target.
 * Uses the existing local Nmap/httpx scanner; never calls search vendors.
 */
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { executeScanAndIngest, targetInScope } from './scan-runner.js'

function scanHost(input) {
  const src = String(input || '').trim()
  if (/^https?:\/\//i.test(src)) {
    try { return new URL(src).hostname.replace(/^\[|\]$/g, '') } catch { return src }
  }
  return src
}

function attrib(str, name) {
  const m = new RegExp('\\b' + name + '="([^"]*)"').exec(str)
  return m ? m[1] : ''
}

/** Parse only already-collected scanner evidence into the existing import bundle. */
export function parseLocalDiscovery(kind, text, requestedTarget) {
  const target = scanHost(requestedTarget)
  if (kind === 'nmap') {
    const assets = []
    const hosts = String(text).match(/<host\b[\s\S]*?<\/host>/g) || []
    for (const block of hosts.slice(0, 1)) {
      const addrTag = (block.match(/<address\b[^>]*\baddrtype="ipv[46]"[^>]*\/>/) || [])[0]
        || (block.match(/<address\b[^>]*\/>/) || [])[0] || ''
      const ip = attrib(addrTag, 'addr')
      if (!isIP(ip)) continue
      const ports = []
      const portRe = /<port\b[^>]*>[\s\S]*?<\/port>/g
      for (const fragment of block.match(portRe) || []) {
        const header = (fragment.match(/<port\b[^>]*>/) || [''])[0]
        const stateTag = (fragment.match(/<state\b[^>]*>/) || [''])[0]
        if (attrib(stateTag, 'state') !== 'open') continue
        const port = Number(attrib(header, 'portid'))
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue
        const serviceTag = (fragment.match(/<service\b[^>]*\/?>/) || [''])[0]
        ports.push({ port, proto: attrib(header, 'protocol') || 'tcp',
          service: attrib(serviceTag, 'name') || undefined,
          product: attrib(serviceTag, 'product') || undefined,
          version: attrib(serviceTag, 'version') || undefined,
          provenance: 'active', tool: 'nmap' })
      }
      assets.push({ ip, state: 'live', provenance: 'active', tool: 'nmap',
        primary_name: isIP(target) ? undefined : target,
        names: !isIP(target) ? [{ name: target, kind: 'hostname', provenance: 'active' }] : [],
        ports })
    }
    return assets
  }
  if (kind === 'httpx') {
    const assets = []
    for (const line of String(text).split(/\r?\n/)) {
      if (assets.length >= 1) break
      if (!line.trim()) continue
      let item
      try { item = JSON.parse(line) } catch { continue }
      const src = item.url || item.input || item.host
      if (!src || scanHost(src) !== target) continue
      const ip = [item.a, item.ip, item.host, target].find((x) => typeof x === 'string' && isIP(x))
      if (!ip) continue
      let url
      try { url = new URL(/^https?:\/\//i.test(src) ? src : 'https://' + src) } catch { continue }
      const port = Number(item.port) || Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
      const technology = Array.isArray(item.tech) ? item.tech : []
      assets.push({ ip, state: 'live', provenance: 'active', tool: 'httpx',
        primary_name: isIP(target) ? undefined : target,
        names: !isIP(target) ? [{ name: target, kind: 'hostname', provenance: 'active' }] : [],
        ports: [{ port, proto: 'tcp', provenance: 'active', tool: 'httpx',
          service: 'http', url: String(item.url || url.href), title: item.title || undefined,
          fingerprints: technology.map((product) => ({ category: '框架', product: String(product) })) }] })
    }
    return assets
  }
  throw new Error('scan kind must be nmap or httpx')
}

export async function runLocalActiveDiscovery(store, req, options = {}) {
  const id = typeof req.engagement === 'string' && req.engagement.trim()
    ? req.engagement.trim() : store.activeEngagementId?.()
  const engagement = store.listEngagements().find((e) => e.id === id)
  if (!engagement) throw new Error('engagement not found')
  const kind = req.kind === 'httpx' ? 'httpx' : req.kind === 'nmap' ? 'nmap' : null
  if (!kind) throw new Error('kind must be nmap or httpx')
  const target = String(req.target || '').trim()
  const scopes = Array.isArray(engagement.scope) ? engagement.scope : []
  const scope = targetInScope(scopes, target, { confirm: req.confirm === true })
  if (!scope.ok) throw new Error(scope.reason === 'outside-scope'
    ? '目标不在当前项目登记的范围内' : scope.reason === 'scope-empty-needs-confirm'
      ? '此项目没有登记范围；请确认授权目标后勾选确认'
      : '目标无效或尚未获得授权确认')
  const result = await executeScanAndIngest({
    kind, target, ports: kind === 'nmap' ? req.ports : undefined,
    outputDir: join(store.dirOf(id), 'scan-output'),
    commit: req.commit === true,
  }, {
    root: store.root, ...options,
    ingest: async ({ file, kind, commit, argv }) => {
      const content = readFileSync(file, 'utf8')
      const assets = parseLocalDiscovery(kind, content, target).filter((item) => {
        // One target per request, and never import an asset outside the known scope.
        if (!scopes.length) return item.ip === scanHost(target) || item.primary_name === scanHost(target)
        return targetInScope(scopes, item.ip).ok || (item.primary_name === scanHost(target) && scope.ok)
      })
      const ports = assets.reduce((sum, item) => sum + item.ports.length, 0)
      if (!commit) return { ok: true, kind, dry_run: true, assets: assets.length, ports, vulns: 0 }
      const imported = assets.length
        ? store.importBundle(id, { scan: { tool: kind, argv: [kind, ...argv] }, assets })
        : null
      return { ok: true, kind, dry_run: false, assets: assets.length, ports, vulns: 0,
        imported, note: !assets.length ? '未解析到可直接入库的目标 IP；原始输出已保留，可进一步人工核对。' : undefined }
    },
  })
  return {
    ok: !!result.ok, engagement: id, kind, target, scope: scope.reason,
    status: result.status, ingested: !!result.ingested,
    assets: Number(result.ingest?.assets) || 0, ports: Number(result.ingest?.ports) || 0,
    output_file: result.outputFile || null, manifest_file: result.manifestFile || null,
    error: result.error || result.ingest?.error || null,
    note: result.ingest?.note || '本机单目标扫描；即使有发现也不表示已确认漏洞。',
  }
}
