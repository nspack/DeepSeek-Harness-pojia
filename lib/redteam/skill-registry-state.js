/**
 * A readable local Skill file is not evidence that the native DSH registry
 * exposes it in the active preset scope. Keep those facts separate.
 */
export function markLocalSkillCatalog(payload, registryState) {
  if (!payload || payload.ok === false || !Array.isArray(payload.items)) return payload
  return {
    ...payload,
    registryState,
    hostListedCount: 0,
    items: payload.items.map((item) => item.library === 'official'
      ? item : { ...item, hostListed: false }),
    note: registryState === 'no-redteam'
      ? '宿主技能服务可访问，但当前红队预设没有列出红队技能；下方是本地文件清单，并不表示模型已加载。'
      : '尚未从 DSH 宿主确认红队技能注册；下方仅为本地技能文件清单，不表示模型可以调用。',
  }
}

export function markNativeSkillCatalog(payload, count) {
  if (!payload || payload.ok === false || !Array.isArray(payload.items)) return payload
  return {
    ...payload,
    registryState: 'listed',
    hostListedCount: count,
    items: payload.items.map((item) => item.library === 'redteam'
      || (item.library === 'aboutsecurity' && item.provider === 'dsh-purge-aboutsecurity')
      ? { ...item, hostListed: true }
      : item.library === 'official' ? item : { ...item, hostListed: false }),
  }
}
