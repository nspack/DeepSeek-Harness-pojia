/**
 * Read-only task-to-tool suggestions. Do not infer that a local binary path
 * implies a runnable tool, or that a version check means a target was scanned.
 */
import { TOOL_CATALOG, loadPlatformConfig, resolveTool } from './platform-config.js'
import { probeInstalledTool } from './tool-health.js'

export const TASK_TOOL_PROFILES = [
  { id: 'domains', label: '域名与 DNS 资产', toolIds: ['subfinder', 'dnsx', 'ksubdomain'] },
  { id: 'services', label: '端口与服务盘点', toolIds: ['nmap', 'naabu', 'masscan'] },
  { id: 'web', label: 'Web 资产梳理', toolIds: ['httpx', 'katana', 'ffuf'] },
  { id: 'vulns', label: '漏洞检测准备', toolIds: ['nuclei', 'nmap'] },
  { id: 'internal', label: '内部网络资产盘点', toolIds: ['fscan', 'gogo', 'nmap'] },
  { id: 'identity', label: '身份服务检查准备', toolIds: ['impacket'] },
  { id: 'connectivity', label: '网络连接工具准备', toolIds: ['chisel', 'frpc', 'suo5'] },
]

export function listTaskToolProfiles() {
  return TASK_TOOL_PROFILES.map(({ id, label, toolIds }) => ({ id, label, toolIds: [...toolIds] }))
}

export function planTaskTools(task, options = {}) {
  const profile = TASK_TOOL_PROFILES.find((item) => item.id === task)
  if (!profile) return { ok: false, task, error: '未知任务类型', profiles: listTaskToolProfiles() }
  const cfg = options.config || loadPlatformConfig(options.root)
  const candidates = profile.toolIds.map((id) => {
    const binary = resolveTool(id, { ...options, config: cfg })
    const def = TOOL_CATALOG.find((item) => item.id === id)
    return {
      id, label: def?.label || id, path: binary.path, source: binary.source,
      detected: !!binary.path, canProbe: !!def?.probeArgs,
      verification: 'not-run',
    }
  })
  // For the same task prefer a detected binary with an explicit version probe.
  // It is still only 'located' until its version command is run.
  const selected = candidates.find((item) => item.detected && item.canProbe)
    || candidates.find((item) => item.detected) || null
  return {
    ok: true, task, label: profile.label,
    status: selected ? 'located' : 'missing',
    selected, candidates,
    note: selected
      ? '仅完成本机工具匹配；未执行版本检测、网络探测或目标操作。'
      : '没有找到本任务对应的已知工具；可检查路径或使用其他现有工具。',
  }
}

export async function verifyTaskTool(task, options = {}) {
  const plan = planTaskTools(task, options)
  if (!plan.ok || !plan.selected) return { ...plan, verification: null }
  const verification = await probeInstalledTool(plan.selected.id, options)
  return {
    ...plan,
    verification,
    status: verification.status === 'runnable' ? 'version-verified'
      : verification.status === 'path-only' ? 'path-only' : 'verification-failed',
    note: verification.status === 'runnable'
      ? '所选工具的本地版本命令执行成功；未向任何目标发送请求，不表示实际测试任务成功。'
      : '工具未通过版本命令验证（或没有适用版本参数）；不代表目标测试结果。',
  }
}
