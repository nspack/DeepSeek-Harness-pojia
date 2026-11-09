/** Native registration must be evidenced by the exact scoped skills.list result. */
export function markLocalSkillCatalog(payload, registryState) {
  if (!payload || payload.ok === false || !Array.isArray(payload.items)) return payload
  const note = {
    'no-redteam': '宿主技能服务已响应，但红队预设没有列出红队技能；本地文件可读并不代表已注册。',
    'service-unavailable': '尚未获取 DSH 原生 skills 服务；本地技能仍可由检索/读取工具访问。',
    'preset-unavailable': '尚未获取 DSH agentPresets 服务；无法确认红队预设作用域。',
    'scope-unavailable': '无法取得 redteam 预设的宿主作用域；请确认预设已挂载。',
    'list-failed': '原生 skills.list 查询失败；以下不是宿主注册结果。',
    empty: '原生技能服务返回空列表；以下仅为本地技能。',
  }
  return {
    ...payload, registryState, hostListedCount: 0,
    items: payload.items.map((item) => item.library === 'official'
      ? item : { ...item, hostListed: false }),
    note: note[registryState] || '尚未从 DSH 宿主确认红队技能注册；以下仅为本地文件。',
  }
}

export function markNativeSkillCatalog(payload, nativeItems) {
  if (!payload || payload.ok === false || !Array.isArray(payload.items)) return payload
  const source = Array.isArray(nativeItems) ? nativeItems : []
  const listed = new Set(source.filter((item) => item && typeof item.name === 'string')
    .map((item) => (item.library || 'redteam') + ':' + item.name))
  return {
    ...payload, registryState: 'listed', hostListedCount: source.length,
    items: payload.items.map((item) => ({
      ...item, hostListed: listed.has((item.library || 'redteam') + ':' + item.name),
    })),
  }
}
