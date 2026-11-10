/**
 * Cyberspace-search service catalog. Selecting an entry never invokes an API,
 * gathers credentials, or probes a target.
 */
export const INTEL_SOURCES = Object.freeze([
  { id: 'local', name: '本地资产库', url: null, language: '中文', mode: 'local',
    focus: '当前工作区已有资产、端口、标题、指纹、证据',
    details: 'SQLite 离线组合检索与证据关联；无需商业 API，可直接在本页查询。' },
  { id: 'fofa', name: 'FOFA', url: 'https://fofa.info/', language: '中文 / 英文', mode: 'existing-skill',
    focus: '网络资产、Web 指纹、端口和证书',
    details: '原有 fofa-recon 专项技能仍保留；调用其 API 需要另外配置 FOFA_KEY，未配置不会影响本地搜索。' },
  { id: 'shodan', name: 'Shodan', url: 'https://www.shodan.io/', language: '英文', mode: 'website-only',
    focus: '互联网设备、开放端口、服务 Banner',
    details: '适合设备和网络服务线索；作战台当前只提供网页入口，没有直连 Shodan API。' },
  { id: 'censys', name: 'Censys', url: 'https://search.censys.io/', language: '英文', mode: 'website-only',
    focus: '互联网主机、TLS 证书、资产关联',
    details: '偏重主机与证书信息核对；作战台当前只提供网页入口，没有直连 Censys API。' },
  { id: 'zoomeye', name: 'ZoomEye', url: 'https://www.zoomeye.org/', language: '中文 / 英文', mode: 'website-only',
    focus: '网络空间设备与服务指纹',
    details: '可以与其它平台的数据交叉对照；作战台当前只提供网页入口，没有直连 ZoomEye API。' },
  { id: 'quake', name: '360 Quake', url: 'https://quake.360.net/', language: '中文', mode: 'website-only',
    focus: '网络空间资产和网络设备信息',
    details: '360 的互联网资产测绘平台；作战台当前只提供网页入口，没有直连 Quake API。' },
  { id: 'hunter', name: 'Hunter', url: 'https://hunter.how/', language: '中文', mode: 'website-only',
    focus: '网络空间资产、指纹、服务检索',
    details: '可补充国内资产线索；作战台当前只提供网页入口，没有直连 Hunter API。' },
  { id: 'netlas', name: 'Netlas', url: 'https://app.netlas.io/', language: '英文', mode: 'website-only',
    focus: 'DNS、证书、主机与服务元数据',
    details: '适合资产元数据关联；作战台当前只提供网页入口，没有直连 Netlas API。' },
])
const IDS = new Set(INTEL_SOURCES.map((p) => p.id))

export function normalizeIntelSources(value) {
  const raw = value && Array.isArray(value.selected) ? value.selected : ['local']
  const selected = [...new Set(raw.filter((id) => typeof id === 'string' && IDS.has(id)))]
  const preferred = value && selected.includes(value.preferred) ? value.preferred : (selected[0] || 'local')
  return { selected, preferred }
}
