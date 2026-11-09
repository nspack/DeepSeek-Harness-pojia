/**
 * Read-only ARTEX local integration.
 *
 * ARTEX Desktop identifies its Go backend at 127.0.0.1:8787/api/health and
 * manages Windows tools below %LOCALAPPDATA%/ARTEX/tools. We only reuse
 * executable paths from that layout; we never read ARTEX credentials,
 * change ARTEX configuration, or start an ARTEX process.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

const HEALTH_URL = 'http://127.0.0.1:8787/api/health'
export const ARTEX_SHARED_TOOLS = ['nuclei', 'httpx', 'subfinder', 'ffuf', 'dnsx', 'naabu', 'katana']

export function artexToolRoots(env = process.env) {
  const dirs = String(env.ARTEX_TOOL_DIRS || '').split(delimiter).filter(Boolean)
  if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'ARTEX', 'tools'))
  return [...new Set(dirs.map(x => x.trim()).filter(Boolean).map(x => resolve(x)))]
}

function usableFile(file, platform) {
  try {
    const info = statSync(file)
    return info.isFile() && (platform === 'win32' || (info.mode & 0o111) !== 0)
  } catch { return false }
}

/** Locate only the small set of binaries that ARTEX's Tool Manager supports. */
export function findArtexTool(id, options = {}) {
  if (!ARTEX_SHARED_TOOLS.includes(id)) return null
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const binary = id + (platform === 'win32' ? '.exe' : '')
  for (const root of artexToolRoots(env)) {
    const paths = [
      join(root, binary), join(root, id, binary), join(root, id, 'current', binary),
    ]
    // Older or manual ARTEX layouts may use a versioned folder instead of current/.
    const base = join(root, id)
    if (existsSync(base)) {
      try {
        for (const name of readdirSync(base).sort().reverse()) {
          if (name.startsWith('.') || name === 'current') continue
          paths.push(join(base, name, binary))
        }
      } catch { /* inaccessible tool folder */ }
    }
    for (const path of paths) if (usableFile(path, platform)) return path
  }
  return null
}

/**
 * The health endpoint differs across ARTEX forks. Only an explicit service
 * identity confirms ARTEX; 401/403 and a generic 200 are unverified candidates.
 * Redirects are never followed and credentials are never sent.
 */
export async function probeLocalArtex(options = {}) {
  const request = options.fetchFn || fetch
  try {
    const reply = await request(HEALTH_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(900),
      redirect: 'manual',
    })
    const httpStatus = reply.status
    if (httpStatus === 401 || httpStatus === 403) {
      return { state: 'service_candidate', httpStatus,
        reason: '本机健康接口需要认证，尚不能确认服务身份' }
    }
    if (!reply.ok) {
      return { state: 'service_candidate', httpStatus,
        reason: '本机健康接口响应异常，尚不能确认服务身份' }
    }
    let info
    try { info = await reply.json() }
    catch {
      return { state: 'service_candidate', httpStatus,
        reason: '健康接口未返回有效 JSON，尚不能确认服务身份' }
    }
    if (!info || info.service !== 'artex') {
      return { state: 'service_candidate', httpStatus,
        reason: '健康接口没有可验证的 ARTEX 服务标识' }
    }
    if (info.ok !== true) {
      return { state: 'degraded', httpStatus,
        reason: 'ARTEX 身份已确认，但健康状态异常' }
    }
    return { state: 'detected', httpStatus,
      version: typeof info.version === 'string' ? info.version : '' }
  } catch {
    return { state: 'absent', httpStatus: null,
      reason: '本机健康接口无响应' }
  }
}

/** No ARTEX login, database, or model API is accessed. */
export async function inspectArtex(options = {}) {
  const env = options.env || process.env
  const probe = options.probe || probeLocalArtex
  const result = await probe()
  // Keep compatible with existing in-process probes that return {version}.
  const health = result?.state ? result : result ? { state: 'detected', ...result }
    : { state: 'absent' }
  const tools = ARTEX_SHARED_TOOLS.map(id => ({ id, path: findArtexTool(id, options) }))
  const found = tools.filter(x => x.path)
  const state = health.state === 'absent' && found.length > 0
    ? 'installed_offline' : health.state
  const online = state === 'detected'
  return {
    ok: true,
    online,
    state,
    httpStatus: health.httpStatus ?? null,
    version: online ? (health.version || '') : '',
    url: 'http://127.0.0.1:8787/',
    toolCount: found.length,
    tools: found,
    toolRoots: artexToolRoots(env).filter(existsSync),
    skillDir: env.ARTEX_SKILL_DIR && existsSync(env.ARTEX_SKILL_DIR) ? resolve(env.ARTEX_SKILL_DIR) : '',
    note: health.reason || (online ? 'ARTEX 服务身份已确认'
      : state === 'installed_offline' ? '找到 ARTEX 本机工具，但没有检测到运行中的 ARTEX 服务'
      : '未检测到本机 ARTEX 服务'),
  }
}
