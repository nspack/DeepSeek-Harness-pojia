/**
 * On-demand, non-scanning binary check for tools already resolved by DSH.
 * Paths are resolved server-side from the known catalog; the browser sends
 * only the ID. Never run these commands during refresh or in a background loop.
 */
import { execFile } from 'node:child_process'
import { resolveTool, TOOL_CATALOG } from './platform-config.js'

export async function probeInstalledTool(id, options = {}) {
  const entry = TOOL_CATALOG.find((item) => item.id === id)
  if (!entry) return { ok: false, id, status: 'unknown', error: '未知工具标识' }
  const tool = resolveTool(id, options)
  if (!tool.path) return { ok: false, id, status: 'missing', error: '没有发现工具路径' }
  if (!entry.probeArgs) {
    return { ok: true, id, status: 'path-only', source: tool.source, path: tool.path,
      note: '已找到路径；该工具未配置可靠的版本检测参数，尚未验证能否运行。' }
  }
  const runner = options.execFileFn || execFile
  return new Promise((resolve) => {
    try {
      runner(tool.path, entry.probeArgs, {
        timeout: 3000, maxBuffer: 8192, windowsHide: true, shell: false,
      }, (error, stdout, stderr) => {
        const raw = [stdout, stderr].map((s) => String(s || '').trim()).find(Boolean) || ''
        const version = raw.split(/\r?\n/).find(Boolean)?.trim().slice(0, 180) || ''
        if (error) {
          resolve({ ok: false, id, status: error.killed ? 'timeout' : 'failed',
            source: tool.source, path: tool.path, error: error.killed ? '版本检测超时' : '版本命令执行失败', version })
          return
        }
        resolve({ ok: true, id, status: 'runnable', source: tool.source, path: tool.path,
          version: version || '命令成功（未输出版本）' })
      })
    } catch {
      resolve({ ok: false, id, status: 'failed', source: tool.source, path: tool.path, error: '无法启动工具版本命令' })
    }
  })
}
