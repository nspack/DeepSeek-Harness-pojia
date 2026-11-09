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

export async function probeLocalArtex() {
  try {
    const reply = await fetch(HEALTH_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(900),
      redirect: 'error',
    })
    if (!reply.ok) return null
    const info = await reply.json()
    return info && info.ok === true && info.service === 'artex'
      ? { version: typeof info.version === 'string' ? info.version : '' }
      : null
  } catch { return null }
}

/** No ARTEX login, database, or model API is accessed. */
export async function inspectArtex(options = {}) {
  const env = options.env || process.env
  const probe = options.probe || probeLocalArtex
  const live = await probe()
  const tools = ARTEX_SHARED_TOOLS.map(id => ({ id, path: findArtexTool(id, options) }))
  const found = tools.filter(x => x.path)
  return {
    ok: true,
    online: !!live,
    version: live?.version || '',
    url: 'http://127.0.0.1:8787/',
    toolCount: found.length,
    tools: found,
    toolRoots: artexToolRoots(env).filter(existsSync),
    skillDir: env.ARTEX_SKILL_DIR && existsSync(env.ARTEX_SKILL_DIR) ? resolve(env.ARTEX_SKILL_DIR) : '',
    note: live ? 'ARTEX 服务已确认；共享工具按本机文件路径解析'
      : '未发现运行中的 ARTEX 服务；若存在已安装的共享工具，仍可直接复用',
  }
}
