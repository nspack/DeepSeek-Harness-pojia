/**
 * RedTeam 智能体工具集（preset 平面）
 *
 * 这些行只向 `tools` 注册模型可见工具，自身不发布任何服务，因此不需要 isolate realm；
 * 它们解析的是 host 平面的 `ctx.redteam`（dsh-redteam-store 发布的进程级实例）。
 *
 * 设计约定：
 *   · 写入一律走 redteam_asset_add / redteam_asset_link，智能体不直接碰 SQL；
 *   · 每次发现都带 provenance（passive|active）与 tool，保证界面上的来源标注可信；
 *   · **靶标按根会话隔离**：绑定键是会话的根祖先 id，子智能体顺着
 *     `session.header.parentSession` 继承父会话的靶标 —— 多会话并行时互不串写，
 *     报告不会再被别的靶标的成果污染（v0.9.0 之前的全局「当前靶标」指针正是串写的根源）；
 *   · 并发硬约束：`redteam_agent_slot` 用 `ctx.subagents.listChildren` 的真实运行数
 *     卡住"同一靶标最多 3 个执行智能体"，超了直接拒绝，不靠提示词自觉。
 */
// 每个工具的中文说明、参数注释与调用链：docs/drill-tools-reference.md（人工维护；测试检查工具名与文档同步）
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ROLE_TITLES, PLANNER_ROLE, ROLE_ORDER } from './store-core.js'
/* 技能可用性判定只有一份实现：面板的「技能库」页签与这里共用（见该文件头注释） */
import { bundledSkillSummaries, checkSkill, summarizeSkills, expandSkillPath, redteamSummariesForCheck } from './skill-availability.js'
import {
  loadPlatformConfig,
  mergeConfigEnv,
  platformSummary,
  toolkitDirOf,
} from './platform-config.js'
import { maxAgentsOf, DEFAULT_MAX_AGENTS, MAX_AGENTS_LIMIT } from './settings.js'
import { EvidenceLedger, UnknownRegistry } from './evidence-ledger.mjs'
import { isUntestedLiveAsset, reviewScoring, nextTaskCard, taskKey, filterBlockedActions, compareProgress, sessionReadiness, reviewCandidateQueue, candidateQueuePage, decideTaskHandoff, planUntestedAssetTasks, unblockedTaskWindow } from './score-triage.js'
import { reviewScope, reviewDelivery } from './review-tools.js'
import { queryPage, pageMetadata, compactVuln } from './query-options.js'
import { taskContext } from './task-context.js'
import { matchCveCandidates, loadCveCatalog } from './cve-knowledge.js'
import { searchLocalSkills, readLocalSkill } from './skill-catalog.js'
import { listTaskToolProfiles, planTaskTools, verifyTaskTool } from './task-tool-plan.js'
import { executeScanAndIngest } from './scan-runner.js'

import { PY_SOURCES, explainDbError, probeTcp, runPython } from './cred-check.js'

/**
 * link: 源码包不在 profile node_modules 树内，静态 import `@deepseek-ai/dsh-tools`
 * 会解析失败 → 预设行 fiber 为 undefined（never started）→ 整份「红队模式」被下拉过滤。
 * 这里从运行中的 dsh / profile 路径 createRequire。
 */
function addCandidate(list, pkg) {
  if (!pkg) return
  const norm = String(pkg).replace(/\\/g, '/')
  if (!list.includes(norm)) list.push(norm)
}

function considerBin(list, bin) {
  if (!bin) return
  let text = String(bin).replace(/\\/g, '/')
  try { text = realpathSync(bin).replace(/\\/g, '/') } catch { /* 解析不了就用原路径 */ }
  const needle = '/node_modules/@deepseek-ai/dsh/'
  const at = text.lastIndexOf(needle)
  if (at >= 0) addCandidate(list, text.slice(0, at + needle.length - 1) + '/package.json')
  const nm = text.lastIndexOf('/node_modules/')
  if (nm >= 0) addCandidate(list, join(text.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dir = dirname(text)
  /* npm 全局的 argv 常常是 …/bin/dsh，真正的包在旁边的 lib/node_modules。 */
  addCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

function loadDefineTool() {
  const candidates = []
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@deepseek-ai/dsh-tools')
    const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
    if (typeof fn === 'function') return fn
  } catch { /* 插件自己的 node_modules 里没有，再扫宿主 */ }
  try { considerBin(candidates, process.argv[1]) } catch { /* ignore */ }
  try { considerBin(candidates, process.execPath) } catch { /* ignore */ }
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    addCandidate(candidates, join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default']) {
      addCandidate(candidates, join(home, 'profiles', profile, 'package.json'))
      addCandidate(candidates, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  const resources = process.resourcesPath || ''
  const exeDir = process.execPath ? dirname(process.execPath) : ''
  const desktopRoots = [
    resources,
    exeDir ? join(exeDir, 'resources') : '',
    exeDir,
  ].filter(Boolean)
  for (const root of desktopRoots) {
    addCandidate(candidates, join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  addCandidate(candidates, join(process.cwd(), 'package.json'))
  addCandidate(candidates, join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const pkg of candidates) {
    try {
      if (!pkg || !existsSync(pkg)) continue
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* try next */ }
  }
  throw new Error('dsh-purge/redteam/tools: cannot resolve @deepseek-ai/dsh-tools from host')
}

const defineToolRaw = loadDefineTool()

/** 0.2.1：任何 type=object 都必须显式 additionalProperties，否则整份红队预设加载失败。 */
function sealObjectSchemas(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    for (const item of node) sealObjectSchemas(item)
    return node
  }
  if (node.type === 'object' && node.additionalProperties === undefined) {
    node.additionalProperties = node.properties ? false : true
  }
  if (node.properties) {
    for (const key of Object.keys(node.properties)) sealObjectSchemas(node.properties[key])
  }
  if (node.items) sealObjectSchemas(node.items)
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    sealObjectSchemas(node.additionalProperties)
  }
  return node
}

function defineTool(spec) {
  if (spec && spec.parameters) sealObjectSchemas(spec.parameters)
  const tool = defineToolRaw(spec)
  if (tool && tool.parameters) sealObjectSchemas(tool.parameters)
  if (tool && tool.inputSchema) sealObjectSchemas(tool.inputSchema)
  if (tool && tool.schema) sealObjectSchemas(tool.schema)
  return tool
}

/** Cordis 插件名。 */
export const name = 'dsh-purge-redteam-tools'

/** 硬依赖工具注册表；`redteam` 在 host 平面由 store 发布，预设域内用软取。 */
export const inject = ['tools']

/** 根会话 id → engagementId 绑定（一次会话内稳定；进程重启后由 agent 重新绑定）。 */
const bindings = new Map()

/** 并发闸门：根会话 id → Map(子智能体键 → 预留时间戳)。子智能体结束时自动释放。 */
const reservations = new Map()

/** FIFO cap:长会话累积失效的 session id,防无限涨。订单最老的被淘汰(FIFO,近似 LRU)。 */
const BINDINGS_CAP = 500
const RESERVATIONS_CAP = 500
function capMap(m, cap) {
  const origSet = m.set.bind(m)
  m.set = (k, v) => {
    if (!m.has(k) && m.size >= cap) {
      const first = m.keys().next().value
      if (first !== undefined) m.delete(first)
    }
    return origSet(k, v)
  }
}
capMap(bindings, BINDINGS_CAP)
capMap(reservations, RESERVATIONS_CAP)

/** 并发上限：每次调用现读 settings.json → REDTEAM_MAX_AGENTS → 默认 3。 */
function maxAgentsNow(ctx) {
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  return maxAgentsOf(root, process.env)
}

/** 一次调用的会话解析结果。 */
function sessionInfoOf(exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (session === undefined || session === null) return {}
  const id = session.id === undefined ? undefined : String(session.id)
  let parentId
  try {
    const header = session.header
    parentId = header && header.parentSession !== undefined && header.parentSession !== null
      ? String(header.parentSession)
      : undefined
  } catch { parentId = undefined }
  return { id: id, parentId: parentId, session: session }
}

/** 会话 id（兼容旧调用点）。 */
function sessionOf(exec) {
  return sessionInfoOf(exec).id
}

/**
 * 解析"根会话"：一路沿 parentSession 走到最顶层的会话 id。
 * 主会话派出的子智能体因此共享同一个绑定键，而**不同主会话之间天然隔离**。
 * 顺手把沿途会话 id 都返回，便于把绑定缓存到子会话上。
 */
function resolveRootSession(session) {
  const chain = []
  let cur = session
  let guard = 0
  while (cur !== undefined && cur !== null && guard < 64) {
    const info = sessionInfoOf({ agent: { session: cur } })
    if (info.id === undefined) break
    chain.push(info.id)
    if (info.parentId === undefined || info.parentId === '') break
    let parent
    try {
      const store = cur.store
      parent = store && typeof store.get === 'function' ? store.get(info.parentId) : undefined
    } catch { parent = undefined }
    if (parent === undefined || parent === null) {
      /* 父会话不在内存里（被回收 / 冷启动）：父 id 本身就是稳定的根键 */
      return { rootId: info.parentId, chain: chain.concat([info.parentId]) }
    }
    cur = parent
    guard += 1
  }
  return { rootId: chain.length > 0 ? chain[chain.length - 1] : undefined, chain: chain }
}

/** 绑定键 + 会话链。 */
function bindingKeyOf(exec) {
  const info = sessionInfoOf(exec)
  if (info.id === undefined) return { rootId: undefined, sessionId: undefined, chain: [] }
  const resolved = resolveRootSession(info.session)
  const rootId = resolved.rootId === undefined ? info.id : resolved.rootId
  return { rootId, sessionId: info.id, chain: resolved.chain }
}

/**
 * 解析本次调用应作用在哪个靶标上（会话隔离版）。
 *
 * 顺序：① 显式传入 → ② 本会话/父链上的绑定 → ③ 全局「当前靶标」指针
 * （仅当没有被别的会话占用；被占用时报错并提示显式绑定，**绝不静默串写**）。
 *
 * 抛错而不是"随便挑一个"是刻意的：多会话并行时挑错靶标 = 把 A 单位的成果写进
 * B 单位的库、A 的报告里出现 B 的数据（这正是要多会话隔离的原因）。
 */
function resolveEngagement(store, exec, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  const keys = Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
  for (const key of keys) {
    const bound = bindings.get(key)
    if (typeof bound === 'string' && bound.length > 0) return bound
  }
  if (typeof store.activeEngagementId === 'function') {
    const active = store.activeEngagementId()
    if (active !== undefined) {
      const holder = Array.from(bindings.entries()).find(([k, v]) => v === active && !keys.includes(k))
      if (holder !== undefined) {
        throw new Error(
          '本会话尚未绑定靶标，而全局「当前靶标」' + active + ' 已被另一个会话占用；'
          + '为避免多会话串写同一个靶标库，请显式绑定：redteam_engagement_open（新建/打开）'
          + ' 或 redteam_session_bind（绑定到已有靶标）。',
        )
      }
      for (const key of keys) bindings.set(key, active)
      return active
    }
  }
  const list = store.listEngagements()
  if (list.length === 1) {
    for (const key of keys) bindings.set(key, list[0].id)
    return list[0].id
  }
  throw new Error('尚未绑定靶标：请先调用 redteam_engagement_open 传入靶标单位名称')
}

/** 当前会话的绑定关系（redteam_session_info 与面板展示用）。 */
function bindingViewOf(exec) {
  const info = sessionInfoOf(exec)
  const { rootId, chain } = bindingKeyOf(exec)
  return {
    session_id: info.id ?? null,
    parent_session: info.parentId ?? null,
    root_session: rootId ?? null,
    session_chain: chain,
    is_subagent: info.parentId !== undefined,
    bound_engagement: rootId !== undefined ? (bindings.get(rootId) ?? null) : null,
  }
}

/** 逗号/空白分隔的清单 → 去重数组。 */
function splitList(value) {
  return String(value || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
}

/** 把一行资产压成模型可读的紧凑结构（避免把整库原始数据塞进上下文）。 */
function compactAsset(a) {
  return {
    id: a.id,
    ip: a.ip,
    segment: a.segment_cidr,
    state: a.state,
    name: a.primary_name,
    names: a.names.map((n) => n.name),
    ports: a.ports.filter((p) => p.state === 'open')
      .map((p) => p.port + '/' + p.proto + (p.service ? ' ' + [p.service, p.product, p.version].filter(Boolean).join(' ') : '') + ' [' + p.provenance + ']'),
    fingerprints: a.fingerprints.map((f) => [f.category, f.vendor, f.product, f.version].filter(Boolean).join(' ') + ' [' + f.provenance + ']'),
    passive: a.passive,
    active: a.active,
    /* 发现时间：这条资产第一次进入本库的时刻（面板与报告都按它排时间线） */
    discovered_at: a.discovered_at,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    test_status: a.test_status,
    priority: a.priority,
  }
}

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/** 角色 code 的合法值说明（写进工具 description，模型不用猜）。 */
const ROLE_HINT = '角色 code：' + ROLE_ORDER.map((r) => '`' + r + '`（' + ROLE_TITLES[r] + '）').join('、')

function bindKeysOf(exec) {
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  return Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
}

/** 实时并发占用：读 subagents 注册表里"真正在跑"的直接子会话数。 */
async function liveRunningChildren(ctx, rootSessionId) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null || typeof subagents.listChildren !== 'function') {
    return { available: false, running: 0, error: 'subagents 注册表不可用（无法核对实际并发数，只能按预留计数）' }
  }
  try {
    const entries = await subagents.listChildren(rootSessionId)
    const rows = Array.isArray(entries) ? entries : []
    const running = rows.filter((e) => e && e.kind === 'child' && e.activity === 'running')
    return {
      available: true,
      running: running.length,
      running_labels: running.map((e) => e.label || e.id).slice(0, 20),
      total_children: rows.filter((e) => e && e.kind === 'child').length,
    }
  } catch (error) {
    return { available: false, running: 0, error: '列子会话失败：' + (error && error.message ? error.message : String(error)) }
  }
}

/** 预留（未被 subagents 注册表覆盖的那部分，例如刚 acquire 还没起来的）。 */
function reservationList(rootId) {
  const map = reservations.get(rootId)
  if (map === undefined) return []
  return Array.from(map, ([key, at]) => ({ key, at }))
}

function addReservation(rootId, key) {
  if (!reservations.has(rootId)) reservations.set(rootId, new Map())
  reservations.get(rootId).set(key, Date.now())
}

function dropReservation(rootId, key) {
  const map = reservations.get(rootId)
  if (map === undefined) return false
  if (key === undefined) {
    /* 无 key 时只释放最早的一条（与工具描述一致）——清空整张表会把别的在途预留一起放掉，名额超卖 */
    let oldestKey = null
    let oldestAt = Infinity
    for (const [k, at] of map) {
      if (at < oldestAt) { oldestAt = at; oldestKey = k }
    }
    return oldestKey !== null ? map.delete(oldestKey) : false
  }
  return map.delete(key)
}

/**
 * 产出这条记录的智能体角色：显式传的优先，否则默认按主会话记账。
 * 这个值会写进库里的 `agent` 列，报告里"这一步是谁做的"就靠它。
 */
function agentOf(args) {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : ''
  return raw !== '' ? raw : PLANNER_ROLE
}

/** 写库工具共用的 agent 参数（角色 code 白名单提示写进 description）。 */
const AGENT_PARAM = {
  type: 'string',
  description: '【建议填】产出这条记录的角色 —— ' + ROLE_HINT
    + '。报告里会按它标注"这一步是谁做的"，不填按主会话记账。',
}

/**
 * 把 store 层抛出的异常统一收敛成结构化的失败返回。
 *
 * 为什么需要：同一类错误（对象不存在 / 参数非法）此前有两种形态 ——
 * 有的工具 `return { ok:false, error }`，有的直接抛。模型拿到前者能换参数重试，
 * 拿到后者往往直接放弃这一次调用，行为不可预测。统一成前者，且**不吞原始信息**。
 * @param tool - defineTool 的返回值。
 * @returns 包了一层 try/catch 的同一个工具定义。
 */
function withStructuredErrors(tool) {
  const inner = tool.execute
  if (typeof inner !== 'function') return tool
  return Object.assign({}, tool, {
    async execute(args, exec) {
      try {
        return await inner(args, exec)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        /* 参数类错误（非法值/缺必填）与"找不到对象"分开提示，模型据此决定重试还是放弃 */
        const kind = /非法|invalid|required|不能为空|not found|不存在/i.test(message) ? 'bad_input' : 'failed'
        return JSON.stringify({
          ok: false,
          error: message,
          error_kind: kind,
          hint: kind === 'bad_input'
            ? '这是参数或对象标识的问题：核对参数名与取值（可用对应的 *_list / *_query 工具先看实际 id），修正后重试。'
            : '工具执行失败，错误原文见 error 字段；不要静默跳过，先向用户或指挥者说明卡点。',
        }, null, 2)
      }
    },
  })
}

export function apply(ctx) {
  let store
  try {
    store = ctx.redteam
  } catch {
    store = undefined
  }
  if (!store) {
    try { store = ctx.get('redteam') } catch { store = undefined }
  }
  if (!store) {
    ctx.logger?.warn?.('redteam-tools: host ctx.redteam unavailable — tools will report store_missing')
    store = {
      openEngagement: () => { throw new Error('redteam store unavailable') },
      listEngagements: () => [],
      stats: () => ({}),
    }
  }

  /* ── 子智能体结束时自动释放并发名额（不依赖模型记得调 release）──────────── */
  /* ctx.effect 包起来 → plugin dispose 时解绑 subagent/end,否则 handler 残留 + 热重载翻倍。 */
  ctx.effect(() => {
    let disposer = null
    try {
      disposer = ctx.on('subagent/end', (info, parent) => {
        const parentSession = parent && parent.session
        const { rootId } = bindingKeyOf({ agent: { session: parentSession } })
        const childId = info && info.id !== undefined ? String(info.id) : undefined
        if (rootId === undefined) return
        if (childId !== undefined && dropReservation(rootId, childId)) return
        /* 注册表里的键可能与 runId 不同：按时间兜底清掉最早的一个预留 */
        const map = reservations.get(rootId)
        if (map === undefined || map.size === 0) return
        let oldestKey
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [key, at] of map) { if (at < oldestAt) { oldestAt = at; oldestKey = key } }
        if (oldestKey !== undefined) map.delete(oldestKey)
      })
    } catch { /* 事件不可用时只影响自动释放，手动 release 仍然可用 */ }
    return () => { try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ } }
  })

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_engagement_open',
    description: '打开或创建一次攻防演练靶标（按单位名称），并把**当前会话**绑定到该靶标（子智能体会自动继承）。后续所有资产工具默认作用于它。若靶标已存在则复用其资产库。写入的是本会话的绑定，不会改动其它会话正在用的靶标。',
    parameters: {
      target: { type: 'string', required: true, description: '靶标单位名称，例如「示例科技有限公司」' },
      scope: {
        type: 'array',
        description: '授权范围 CIDR 列表（可选：用户没给就不用问，按公开可见资产面自主推进）',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      /* bindCurrent: false —— 不动全局「当前靶标」指针：多会话并行时那个指针是串写的根源 */
      const engagement = store.openEngagement(args.target, args.scope, { bindCurrent: false })
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, engagement.id)
      const view = bindingViewOf(exec)
      return JSON.stringify({
        ok: true,
        engagement,
        stats: store.stats(engagement.id),
        session: view,
        note: '已绑定到本会话（会话隔离：其它会话的绑定不受影响）；子智能体会继承本靶标。'
          + (view.is_subagent ? ' 注意：本会话是子智能体，通常不需要再 open，直接继承父会话靶标即可。' : ''),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_bind',
    description: '把一个**已经存在**的靶标绑定到当前会话（多会话并行时用：每个会话绑自己的靶标，互不串写）。可用靶标 id 或单位名称，省略则列出可绑定的靶标。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略只列出候选' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const list = store.listEngagements()
      const wanted = typeof args.engagement === 'string' ? args.engagement.trim() : ''
      if (wanted === '') {
        return JSON.stringify({
          ok: false,
          candidates: list.map((e) => ({ id: e.id, name: e.name, created_at: e.created_at, stats: e.stats })),
          note: '请传 engagement（靶标 id 或单位名称）完成绑定。',
        }, null, 2)
      }
      const hit = list.find((e) => e.id === wanted)
        || list.find((e) => String(e.name) === wanted)
        || list.find((e) => String(e.name).includes(wanted))
      if (hit === undefined) {
        return JSON.stringify({ ok: false, error: '靶标不存在：' + wanted, candidates: list.map((e) => e.id) }, null, 2)
      }
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, hit.id)
      return JSON.stringify({
        ok: true, engagement: { id: hit.id, name: hit.name },
        session: bindingViewOf(exec),
        note: '本会话已绑定到「' + hit.name + '」；后续工具与报告都只作用于它。',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_info',
    description: '查看**当前会话绑定的是哪个靶标**（会话 id、父会话、根会话、绑定链）。多会话同时开工时，先跑它确认自己没串到别人的靶标上。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const view = bindingViewOf(exec)
      const changed = view.bound_engagement !== null ? store.stats(view.bound_engagement) : null
      return JSON.stringify({
        ok: true, session: view, stats: changed,
        bindings_now: Array.from(bindings, ([k, v]) => ({ session: k, engagement: v })),
        note: '绑定是进程内状态：dsh 重启后各会话需要重新绑定一次（redteam_engagement_open / redteam_session_bind）。',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tool_select',
    description: '只读：按任务类型从本机已配置的工具中推荐适用程序并说明来源。verify=true 时仅运行预置工具的本地版本命令（不扫描目标，也不执行任意自定义脚本）。',
    parameters: {
      task: { type: 'string', required: true,
        description: '任务类型：domains / services / web / vulns / internal / identity / connectivity' },
      verify: { type: 'boolean', description: '是否立即验证推荐工具的本地版本命令（默认 false）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const task = String(args.task || '')
      const result = args.verify === true
        ? await verifyTaskTool(task)
        : planTaskTools(task)
      return JSON.stringify({ ...result,
        profiles: listTaskToolProfiles().map((p) => ({ id: p.id, label: p.label })) })
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_preflight',
    description: '【开工前必须跑一次】平台技能与资源自检：逐个检查红队技能的必需环境变量（如 FOFA 测绘的 FOFA_KEY）、本机工具与二进制（suo5 / fscan / gogo / frp / 冰蝎 / 哥斯拉 / nmap / nuclei…）、外部基础设施（反弹 Shell 用的 VPS）。返回 available/broken 清单与每个坏掉的技能"缺什么、怎么补"。**缺 key / 缺 VPS 时直接向用户要，或改用替代方案，不要假装能跑。**',
    parameters: {
      include: { type: 'string', description: '只检查这些技能（逗号分隔）；省略则检查全部红队技能' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      let skills
      try { skills = typeof ctx.get === 'function' ? ctx.get('skills') : null } catch { skills = null }
      const plat = platformSummary()
      const cfg = loadPlatformConfig()
      /* 环境变量的真实来源：进程环境 + $DSH_HOME/.env + 平台 config.json env */
      const envFile = expandSkillPath('$DSH_HOME/.env')
      const effectiveEnv = mergeConfigEnv({ ...process.env }, cfg)
      let envFileKeys = []
      try {
        if (existsSync(envFile)) {
          const { readFileSync } = await import('node:fs')
          for (const line of readFileSync(envFile, 'utf8').split('\n')) {
            /* 兼容 shell 习惯写法：`export KEY=value`；未加引号的行内注释（`KEY=v # 备注`）剥掉 */
            const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
            if (m === null) continue
            const key = m[1]
            let raw = m[2].trim()
            if (!/^["']/.test(raw)) raw = raw.replace(/\s+#.*$/, '')
            const value = raw.replace(/^["']|["']$/g, '').trim()
            if (value === '') continue
            envFileKeys.push(key)
            if (effectiveEnv[key] === undefined || effectiveEnv[key] === '') effectiveEnv[key] = value
          }
        }
      } catch { /* .env 读不到不影响主流程 */ }

      const toolkit = toolkitDirOf(cfg)
      let toolkitEntries = []
      try {
        if (existsSync(toolkit)) {
          const { readdirSync } = await import('node:fs')
          toolkitEntries = readdirSync(toolkit).slice(0, 60)
        }
      } catch { /* 忽略 */ }

      const redteamDir = expandSkillPath('$DSH_HOME/redteam')
      const markerFile = redteamDir + '/.setup-complete'
      const setupScript = redteamDir + '/setup.sh'
      const hasMarker = existsSync(markerFile)
      const hasSetupScript = existsSync(setupScript)
      const toolkitHint = '本插件不替用户下载或安装工具。Windows 与没有 setup.sh 时，到作战台「环境适配」填路径、FOFA_KEY 和 VPS；本机已有 `$DSH_HOME/redteam/setup.sh` 时，由用户自己执行 `--check`，不要由智能体跑 `--yes` 去下载二进制。'
      let fofaKey = effectiveEnv.FOFA_KEY || ''
      const vpsKey = effectiveEnv.REDTEAM_VPS_KEY || (toolkit + (plat.runtime.windows ? '\\vps\\id_rsa' : '/vps/id_rsa'))
      const vpsHost = effectiveEnv.REDTEAM_VPS_HOST || ''
      const hasVps = existsSync(vpsKey)
      const missing = []
      if (fofaKey === '') missing.push('FOFA_KEY（资产测绘：在「环境适配」页填写，或写进 $DSH_HOME/.env）')
      if (!hasVps) {
        missing.push(plat.runtime.windows
          ? 'VPS 私钥（在「环境适配」填写 REDTEAM_VPS_KEY 路径与 REDTEAM_VPS_HOST；Windows 不依赖 setup.sh）'
          : 'VPS 登录方式——私钥放到 ' + vpsKey + '，并设 REDTEAM_VPS_HOST（步骤见技能 redteam-setup，或作战台「环境适配」）')
      }
      const fofaShown = fofaKey.length > 8 ? fofaKey.slice(0, 4) + '…' + fofaKey.slice(-4) : '(已配置)'
      const runtimeHint = plat.runtime.windows
        ? '当前为 **Windows 适配**：请在作战台「环境适配」页配置工具路径/搜索目录与 FOFA/VPS；不要假设存在 Kali/`bash setup.sh`。仍建议用专用演练机，勿在日常办公机上落私钥与扫描器。'
        : '本模式建议在**专供演练的 Kali 虚拟机**里运行，不要跑在日常办公电脑/宿主机上'
          + '（本机落 VPS 私钥与 WebShell 马，扫描流量也从常用出口 IP 出去；演练完虚拟机可直接丢弃）。'

      let checked = []
      let allBroken = []
      let allAvailable = []
      let broken = []
      let available = []
      let only = splitList(args.include)
      let unknownIncludes = []

      const bundledSkills = bundledSkillSummaries()
      const skillsMissing = skills === undefined || skills === null || typeof skills.list !== 'function'
      if (skillsMissing && bundledSkills.length === 0) {
        /* 桌面端常无 skills inject：仍返回平台工具探测，避免整条 preflight 报废 */
        const toolMissing = (plat.tools.items || []).filter((t) => !t.path).map((t) => t.id)
        if (toolMissing.length) {
          missing.push('未解析到的工具（在「环境适配」填路径或加搜索目录）：' + toolMissing.slice(0, 12).join(', '))
        }
        const onboarding = {
          complete: hasMarker && missing.length === 0,
          runtime_hint: runtimeHint,
          first_run: !hasMarker,
          marker: { path: markerFile, exists: hasMarker },
          setup_script: { path: setupScript, exists: hasSetupScript },
          toolkit_hint: toolkitHint,
          configured: {
            fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
            vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
            vps_host: vpsHost,
            env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
            platform_config: { path: cfg.path, exists: !!cfg.exists },
          },
          missing,
        }
        return JSON.stringify({
          ok: missing.length === 0 && toolMissing.length === 0,
          onboarding,
          platform: plat,
          toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
          skills_root_hint: '宿主 skills 服务不可用：已跳过技能正文体检，仅返回平台工具探测。请到「环境适配」配置路径。',
          next: plat.runtime.windows
            ? '打开作战台「环境适配」：① 填 binDirs（你的工具文件夹）或逐个 tools 路径 ② 填 FOFA_KEY / VPS ③ 保存后重新 preflight。不要替用户下载工具。'
            : (hasSetupScript
              ? '可由用户自己执行 bash "$DSH_HOME/redteam/setup.sh" --check，或到「环境适配」手填路径。不要由智能体下载工具。'
              : '本机没有 setup.sh，这是正常情况。到作战台「环境适配」手填路径，或按技能 redteam-setup 逐项配置。'),
        }, null, 2)
      }

      let summaries = []
      let fromBundle = skillsMissing
      let scoped = false
      if (fromBundle) {
        summaries = bundledSkills
      } else {
        try {
          let scope = null
          try {
            const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
            if (presets && typeof presets.standingKeyFor === 'function') {
              scope = await presets.standingKeyFor('redteam')
            }
          } catch { scope = null }
          scoped = scope != null
          const listed = scoped ? await skills.list({ scope }) : await skills.list()
          summaries = redteamSummariesForCheck(listed, bundledSkills, scoped)
          fromBundle = summaries.every((item) => item && item.library === 'redteam' && item.content)
        } catch (error) {
          if (bundledSkills.length === 0) {
            return JSON.stringify({ ok: false, error: '读取技能目录失败：' + (error && error.message ? error.message : String(error)), platform: plat }, null, 2)
          }
          summaries = bundledSkills
          fromBundle = true
        }
      }
      summaries = redteamSummariesForCheck(summaries, bundledSkills, scoped)
      const wanted = summaries.filter((s) => only.length === 0 || only.includes(s.name))
      /* include 时只体检点名的技能：否则 ok 被无关 broken 拖成 false，模型会误以为目标技能坏了 */
      const toCheck = only.length > 0 ? wanted : summaries
      unknownIncludes = only.filter((n) => !summaries.some((s) => s.name === n))
      const rootsWith = new Map()
      for (const x of summaries) {
        const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
        if (dir === null) continue
        if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
        if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
      }
      for (const summary of toCheck) {
        let def
        if (!fromBundle && skills && typeof skills.get === 'function') {
          try { def = await skills.get(summary.name) } catch { def = undefined }
        }
        const path = def && typeof def.path === 'string'
          ? def.path
          : (typeof summary.path === 'string'
            ? summary.path
            : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null))
        const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
        const content = def && typeof def.content === 'string' && def.content.trim() !== ''
          ? def.content
          : summary.content
        const verdict = checkSkill({ name: summary.name, content, path, root },
          { env: effectiveEnv, sameNameIn: rootsWith.get(summary.name) || [] })
        checked.push(Object.assign({}, verdict, {
          title: summary.description,
          path,
          when_to_use: summary.whenToUse || '',
          needs_user: verdict.needs_user.map((n) => (n.startsWith('环境变量')
            ? n + (plat.runtime.windows ? '（可在「环境适配」页填写）' : '（拿到后 export 并重启 dsh web）')
            : n === 'VPS 地址' || n === 'VPS 主机名'
              ? '反弹 Shell / 载荷投递用的 ' + n + '（技能里还是占位符）'
              : n)),
        }))
      }
      allBroken = checked.filter((s) => s.status === 'broken')
      allAvailable = checked.filter((s) => s.status === 'available')
      const shown = (x) => only.length === 0 || only.includes(x.name)
      broken = allBroken.filter(shown)
      available = allAvailable.filter(shown)
      const toolMissing = (plat.tools.items || []).filter((t) => !t.path)
      if (toolMissing.length) {
        missing.push('未解析到的本机工具（「环境适配」填路径）：' + toolMissing.slice(0, 10).map((t) => t.id).join(', '))
      }
      const needsUser = Array.from(new Set(broken.flatMap((s) => s.needs_user)))
      const onboarding = {
        complete: hasMarker && missing.length === 0 && allBroken.length === 0,
        runtime_hint: runtimeHint,
        first_run: !hasMarker,
        marker: { path: markerFile, exists: hasMarker },
        setup_script: { path: setupScript, exists: hasSetupScript },
        toolkit_hint: toolkitHint,
        configured: {
          fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
          vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
          vps_host: vpsHost,
          env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
          platform_config: { path: cfg.path, exists: !!cfg.exists },
        },
        missing,
      }
      let next
      if (plat.runtime.windows && (!hasMarker || missing.length > 0 || allBroken.length > 0)) {
        next = 'Windows：打开作战台「环境适配」配置 toolkit/binDirs/tools 路径与 FOFA/VPS，保存后重跑 redteam_preflight；技能正文缺路径时优先用已解析的工具绝对路径。'
      } else if (!hasMarker && !hasSetupScript) {
        next = '首次使用，且本机没有安装脚本 ' + setupScript + '（这是正常情况，不是故障）。'
          + toolkitHint + ' 把 onboarding.missing 一次性列给用户；补不齐就说明降级：没有 FOFA 用 crt.sh / 被动 DNS，没有 VPS 只做不落地的成果。'
      } else if (!hasMarker) {
        next = '**首次使用**：让用户自己执行 `bash ' + setupScript + ' --check`，或打开作战台「环境适配」。不要由智能体执行 --yes 去下载工具。'
      } else if (missing.length > 0) {
        next = '有缺口：把 onboarding.missing 一次性列给用户。Windows 或没有 setup.sh 时走「环境适配」；有脚本时也只让用户自己跑，不要替用户下载工具。'
      } else if (allBroken.length > 0) {
        next = '把 broken 里 needs_user 一次性列给用户；补不齐则说明降级方案。'
      } else {
        next = '全部可用，可以开工。'
      }

      const summary = summarizeSkills(checked)
      return JSON.stringify({
        /* include 模式：ok 只反映点名技能的体检结果；测绘 key/VPS 等 missing 与此无关，降为参考不拖 ok */
        ok: allBroken.length === 0 && (only.length > 0 || missing.length === 0),
        include: only.length > 0 ? { requested: only, unknown: unknownIncludes, note: 'ok 只覆盖点名的技能；onboarding.missing 是全局参考，不影响本次 ok' } : undefined,
        all_checked: { registry_total: summaries.length, checked: checked.length, broken: allBroken.length, available: allAvailable.length },
        onboarding,
        platform: plat,
        summary,
        checked: checked.length,
        available: available.map((s) => s.name),
        broken: broken.map((s) => ({ name: s.name, problems: s.problems, needs_user: s.needs_user,
          fixes: (s.issues || []).map((i) => i && i.fix).filter(Boolean),
          fix_note: '修复步骤由用户执行（或经「环境适配」页）；不要由你下载/安装工具。' })),
        unknown: checked.filter((s) => s.status === 'unknown').map((s) => s.name),
        toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
        skills_root_hint: '这里只检查红队技能。官方技能在 $DSH_HOME/skills，不按红队工具路径判不可用。',
        next,
        needs_user_flat: needsUser,
        wanted_count: wanted.length,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_agent_slot',
    description: '【主会话派活前后用】执行智能体的并发闸门：同一靶标**最多同时 3 个**在跑（可用 REDTEAM_MAX_AGENTS 配置）。action=status 看还剩几个名额与谁在跑；action=acquire 占一个名额（满了会直接拒绝，**不要重试硬塞**）；action=release 释放（子智能体结束时服务端也会自动释放）。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'acquire', 'release'], description: 'status 查看 / acquire 占用 / release 释放' },
      label: { type: 'string', description: 'acquire 时的任务标签，例如「信息收集：主域与 C 段」' },
      key: { type: 'string', description: 'release 时指定要释放的键（省略则释放最早的一个预留）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const { rootId, sessionId } = bindingKeyOf(exec)
      const owner = rootId ?? sessionId
      if (owner === undefined) {
        return JSON.stringify({ ok: false, error: '取不到会话 id：无法统计并发（请确认工具调用带着 agent 上下文）。' }, null, 2)
      }
      const live = await liveRunningChildren(ctx, owner)
      const reserved = reservationList(owner)
      /* 注册表里 running 的子会话已经包含正在跑的；预留是"刚占位还没出现在注册表"的那部分，
         两者取较大值，避免重复计数又不会漏计 */
      const used = Math.max(live.running, reserved.length)
      const cap = maxAgentsNow(ctx)
      const free = Math.max(cap - used, 0)
      const base = {
        ok: true, max: cap, used, free,
        running_from_registry: live.running,
        running_labels: live.running_labels ?? [],
        reservations: reserved,
        registry_available: live.available,
        registry_note: live.available ? undefined : live.error,
      }
      if (args.action === 'status') {
        return JSON.stringify(Object.assign(base, {
          hint: free === 0
            ? '名额已满：等现有智能体回报后再派（每次只派一个、按顺序推进是最稳的节奏）。'
            : '还有 ' + free + ' 个名额。默认一个一个派；只有确实互不依赖的活才并行。',
        }), null, 2)
      }
      if (args.action === 'acquire') {
        if (free <= 0) {
          return JSON.stringify(Object.assign(base, {
            ok: false,
            error: '并发已满（最多 ' + cap + ' 个）：现在不能派新智能体。先等当前的在跑智能体回报，或先 release 掉已经结束的。',
          }), null, 2)
        }
        const key = (typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : 'slot') + '#' + Date.now()
        addReservation(owner, key)
        return JSON.stringify(Object.assign(base, { slot: key, used: used + 1, free: Math.max(cap - used - 1, 0) }, {
          hint: '已占位（' + key + '）。**派完之后要记得**：子智能体结束会自动释放；若你派活失败（比如工具报错），手动 redteam_agent_slot action=release key=' + key + ' 把它放掉。',
        }), null, 2)
      }
      const dropped = dropReservation(owner, typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : undefined)
      return JSON.stringify(Object.assign(base, { ok: true, released: dropped, used: Math.max(used - (dropped ? 1 : 0), 0) }), null, 2)
    },
  })))

  /* ── 扫描器输出批量摄取 ────────────────────────────────────────────────
     为什么要有它：一个靶标 24k 个端口是 181 轮扫描一条条写进库的，模型逐条调
     redteam_asset_add 既贵又必然漏。这里把 nuclei/httpx/nmap 的输出一次性转成
     bundle 交给 store.importBundle（与手写 add 相同的幂等路径），ffuf 只回路径不写库。
     默认 dry-run：先看会新增多少，再 commit。 */
  const ingestHostPort = (raw) => {
    const s = String(raw || '').trim()
    if (s === '') return null
    try {
      const u = new URL(/^[a-zA-Z]+:\/\//.test(s) ? s : 'http://' + s)
      const host = u.hostname.replace(/^\[|\]$/g, '')
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
      if (!host) return null
      return { host, port, scheme: u.protocol.replace(':', ''), url: u.origin }
    } catch { return null }
  }
  const isIpv4 = (s) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(s || ''))
  const ingestAsset = (map, host, port, extra) => {
    if (!host) return null
    const key = host
    let a = map.get(key)
    if (a === undefined) {
      a = { ip: host, state: 'live', provenance: 'active', tool: extra && extra.tool, names: [], ports: [] }
      map.set(key, a)
    }
    if (!isIpv4(host) && !(a.names || []).some((n) => n.name === host)) a.names.push({ name: host, kind: 'hostname', provenance: 'active' })
    if (port && !a.ports.some((p) => p.port === port)) {
      a.ports.push(Object.assign({ port, proto: 'tcp', provenance: 'active', tool: extra && extra.tool }, extra || {}))
    }
    return a
  }
  const parseNuclei = (text, max) => {
    const out = { vulns: [], assets: new Map(), skipped: 0 }
    for (const line of String(text).split(/\r?\n/)) {
      if (out.vulns.length >= max) break
      const s = line.trim()
      if (s === '' || s[0] !== '{') continue
      let o
      try { o = JSON.parse(s) } catch { out.skipped += 1; continue }
      const info = o.info || {}
      const matched = o['matched-at'] || (o.request && o.request['event-url']) || o.host || o.url || ''
      const hp = ingestHostPort(matched)
      if (hp) ingestAsset(out.assets, hp.host, hp.port, { tool: 'nuclei', url: matched })
      const cls = o.classification || {}
      const cve = Array.isArray(cls.cve) && cls.cve.length ? String(cls.cve[0]) : ''
      out.vulns.push({
        title: String(info.name || o['template-id'] || 'nuclei finding'),
        severity: String(info.severity || 'info').toLowerCase(),
        cve: cve || undefined,
        status: 'candidate',
        target: String(matched || o.host || ''),
        source: 'nuclei',
        evidence: 'template=' + String(o['template-id'] || '') + (o['matcher-name'] ? ' matcher=' + o['matcher-name'] : ''),
        found_by_agent: 'vuln-scan',
      })
    }
    return out
  }
  const parseHttpx = (text, max) => {
    const out = { assets: new Map(), skipped: 0, seen: 0 }
    for (const line of String(text).split(/\r?\n/)) {
      if (out.seen >= max) break
      const s = line.trim()
      if (s === '' || s[0] !== '{') continue
      let o
      try { o = JSON.parse(s) } catch { out.skipped += 1; continue }
      out.seen += 1
      const hp = ingestHostPort(o.url || o.input || o.host)
      if (!hp) continue
      const tech = Array.isArray(o.tech) ? o.tech : (typeof o.tech === 'string' ? o.tech.split(',') : [])
      ingestAsset(out.assets, hp.host, o.port ? Number(o.port) : hp.port, {
        tool: 'httpx', url: o.url || hp.url, title: o.title || undefined,
        service: 'http', fingerprints: tech.filter(Boolean).map((t) => ({ category: '框架', product: String(t).trim() })),
      })
    }
    return out
  }
  const parseNmapXml = (text, max) => {
    const out = { assets: new Map(), skipped: 0 }
    const hostRe = /<host\b[\s\S]*?<\/host>/g
    const hosts = String(text).match(hostRe) || []
    for (const block of hosts.slice(0, max)) {
      const ipm = /<address addr="([^"]+)" addrtype="ipv4"/.exec(block) || /<address addr="([^"]+)"/.exec(block)
      if (!ipm) { out.skipped += 1; continue }
      const ip = ipm[1]
      const asset = ingestAsset(out.assets, ip, null, { tool: 'nmap' })
      const portRe = /<port protocol="(\w+)" portid="(\d+)">([\s\S]*?)<\/port>/g
      let m
      while ((m = portRe.exec(block)) !== null) {
        const state = (/<state state="([^"]+)"/.exec(m[3]) || [])[1] || 'open'
        if (state !== 'open') continue
        const svc = (/<service name="([^"]*)"(?: product="([^"]*)")?(?: version="([^"]*)")?/.exec(m[3]) || [])
        asset.ports.push({
          port: Number(m[2]), proto: m[1] || 'tcp', service: svc[1] || undefined,
          product: svc[2] || undefined, version: svc[3] || undefined,
          provenance: 'active', tool: 'nmap',
        })
      }
    }
    return out
  }
  const parseFfuf = (text, max) => {
    const out = { paths: [], skipped: 0 }
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    if (json && Array.isArray(json.results)) {
      for (const r of json.results.slice(0, max)) out.paths.push({ url: r.url, status: r.status, length: r.length })
      return out
    }
    for (const line of String(text).split(/\r?\n/)) {
      if (out.paths.length >= max) break
      const s = line.trim()
      if (s === '' || s[0] !== '{') continue
      let o
      try { o = JSON.parse(s) } catch { out.skipped += 1; continue }
      out.paths.push({ url: o.url || o.input, status: o.status, length: o.length })
    }
    return out
  }

  const executeIngest = async (args, exec) => {
      const id = resolveEngagement(store, exec, args.engagement)
      const file = String(args.file || '').trim()
      if (file === '') throw new Error('file required')
      const stat = statSync(file)
      if (stat.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB，先切分再导入')
      const text = readFileSync(file, 'utf8')
      let kind = String(args.kind || '')
      if (kind === '') {
        if (/\.xml$/i.test(file)) kind = 'nmap'
        else if (/nuclei/i.test(file)) kind = 'nuclei'
        else if (/httpx/i.test(file)) kind = 'httpx'
        else if (/ffuf/i.test(file)) kind = 'ffuf'
        else kind = /"template-id"/.test(text.slice(0, 2000)) ? 'nuclei' : 'httpx'
      }
      const max = Math.min(Number(args.max) || 5000, 20000)
      const commit = args.commit === true
      if (kind === 'ffuf') {
        const r = parseFfuf(text, max)
        return JSON.stringify({ ok: true, kind, dry_run: !commit, note: 'ffuf 只回路径，不入库；用 redteam_asset_add 的 url 字段或人工挑', count: r.paths.length, sample: r.paths.slice(0, 20) }, null, 2)
      }
      const parsed = kind === 'nmap' ? parseNmapXml(text, max)
        : kind === 'httpx' ? parseHttpx(text, max) : parseNuclei(text, max)
      const assets = [...parsed.assets.values()]
      const vulns = parsed.vulns || []
      const summary = { kind, dry_run: !commit, assets: assets.length, ports: assets.reduce((n, a) => n + a.ports.length, 0), vulns: vulns.length, skipped: parsed.skipped || 0 }
      if (!commit) {
        return JSON.stringify(Object.assign({ ok: true, sample_assets: assets.slice(0, 5), sample_vulns: vulns.slice(0, 5) }, summary), null, 2)
      }
      let imported = { assets: 0, ports: 0 }
      if (assets.length > 0) imported = store.importBundle(id, { scan: { tool: kind, argv: Array.isArray(args.scanArgv) ? args.scanArgv : undefined }, assets })
      let vulnAdded = 0
      for (const v of vulns) { try { store.addVuln(id, v); vulnAdded += 1 } catch { /* 单条失败不挡整批 */ } }
      return JSON.stringify(Object.assign({ ok: true, imported, vulns_written: vulnAdded, stats: { assets: store.assetStats ? store.assetStats(id) : undefined } }, summary), null, 2)
  }

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_ingest',
    description: '把扫描器输出文件批量转成资产/漏洞，默认 dry-run 只报计数。支持 nuclei -jsonl、httpx -json、nmap -oX、ffuf -of json（ffuf 只回路径不写库）。commit:true 才落库，走 importBundle 的幂等 upsert。一次调用替代成百次 redteam_asset_add。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id；省略则用当前会话绑定的靶标' },
      file: { type: 'string', required: true, description: '扫描输出文件路径' },
      kind: { type: 'string', enum: ['nuclei', 'httpx', 'nmap', 'ffuf'], description: '省略则按扩展名/首行猜' },
      commit: { type: 'boolean', description: '默认 false：只统计不写库' },
      max: { type: 'number', description: '最多处理多少条，默认 5000，上限 20000' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: executeIngest,
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_scan_run',
    description: '对指定单个目标执行 Nmap 服务检测或 ProjectDiscovery httpx Web 发现；保存原始输出/命令/时间与哈希，复用 redteam_ingest 自动回填资产及扫描记录。失败不导入；默认 commit:true。不尝试漏洞利用。',
    parameters: {
      engagement: { type: 'string', description: '工作区 ID；省略则用当前会话绑定的项目' },
      kind: { type: 'string', required: true, enum: ['nmap', 'httpx'], description: 'Nmap XML 或 httpx JSONL' },
      target: { type: 'string', required: true, description: '明确授权的单个 IP、域名或 HTTP(S) URL' },
      ports: { type: 'string', description: '仅 Nmap 使用：例如 80,443 或 8000-8100' },
      commit: { type: 'boolean', description: '默认 true：导入资产及端口；false 仅预览并保存原始输出' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (!store.listEngagements().some((item) => item.id === id)) throw new Error('engagement not found: ' + id)
      const result = await executeScanAndIngest({
        kind: args.kind, target: args.target, ports: args.ports,
        outputDir: join(store.dirOf(id), 'scan-output'),
        commit: args.commit !== false,
      }, {
        root: store.root,
        ingest: async ({ file, kind, commit, argv }) => JSON.parse(await executeIngest({
          engagement: id, file, kind, commit, scanArgv: [kind, ...argv],
        }, exec)),
      })
      return JSON.stringify({
        ok: result.ok, status: result.status, engagement: id,
        kind: result.kind, target: result.target,
        command: result.argv ? [result.kind, ...result.argv] : null,
        output_file: result.outputFile || null, manifest_file: result.manifestFile || null,
        sha256: result.sha256 || null, bytes: result.bytes || 0,
        stderr: result.stderr || undefined, error: result.error || undefined,
        ingested: !!result.ingested,
        ingestion: result.ingest ? {
          ok: result.ingest.ok, dry_run: result.ingest.dry_run,
          assets: result.ingest.assets, ports: result.ingest.ports, vulns: result.ingest.vulns,
          imported: result.ingest.imported, skipped: result.ingest.skipped, error: result.ingest.error,
        } : null,
        next: result.status === 'imported'
          ? '已落库，使用 redteam_asset_query 和 redteam_asset_stats 查看已发现资产；扫描完成不代表完整安全测试。'
          : result.status === 'previewed'
            ? '预览完成；可通过 redteam_ingest commit:true 使用此文件手动导入。'
            : result.status === 'no-findings'
              ? '命令已执行，但输出中未解析出资产或漏洞；保留原始文件，继续核对扫描结果。'
              : '未完成自动导入；查看原始输出及错误原因，不要将失败当作已验证结果。',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_add',
    description: '把一个资产及其端口/服务/指纹写入资产库（幂等 upsert）。每条发现必须标注 provenance：被动收集填 passive，主动探测填 active，并填写 tool（数据源或工具名）。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id；省略则用当前会话绑定的靶标' },
      ip: { type: 'string', required: true, description: '资产 IP（IPv4）' },
      state: { type: 'string', description: 'live | dead | unknown，默认 unknown' },
      primary_name: { type: 'string', description: '主域名/主机名' },
      provenance: { type: 'string', required: true, enum: ['passive', 'active'], description: '本条发现的来源：被动或主动' },
      tool: { type: 'string', description: '数据源或工具名，例如 crt.sh / nmap / nuclei / curl' },
      discovered_at: { type: 'string', description: '【可选】这条资产的发现时间（ISO，如 2026-09-17T09:30:00Z）。不填则按"第一次入库的时刻"自动记录；数据源给出历史首次出现时间时传进来更准。**重复采集不会覆盖它**。' },
      first_seen: { type: 'string', description: '【可选】数据源/工具报告的首次出现时间（与发现时间分开记）' },
      names: {
        type: 'array',
        description: '该资产关联的域名/证书名',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            kind: { type: 'string', description: 'domain | hostname | cert_cn，默认 domain' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
          },
        },
      },
      ports: {
        type: 'array',
        description: '开放端口及其服务/指纹',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            port: { type: 'number', required: true },
            proto: { type: 'string', description: 'tcp（默认）| udp' },
            service: { type: 'string', description: '服务名，例如 http / mysql' },
            product: { type: 'string', description: '产品名，例如 nginx' },
            version: { type: 'string', description: '版本，例如 1.24.0' },
            banner: { type: 'string', description: '原始 banner 片段' },
            url: { type: 'string', description: 'Web 服务可直接访问的完整 URL，例如 https://oa.example.com:8443/portal' },
            title: { type: 'string', description: 'Web 页面标题（HTTP 探测获取），例如「致远OA 登录」' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
            tool: { type: 'string' },
            fingerprints: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  category: { type: 'string', description: 'Web服务器 | 中间件 | 框架 | CMS | 数据库 | VPN网关 …' },
                  vendor: { type: 'string' },
                  product: { type: 'string' },
                  version: { type: 'string' },
                  evidence: { type: 'string', description: '判定依据，例如响应头 / 路径 / banner' },
                  confidence: { type: 'number', description: '0–1' },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = {
        ip: args.ip, state: args.state, primary_name: args.primary_name,
        provenance: args.provenance, tool: args.tool,
        names: args.names, ports: args.ports,
        /* 发现时间：不传则由服务端按"第一次入库的时刻"自动记录；
           数据源能给历史时间（FOFA 的 first_seen 等）就传进来，报告时间线更准 */
        discovered_at: args.discovered_at,
        first_seen: args.first_seen,
      }
      const result = store.importBundle(id, { scan: { tool: args.tool, argv: ['redteam_asset_add'] }, assets: [asset] })
      const written = store.listAssets(id, { ip: args.ip, limit: 1 }).items[0]
      return JSON.stringify({
        ok: true, engagement: id, counts: result.counts,
        asset: written ? compactAsset(written) : null,
        discovered_at: written ? written.discovered_at : null,
        hint: '本条资产的发现时间已记为 ' + (written && written.discovered_at ? written.discovered_at : '(未知)')
          + '；重复采集只刷新 last_seen，不会改动发现时间。',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_link',
    description: '在资产库中写入一条关系边（图谱与后续横向分析共用）。relation 例如 resolves / exposes / contains / trusts / shares_cert。',
    parameters: {
      engagement: { type: 'string' },
      src_kind: { type: 'string', required: true, description: 'segment | asset | domain | port …' },
      src_id: { type: 'string', required: true },
      dst_kind: { type: 'string', required: true },
      dst_id: { type: 'string', required: true },
      relation: { type: 'string', required: true },
      confidence: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.importBundle(id, {
        edges: [{
          src_kind: args.src_kind, src_id: args.src_id,
          dst_kind: args.dst_kind, dst_id: args.dst_id,
          relation: args.relation, confidence: args.confidence,
        }],
      })
      return JSON.stringify({ ok: true, edges: result.counts.edges }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_query',
    description: '精确检索资产库：按 IP、C 段、开放端口、测试状态、服务、指纹、来源、内外网维度及关键词过滤；返回紧凑记录与真实分页信息。按 ID 取全部详情请用 redteam_asset_get。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: 'C 段，例如 203.0.113.0/24' },
      ip: { type: 'string', description: '精确匹配单个资产 IP' },
      port: { type: 'number', description: '仅匹配状态为 open 的端口' },
      service: { type: 'string', description: '服务/产品名关键词，例如 nginx' },
      fingerprint: { type: 'string', description: '指纹关键词，例如 Tomcat / Spring' },
      provenance: { type: 'string', enum: ['passive', 'active'], description: '只看被动或主动来源' },
      q: { type: 'string', description: '全文检索词（空格分隔多词为 AND）' },
      state: { type: 'string', enum: ['live', 'dead', 'unknown'] },
      test_status: { type: 'string', enum: ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'], description: '精确过滤测试状态；默认返回全部状态' },
      scope: { type: 'string', enum: ['internal', 'external'], description: '内外网维度：internal=内网/私网地址，external=互联网可达' },
      sort: { type: 'string', enum: ['priority', 'todo', 'ports', 'ip', 'discovered'], description: 'priority=优先级（默认）；todo=待测优先；ports=开放端口数量；ip=IP 顺序；discovered=最近发现优先' },
      limit: { type: 'number', description: '返回条数上限，默认 50，最大 200' },
      offset: { type: 'number', description: '从第几条开始（0 起），用于分批查看完整资产库' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const { limit, offset } = queryPage({ limit: args.limit ?? 50, offset: args.offset ?? 0 }, 200)
      const result = store.listAssets(id, {
        cidr: args.cidr, ip: args.ip, port: args.port, service: args.service,
        fingerprint: args.fingerprint, provenance: args.provenance,
        q: args.q, state: args.state, test_status: args.test_status,
        scope: args.scope, sort: args.sort, limit, offset,
      })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total,
        ...pageMetadata(result.total, result.items.length, { limit, offset }),
        items: result.items.map(compactAsset),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_get',
    description: '取单个资产的完整详情：全部端口与服务、指纹、采集溯源时间线、关系边。用于深入分析某个目标。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: '资产 id（来自 redteam_asset_query 结果）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = store.getAsset(id, args.id)
      if (asset === undefined) return JSON.stringify({ ok: false, error: 'asset not found' })
      return JSON.stringify({ ok: true, asset }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_skill_search',
    description: '【离线只读】搜索当前 purge 随包技能与已按需安装的 AboutSecurity 技能；返回稳定 key，可随后用 redteam_skill_read 读取。未安装 AboutSecurity 时仍可检索本包技能。',
    parameters: {
      query: { type: 'string', description: '技能名称、主题或关键词（空值列出技能）' },
      limit: { type: 'number', description: '默认 10 条，最多 50 条' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      return JSON.stringify({ ok: true, ...searchLocalSkills(args.query, { limit: args.limit }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_skill_read',
    description: '【离线只读】根据 redteam_skill_search 返回的 key 读取完整技能正文；只读插件内建和已安装的 AboutSecurity 技能文件，不执行其中的命令。',
    parameters: {
      key: { type: 'string', required: true, description: '搜索结果的稳定 key，例如 aboutsecurity:recon/passive-recon' },
      max_chars: { type: 'number', description: '最多返回正文字符数，默认 16000' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      return JSON.stringify({ ok: true, ...readLocalSkill(args.key, { maxChars: args.max_chars }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_cve_match',
    description: '【离线只读】把已有 SQLite 资产指纹（asset_id）或手动输入的产品/banner/CVE 与随包公开知识索引关联；返回候选 CVE、受影响版本、命中理由和原始来源。不会联网、执行 PoC 或把候选写成已确认漏洞。',
    parameters: {
      engagement: { type: 'string', description: 'asset_id 模式时使用；省略则继承当前会话绑定靶标' },
      asset_id: { type: 'number', description: 'redteam_asset_query 返回的资产 id；提供时读取已有 SQLite 资产/端口/指纹' },
      cve: { type: 'string', description: '精确 CVE，例如 CVE-2021-44228' },
      product: { type: 'string', description: '产品/组件名，例如 Grafana' },
      banner: { type: 'string', description: '服务指纹或响应头' },
      fingerprint: { type: 'string', description: '补充指纹描述' },
      keyword: { type: 'string', description: '补充检索关键词' },
      port: { type: 'number', description: '已观察到的端口；仅作为加分信号，不能单独匹配漏洞' },
      limit: { type: 'number', description: '最多返回多少候选，默认 10、最多 30' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      let asset
      let engagement
      if (args.asset_id !== undefined) {
        engagement = resolveEngagement(store, exec, args.engagement)
        asset = store.getAsset(engagement, args.asset_id)
        if (!asset) throw new Error('asset not found: ' + args.asset_id)
      }
      const candidates = matchCveCandidates({ ...args, asset })
      return JSON.stringify({
        ok: true, engagement: engagement ?? null, asset_id: args.asset_id ?? null,
        catalog_entries: loadCveCatalog().length,
        ...candidates,
        note: '这些是离线指纹匹配的候选线索；版本尚未独立校验，verified=false。请用已有 redteam_vuln_add / evidence 工具另行记录实测结果。',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_data_quality',
    description: '【只读】对本靶标资产库做元数据质量检查：统计候选/已确认漏洞缺证据、HTTP 证据为空、资产/漏洞关联缺失的数量。不会读取或返回凭据内容，不会确认漏洞、不修改资产状态、不迁移数据库。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id（省略时继承当前/父会话绑定）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, quality: store.dataQuality(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_stats',
    description: '资产测绘概览：C 段数、资产数（存活）、开放端口、服务、指纹、被动/主动溯源条数，以及各 C 段的明细。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, stats: store.stats(id), segments: store.listSegments(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_graph',
    description: '导出资产图谱（C 段 → 资产 → 开放端口，含域名解析边），用于拓扑推理与横向移动路径规划。节点数超过上限时按 C 段缩小范围。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: '只取某个 C 段的子图' },
      maxNodes: { type: 'number', description: '节点上限，默认 300' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 300, 1000)
      const graph = store.graph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '图谱节点过多（' + graph.nodes.length + ' > ' + maxNodes + '），请指定 cidr 缩小范围',
          segments: store.listSegments(id).map((s) => ({ cidr: s.cidr, assets: s.assets })),
        }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, nodes: graph.nodes, edges: graph.edges }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt',
    description: '取出某个红队角色当前生效的系统提示词，只供查看。派活时不要把全文抄进任务；在 subagent 的 prompt 第一行写 redteamRole: <code>，角色稿会进入子会话系统提示词。',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', required: true, /* 角色白名单**从 ROLE_ORDER 派生**：写死 4 个值曾漏掉 assess，
          而预设明确要求主会话用本工具取资产梳理角色的提示词 —— 结果 enum 直接拒绝，
          资产梳理子智能体永远拿不到角色约束。派生后新增角色不会再漏。 */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const found = store.listPrompts(id).find((p) => p.role === args.role)
      if (found === undefined) return JSON.stringify({ ok: false, error: 'unknown role' })
      return JSON.stringify({
        ok: true, role: found.role, title: found.title,
        updated_at: found.updated_at, prompt: found.content,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_roles',
    description: '列出红队角色及其职责标题（信息收集 / 漏洞检测 / 漏洞利用 / 内网渗透）。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return JSON.stringify({
        ok: true,
        roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({ role, title })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_test',
    description: '记录对某个资产的测试情况：本次做了什么测试（`test`，追加式）、还剩什么攻击面（`surface`，覆盖式）、当前测试状态、是否被 WAF 封禁。**每个资产开始测之前先调一次（status=testing），测完/放弃再调一次**——资产测绘页面据此显示「未测试 / 测试中 / 已测试 / 被封禁 / 已放弃 / 无攻击面」。排除结论、登录失败原因、重测理由都写在 `test` 里。',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number', description: '资产 id（与 ip 二选一，优先 asset_id）' },
      ip: { type: 'string', description: '资产 IP' },
      status: { type: 'string', enum: ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'], description: '测试状态：未测试/测试中/已测试/被封禁/已放弃/无攻击面' },
      test: { type: 'string', description: '本次做了什么测试（**追加**到测试记录，例如「nmap 全端口 + nuclei cve 模板 + 接口越权」）。排除结论、登录失败原因、重测理由都写这里。' },
      notes: { type: 'string', description: 'test 的兼容别名（老提示词里的写法），效果与 test 相同，会一并追加到测试记录。' },
      surface: { type: 'string', description: '还剩什么攻击面可测（覆盖式，例如「SMB 445 未测；Web /api 未做越权」）' },
      blocked: { type: 'boolean', description: '本次是否被 WAF/防护封禁（true 时封禁计数 +1）' },
      updated_by: { type: 'string', description: '记录角色，例如 recon / vuln-scan' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateAssetTest(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== 漏洞检测 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_add',
    description: '记录一条漏洞发现（漏洞检测角色）。带 cve 时按 (asset_id, cve, target) 幂等更新。severity：critical|high|medium|low|info；status：candidate（待验证）|confirmed（已验证）|false-positive|exploited|fixed。必须附证据（请求/响应片段、复现命令、证据文件路径）。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      asset_id: { type: 'number', description: '资产 id（来自 redteam_asset_query）' },
      cve: { type: 'string', description: 'CVE / CNVD 编号（无编号可省略）' },
      title: { type: 'string', required: true, description: '漏洞标题' },
      severity: { type: 'string', required: true, enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      target: { type: 'string', description: '受影响的目标，如 https://host:443/path 或 ip:port' },
      source: { type: 'string', description: '发现方式：nuclei / sqlmap / curl / manual …' },
      confidence: { type: 'number', description: '0–1' },
      evidence: { type: 'string', description: '证据：请求/响应摘要、命令、证据文件路径' },
      found_by_agent: { type: 'string', description: '发现角色，默认 vuln-scan' },
      gained: { type: 'string', description: '【重要】通过这个漏洞拿到了什么权限/成果，写得分口径的短标签，多项用顿号或逗号分隔，例如「服务器权限、内网隧道」「后台管理员账号」「数据库权限」' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addVuln(id, { ...args, engagement: undefined, agent: agentOf(args), found_by_agent: args.found_by_agent || args.agent || 'vuln-scan' })
      return JSON.stringify({ ok: true, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_query',
    description: '检索漏洞库：批量查询默认精简摘要，避免大量原始 HTTP 数据占满模型上下文；传 id 精确定位 vuln #ID 时默认返回完整证据，也可用 detail=full 显式获取。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', description: '漏洞记录 ID，直接取任务卡 vuln #ID；可与状态等筛选条件组合' },
      detail: { type: 'string', enum: ['summary', 'full'], description: 'summary=紧凑摘要与证据条数；full=含 HTTP 原始证据；未指定时列表用 summary，指定 id 用 full' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      cve: { type: 'string' },
      asset_id: { type: 'number' },
      cidr: { type: 'string' },
      q: { type: 'string', description: '标题/CVE/目标/证据关键词' },
      limit: { type: 'number', description: '默认 50，最大 200' },
      offset: { type: 'number', description: '从第几条开始（0 起），用于分批查看完整漏洞库' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const { limit, offset } = queryPage({ limit: args.limit ?? 50, offset: args.offset ?? 0 }, 200)
      const detail = args.detail || (args.id == null ? 'summary' : 'full')
      const result = store.listVulns(id, {
        ...args, engagement: undefined, withHttpEvidence: detail === 'full', limit, offset,
      })
      return JSON.stringify({ ok: true, engagement: id, detail, total: result.total,
        ...pageMetadata(result.total, result.items.length, { limit, offset }),
        items: detail === 'full' ? result.items : result.items.map(compactVuln),
        stats: store.vulnStats(id) }, null, 2)
    },
  })))

  /* 候选漏洞的分类领取工具：复用 next_action 使用的全量只读证据分类规则。 */
  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_candidate_queue',
    description: '【只读】按证据准备情况分页领取候选漏洞：ready=已有证据待核对，needs_evidence=缺可复核证据，needs_scope=缺资产关联，deferred=目标阻塞或失活。返回完整分类计数与精简记录；下一步按 vuln_id 调 redteam_vuln_query，不自动确认或派发扫描。',
    parameters: {
      engagement: { type: 'string' },
      category: { type: 'string', enum: ['ready', 'needs_evidence', 'needs_scope', 'deferred'], description: '默认 ready；只影响返回的候选列表，不影响全量分类计数。' },
      limit: { type: 'number', description: '每页最多 50，默认 15。' },
      offset: { type: 'number', description: '0 起的分页偏移量。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const { limit, offset } = queryPage({ limit: args.limit ?? 15, offset: args.offset ?? 0 }, 50)
      const planning = store.planningSnapshot(id)
      const queue = reviewCandidateQueue(planning.vulns, planning.assets)
      const page = candidateQueuePage(queue, args.category || 'ready', { limit, offset })
      return JSON.stringify({
        ok: true, engagement: id, ...page,
        hint: '按 vuln_id 调 redteam_vuln_query(id=...) 核对原始证据；分类仅表示库中记录现状，不代表已验证或授权。',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_update',
    description: '更新漏洞状态/严重级/证据（例如验证后置为 confirmed、利用成功后置为 exploited、误报置为 false-positive）。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: '漏洞 id' },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      evidence: { type: 'string' },
      confidence: { type: 'number' },
      gained: { type: 'string', description: '通过这个漏洞拿到了什么权限/成果（得分口径短标签，多项用顿号分隔）' },
      title: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateVuln(id, args.id, { status: args.status, severity: args.severity, evidence: args.evidence, confidence: args.confidence, gained: args.gained, title: args.title })
      return JSON.stringify({ ok: result.updated, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  /* ================================================================== 漏洞利用 / 内网渗透 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_add',
    description: '记录一条凭据（漏洞利用/内网渗透角色）。**必须把口令/密钥明文写进 secret_value**——面板要直接显示明文供随时复用；同时用 secret_ref 指向 runs/ 下的证据文件。注意：本库只在本机，禁止把库文件或导出内容提交到任何仓库。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      host: { type: 'string', required: true, description: '所属主机（IP 或域名）' },
      username: { type: 'string' },
      secret_type: { type: 'string', description: 'password | hash | key | token | connection-string，默认 password' },
      secret_value: { type: 'string', description: '【必填】凭据明文：口令 / Hash / 私钥 / Token / 连接串' },
      secret_ref: { type: 'string', description: '证据引用路径，例如 runs/cred-vnc-10.0.0.5.txt' },
      privilege: { type: 'string', description: '该凭据的权限级别，如 admin / user / db-read' },
      asset_id: { type: 'number' },
      source: { type: 'string', description: '来源：exploit / dump / config-leak …' },
      tool: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addCredential(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_add',
    description: '登记一张证据截图：把图片拷进靶标目录并关联到得分点/命中（面板展开得分点即可看图，报告里也会嵌入）。批量得分点（如终端权限）每个得分点最多展示 3 张代表图，不必逐台截图。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      path: { type: 'string', description: '图片在本机的路径（相对靶标目录或绝对路径）；与 data_base64 二选一' },
      data_base64: { type: 'string', description: '图片内容（base64，可带 data: 前缀）；截图工具没落盘时用这个' },
      label: { type: 'string', description: '图片说明，例如「域控 WEB-SHDC1 atexec 回显 nt authority\\system」' },
      kind: { type: 'string', description: 'screenshot（现场截图，默认）| card（由记录生成的证据摘录卡，报告里会标注）' },
      point_code: { type: 'string', description: '关联的得分点 code，如 terminal-access / central-system' },
      hit_id: { type: 'number', description: '关联到具体某条得分命中（score_hit id）；给了它这张图就只挂在那一条上' },
      asset_id: { type: 'number' },
      target: { type: 'string', description: '这张图对应的目标（IP / URL）' },
      note: { type: 'string', description: '补充说明：这张图证明了什么' },
      source_ref: { type: 'string', description: '原始来源：截图的落盘路径或 runs/ 下的证据文件' },
      captured_at: { type: 'string', description: '截图时间（ISO），缺省用当前时间' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addShot(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_list',
    description: '列出已登记的证据截图（含所属得分点、目标、类型、落盘文件）。',
    parameters: {
      engagement: { type: 'string' },
      point_code: { type: 'string' },
      hit_id: { type: 'number' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, ...store.listShots(id, {
        point_code: args.point_code, hit_id: args.hit_id, asset_id: args.asset_id,
      }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_delete',
    description: '删除一张证据截图（连同磁盘文件）。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'shot id（redteam_shot_list 里返回的 id）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: eng, ...store.deleteShot(eng, args.id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_list',
    description: '列出已收集的凭据（含明文 secret_value），用于凭据复用与横向移动。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
      username: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listCredentials(id, { host: args.host, username: args.username }) }, null, 2)
    },
  })))

  /* 凭据可用性探测：把"知道口令"变成"能不能用"的确定结论。
     1698 与 1045 在报告里含义完全不同，靠人工 curl 每次都要重推一遍。 */
  const parseCredRow = (row) => {
  const text = String((row && row.host) || '')
  const m = text.match(/^([0-9A-Za-z._-]+)(?::(\d+))?/)
  const dsn = String((row && row.secret_value) || '')
  const pw = (dsn.match(/password=([^\s;]+)/i) || [])[1] || ''
  const db = (dsn.match(/database=([^\s;]+)/i) || [])[1] || ''
  const kind = /mysql|mariadb|3306/i.test(dsn + ' ' + text) ? 'mysql'
    : /redis|6379/i.test(dsn + ' ' + text) ? 'redis' : 'tcp'
  return { host: m ? m[1] : '', port: m && m[2] ? Number(m[2]) : (kind === 'mysql' ? 3306 : kind === 'redis' ? 6379 : 0), password: pw, database: db, kind }
  }

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_check',
    description: '【拿到凭据后的第一步】解析 connection-string、TCP 探测、按协议（mysql/redis）做一次真实认证，并把 errno 翻译成下一步。1698=用户存在但只允许 @localhost（凭据真实，需转发或找能执行 SQL 的 Web 入口）；1045=口令错/用户不存在；1130=来源主机不被允许。不要靠猜，先跑这个。',
    parameters: {
      engagement: { type: 'string' },
      credential_id: { type: 'number', description: '库里的凭据 id（redteam_credential_list 拿）' },
      kind: { type: 'string', enum: ['mysql', 'redis', 'ssh', 'tcp'], description: '默认按 connection-string 猜' },
      host: { type: 'string' },
      port: { type: 'number' },
      username: { type: 'string' },
      password: { type: 'string' },
      database: { type: 'string' },
      timeout: { type: 'number', description: 'TCP 超时毫秒，默认 4000' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      let row = null
      if (args.credential_id !== undefined && args.credential_id !== null) {
        const all = store.listCredentials(id, {})
        row = all.find((r) => Number(r.id) === Number(args.credential_id)) || null
        if (row === null) throw new Error('没找到该凭据 id：' + args.credential_id)
      }
      const parsed = parseCredRow(row)
      const host = String(args.host || parsed.host || '').trim()
      const port = Number(args.port || parsed.port || 0)
      const username = String(args.username || (row && row.username) || '')
      const password = String(args.password || parsed.password || '')
      const database = String(args.database || parsed.database || '')
      const kind = String(args.kind || parsed.kind || 'tcp')
      if (host === '' || port <= 0) throw new Error('host/port 必填，或传 credential_id')
      const tcp = await probeTcp(host, port, Math.min(Number(args.timeout) || 4000, 15000))
      const out = { ok: true, target: host + ':' + port, kind, tcp }
      if (!tcp.reachable) {
        out.verdict = 'unreachable'
        out.next_action = '端口不通：可能只监听本地、被防火墙挡、或目标不在线。先换出口或从目标本地转发再试'
        return JSON.stringify(out, null, 2)
      }
      if (kind === 'mysql' || kind === 'redis') {
        const argv = kind === 'mysql' ? [host, port, username, password, database] : [host, port, password]
        const auth = await runPython(PY_SOURCES[kind], argv, 25000)
        out.auth = auth
        if (auth && auth.ok === true) {
          out.verdict = 'usable'
          out.next_action = '远程可用：立刻升级为权限（读库/写文件/建账号），记 redteam_access_add 与 score_hit'
        } else if (auth && auth.exec_error) {
          out.verdict = 'unknown'
          out.next_action = '子进程被拦或 python 缺失：自己按 manual_command 跑一次'
          out.manual_command = kind === 'mysql'
            ? 'python -c "import pymysql;c=pymysql.connect(host=\'' + host + '\',port=' + port + ',user=\'' + username + '\',password=\'' + password.replace(/'/g, "\\'") + '\',connect_timeout=6);print(c.cursor().execute(\'select current_user()\'))"'
            : 'python -c "import redis;r=redis.Redis(host=\'' + host + '\',port=' + port + ',password=\'' + password.replace(/'/g, "\\'") + '\');print(r.ping())"'
        } else {
          out.verdict = auth && auth.errno === 1698 ? 'localhost-only' : 'invalid'
          out.next_action = explainDbError(kind, auth && auth.errno, auth && auth.error)
        }
      } else {
        out.verdict = 'tcp-only'
        out.next_action = kind === 'ssh'
          ? 'SSH 可达：试 ssh -o BatchMode=yes -i KEY user@host，或 sshpass -p 口令'
          : '仅确认端口开放；认证需要对应客户端'
      }
      return JSON.stringify(out, null, 2)
    },
  })))
  /* 得分建议：把 confirmed 漏洞的 gained 映射到 25 项得分点，并说清"还差什么"。
     打一场下来漏洞一堆但只有 1-2 个得分，原因通常是拿到的都是"读"而不是"权限"。 */
  const SCORE_CODES = {
    'domain-control': 50, 'terminal-access': 10, 'server-host': 50, 'db-credential': 50,
    'web-app': 100, 'central-system': 500, 'bigdata-system': 1000, 'netdev': 200,
    'iiot': 200, 'cloud-platform': 500, 'iot-platform': 200, 'secdev': 200,
    'file-storage': 50, 'ai-agent': 100, 'model-compute': 500, 'model-data': 500,
    'computepower-admin': 500, 'computepower-cards': 10, 'boundary-logical': 1000,
    'boundary-strong': 10000, 'boundary-physical': 30000, 'boundary-supply': 1000,
    'netdev-redirect': 200, 'netdev-implant': 1000, 'iot-corenet': 5000,
  }
  /* 只看 gained 中明确声明的成果，不从漏洞标题、组件名或扫描回显猜出权限。 */
  const SCORE_RULES = [
    { code: 'server-host', re: /服务器(?:主机)?权限|webshell|getshell|root 权限|管理员 shell|命令执行成功|system 权限/i },
    { code: 'db-credential', re: /数据库(?:凭据|权限|管理权限|登录成功)|能连库|远程连库成功|mysql 权限|postgres 权限|redis 管理权限/i },
    { code: 'web-app', re: /后台(?:管理权限|账号|登录成功)|管理面登录成功|web 应用权限|账号权限|会话权限/i },
    { code: 'file-storage', re: /对象存储权限|minio 权限|s3 访问权限|oss 权限|文件存储权限/i },
    { code: 'netdev', re: /(?:防火墙|路由器|交换机|vpn|fortigate|网络设备)(?:管理权限|登录成功)|网络设备权限/i },
    { code: 'central-system', re: /集权系统权限|运维平台管理权限|堡垒机管理权限|域控管理权限|统一认证管理权限/i },
    { code: 'terminal-access', re: /终端权限|pc 权限|设备管理权限/i },
    { code: 'domain-control', re: /域名控制权限|dns 管理权限|注册商权限/i },
    { code: 'cloud-platform', re: /云平台管理权限|云平台访问权限|云控制台权限/i },
  ]
  const SCORE_MISSING = {
    'server-host': '需要能执行命令的证据：webshell 可访问 / 回连收到 / 命令回显，并 redteam_webshell_add 或 access_add 落库',
    'db-credential': '必须实际连库并查到数据（1698/localhost 限定不算）；远程连不上就先用 credential_check 判型',
    'web-app': '必须能登录且有后台功能可操作；普通账号也算（分值低），别因为不是 admin 就不记',
    'file-storage': '需要可写或可读全量（匿名列举只算 exposed，要能把对象下载下来并注明数据量）',
    'netdev': '需要设备登录后的管理面证据（配置页截图/命令回显）',
    'central-system': '需要集权系统的管理权限证据（能改配置或能下发任务）',
  }

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_suggest',
    description: '只读对账：区分已确认漏洞、实际成果、证据、关联命中和有效计分。只匹配 gained 明确声明的成果，不凭漏洞标题/组件猜分；不自动写入 score_hit。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '最多返回多少条细节，默认 8，最多 20；总数始终完整返回。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const vulns = store.listVulns(id, { limit: 1000 }).items
      const board = store.listScorePoints(id)
      const review = reviewScoring(vulns, board, SCORE_RULES, SCORE_CODES, SCORE_MISSING)
      const limit = Math.max(1, Math.min(20, Math.floor(Number(args.limit) || 8)))
      return JSON.stringify({
        ok: true, engagement: id, confirmed: review.confirmed,
        can_score: review.review_ready, already_counted: review.counted,
        needs_evidence: review.needs_evidence, needs_outcome: review.needs_outcome,
        recorded_not_counted: review.recorded_not_counted,
        unavailable_rule: review.unavailable_rule,
        suggestions: review.suggestions.slice(0, limit),
        followup: review.followup.slice(0, limit).map((row) => ({
          vuln_id: row.vuln_id, title: row.title, status: row.status,
          linked_hits: row.linked_hits, evidence_present: row.evidence_present,
          note: row.note,
        })),
        returned: { suggestions: Math.min(review.suggestions.length, limit), followup: Math.min(review.followup.length, limit) },
        totals: { suggestions: review.suggestions.length, followup: review.followup.length },
        summary: 'can_score 表示待复核，不是已得分。按 vuln_id 核对关联命中；先补证据、确认档位，再由人或经过授权的流程记分。',
      }, null, 2)
    },
  })))
  /* 执行后核对真实进展：复用任务卡给的基线，不需要额外数据库或轮询。 */
  /* 离线审阅工具：不探测任何目标，也不写入演练库。 */
  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_scope_review',
    description: '【离线只读】将资产清单与用户明确填写的允许范围核对，支持 IPv4/IPv6、CIDR、域名与 *.子域名。name-only 需要单独复核 IP 归属；无网络连接，不证明用户拥有授权。',
    parameters: {
      engagement: { type: 'string' },
      allowed: { type: 'string', required: true, description: '明确允许的地址或域名，逗号/换行分隔，例如 192.0.2.0/24,2001:db8::/32,example.test,*.example.test' },
      limit: { type: 'number', description: '最多展示多少条资产的匹配情况，默认 25，最多 100' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const page = store.listAssets(id, { limit: 2000 })
      const audit = reviewScope(page.items, args.allowed, args.limit)
      return JSON.stringify({
        ok: true, engagement: id, total_assets: page.total,
        sampled: page.items.length, partial: page.total > page.items.length,
        ...audit,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_delivery_audit',
    description: '【离线只读】检查已计入分数的记录是否填写目标、证据结果和来源关联（vuln_id/step_id）；只报告缺口，不增加分数，不把文本齐全等同于漏洞真实可复现。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '最多展示多少条缺口，默认 25，最多 100' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const board = store.listScorePoints(id)
      const audit = reviewDelivery(board, args.limit)
      return JSON.stringify({
        ok: true, engagement: id, achieved_points: Number(board.summary && board.summary.achievedPoints) || 0,
        ...audit,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_progress_check',
    description: '只读进展对账：把上一张 focus.before 作为 JSON 字符串传入，比较有效分数、资产、漏洞、测试完成情况和新增 HTTP 证据。不会猜测成功或自动写分。',
    parameters: {
      engagement: { type: 'string' },
      before: { type: 'string', required: true, description: '原样传入上一张 focus.before 的 JSON，例如 {"score_points":0,"counted_hits":0,"recorded_hits":0,"assets":2,"confirmed":1}' },
      task_key: { type: 'string', description: '可选：上一张 focus.task_key，仅用于在输出中识别任务' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      let before
      try {
        before = JSON.parse(args.before)
      } catch {
        throw new Error('before must be the exact focus.before JSON from redteam_next_action')
      }
      const score = store.listScorePoints(id).summary
      const stats = store.stats(id)
      const vulns = store.vulnStats(id).byStatus
      const after = {
        engagement_id: id,
        score_points: Number(score.achievedPoints) || 0,
        counted_hits: Number(score.countedHits) || 0,
        recorded_hits: Number(score.hitCount) || 0,
        assets: Number(stats.assets) || 0,
        confirmed: (Number(vulns.confirmed) || 0) + (Number(vulns.exploited) || 0),
        findings: Number(stats.vulns) || 0,
        reviewed_assets: Number(stats.reviewedAssets) || 0,
        evidence_items: Number(stats.httpEvidence) || 0,
      }
      return JSON.stringify({
        ok: true, engagement: id, task_key: args.task_key || null,
        ...compareProgress(before, after),
      }, null, 2)
    },
  })))

  /* 下一步任务卡的关联信息一次打包：不拉入 HTTP 原始正文，也不泄露凭据。 */
  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_task_context',
    description: '【只读】直接传 redteam_next_action 的 focus.target（asset #ID / vuln #ID）或 focus.task_key；一次获取目标资产状态、关联漏洞的精简记录及 HTTP 证据索引，省去多次查询。原始请求响应按证据 ID 另查，不执行测试、不写分。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: '传 focus.target 如 asset #8 / vuln #12；也接受 focus.task_key 如 漏洞发现:asset #8。其他非 ID 目标不支持。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify(taskContext(store, id, args.target), null, 2)
    },
  })))

  /* 显式记录阻塞原因；下一张任务卡自动读取本演练的阻塞键，不必跨会话手工传回。 */
  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_task_block',
    description: '管理本演练已确认阻塞的 focus.task_key：block 保存原因并持久跳过、unblock 在条件变化后恢复、list 查看阻塞原因。redteam_next_action 自动读取本地记录，且始终只读。不要仅因无得分就标记 blocked。',
    parameters: {
      engagement: { type: 'string' },
      action: { type: 'string', required: true, enum: ['block', 'unblock', 'list'] },
      task_key: { type: 'string', description: 'block/unblock 必填：原样填写 focus.task_key（如 漏洞发现:asset #8）' },
      reason: { type: 'string', description: 'block 必填：明确阻塞原因、缺失条件，最多 1000 字符' },
      limit: { type: 'number', description: 'list 每页条数，默认 30，最多 100' },
      offset: { type: 'number', description: 'list 分页偏移量，默认 0' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.action === 'list') return JSON.stringify({
        ok: true, engagement: id, ...store.listTaskBlocks(id, { limit: args.limit, offset: args.offset }),
      }, null, 2)
      if (args.action === 'block') return JSON.stringify({
        ok: true, engagement: id, ...store.recordTaskBlock(id, args.task_key, args.reason),
      }, null, 2)
      if (args.action === 'unblock') return JSON.stringify({
        ok: true, engagement: id, ...store.clearTaskBlock(id, args.task_key),
      }, null, 2)
      throw new TypeError('action must be block, unblock or list')
    },
  })))

  /* 下一步建议：读家底，按"得分潜力 × 可行性"给动作。指挥角色每轮开工前先跑它，
     避免"打了一堆但不知道该干什么"。 */
  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_next_action',
    description: '只读下一步任务卡：自动排除本演练通过 redteam_task_block 保存的阻塞任务；也可传 previous_task 做结果对账、通过 blocked_task_key(s) 临时跳过。不会写入阻塞状态、执行测试或自动计分。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '最多给几条，默认 3' },
      blocked_task_key: { type: 'string', description: '兼容旧用法：跳过上一张已经确认阻塞的 focus.task_key。' },
      blocked_task_keys: { type: 'string', description: '可选：已确认阻塞的 focus.task_key JSON 字符串数组（最多 100 个）；多个阻塞任务一次排除，不需反复循环。' },
      previous_task: { type: 'string', description: '可选：上一张 focus 的 task_key、before 与执行结论的 JSON 对象，如 {"task_key":"...","before":{...},"outcome":"done|blocked|inconclusive"}。自动对比当前数据库统计，决定换任务、跳过或暂停核查；不运行任务。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const pick = (x) => (Array.isArray(x) ? x : (x && (x.items || x.profiles)) || [])
      const planning = store.planningSnapshot(id)
      const assets = planning.assets
      const vulnsAll = planning.vulns
      const assetCount = planning.assetCount
      const vulnCount = planning.vulnCount
      const creds = pick(store.listCredentials(id, {}))
      const tunnels = pick(store.listTunnels(id, {}))
      const shells = pick(store.listWebshells(id, {}))
      const access = pick(store.listAccess(id, {}))
      let hitCount = 0
      let scoreBoard = { items: [], summary: {} }
      try {
        scoreBoard = store.listScorePoints(id) || scoreBoard
        hitCount = Number(scoreBoard.summary && scoreBoard.summary.countedHits) || 0
      } catch { /* 获取计分面板失败时，下一步建议仍可工作 */ }
      const confirmed = vulnsAll.filter((v) => v.status === 'confirmed' || v.status === 'exploited')
      const statuses = store.vulnStats(id).byStatus
      const confirmedCount = (Number(statuses.confirmed) || 0) + (Number(statuses.exploited) || 0)
      const candidates = vulnsAll.filter((v) => v.status === 'candidate')
      const candidateQueue = reviewCandidateQueue(candidates, assets)
      const live = assets.filter((a) => a.state === 'live')
      const untested = live.filter(isUntestedLiveAsset)
      let previous = null
      let previousKey = ''
      if (args.previous_task !== undefined && args.previous_task !== '') {
        try { previous = JSON.parse(args.previous_task) }
        catch { throw new Error('previous_task must be a JSON object from the previous focus') }
        if (!previous || typeof previous !== 'object' || Array.isArray(previous)
          || typeof previous.task_key !== 'string' || !previous.task_key.trim()
          || !previous.before || previous.before.engagement_id !== String(id)) {
          throw new Error('previous_task requires task_key and a focus.before bound to this engagement')
        }
        previousKey = previous.task_key.trim()
      }
      let blockedKeys = []
      if (args.blocked_task_keys !== undefined && args.blocked_task_keys !== '') {
        try { blockedKeys = JSON.parse(args.blocked_task_keys) }
        catch { throw new Error('blocked_task_keys must be a JSON string array') }
        if (!Array.isArray(blockedKeys) || blockedKeys.length > 100
          || !blockedKeys.every((key) => typeof key === 'string' && key.trim())) {
          throw new Error('blocked_task_keys must contain at most 100 non-empty strings')
        }
        blockedKeys = blockedKeys.map((key) => key.trim())
      }
      if (typeof args.blocked_task_key === 'string' && args.blocked_task_key.trim()) {
        blockedKeys.push(args.blocked_task_key.trim())
      }
      // 显式确认并保存的阻塞项跨会话持续生效；解除时用 redteam_task_block(action=unblock)。
      const persistedBlockedKeys = store.blockedTaskKeys(id)
      blockedKeys = [...new Set([...persistedBlockedKeys, ...blockedKeys])]
      // 下一轮只有明确 blocked / done 的旧任务才可能从候选窗口里排除；
      // 若 done 后对账没有变化，handoff 会进入 needs-review，不派新任务。
      const windowBlocked = [...blockedKeys]
      if (previous && (previous.outcome === 'blocked' || previous.outcome === 'done')) windowBlocked.push(previousKey)
      const skippedWindows = []
      const windowFor = (rows, action, kind) => {
        const window = unblockedTaskWindow(rows, action, kind, windowBlocked)
        skippedWindows.push(...window.skipped)
        return window.items
      }
      const acts = []
      const push = (priority, action, target, why, expected, tool) => acts.push({ priority, action, target, why, expected, tool })

      if (assets.length === 0) {
        push(1, '先整理已有授权范围与资产', '(当前没有资产记录)', '先确认自有或明确授权的目标，不能凭组织名称扩大测试范围', '形成有来源的资产记录与明确范围，不设任意数量门槛', 'redteam_asset_query → redteam_asset_add')
      }
      const unverifiedCred = creds.filter((c) => {
        const status = String(c.privilege || '') + ' ' + String(c.note || '')
        /* 记录过明确的成功/失败结果就不要下一轮继续推荐同一项；未明原因的凭据才需要核对。 */
        return !/(?:已验证|登录成功|连接成功|认证失败|验证失败|不可用|已排除|\bverified\b|\busable\b|\binvalid\b|\brejected\b|auth failed)/i.test(status)
      })
      if (unverifiedCred.length > 0) {
        const c = unverifiedCred[0]
        push(2, '核对已有凭据的验证状态', c.host + ' @' + (c.username || '?'),
          '库里存在尚未明确标记验证结果的凭据；不要反复尝试或把口令存在当成权限',
          '记录可复核的成功/失败结果，成功也要按实际权限核对规则',
          'redteam_credential_list → redteam_score_suggest')
      }
      if (confirmed.length > 0) {
        const review = reviewScoring(confirmed, scoreBoard, SCORE_RULES, SCORE_CODES, SCORE_MISSING)
        const rawHits = Number(scoreBoard.summary && scoreBoard.summary.hitCount) || 0
        if (rawHits > 0 && hitCount === 0) {
          push(0, '查清已记录命中为何没有有效分', '得分面板',
            '已有 ' + rawHits + ' 条 score_hit，但有效计分为 0；先查去重、上限、禁用或自建账号',
            '给出逐条原因，不重复为同一成果刷分',
            'redteam_score_list → redteam_score_suggest')
        }
        if (review.review_ready > 0) {
          push(1, '复核可记分的已有成果', '待复核 ' + review.review_ready + ' 条',
            '已有实际成果描述和证据，但缺少与当前漏洞关联的有效计分记录',
            '核对目标、证据、计分档位与关联 ID，不把待复核说成已得分',
            'redteam_score_suggest → redteam_score_list')
        } else if (review.needs_evidence > 0 || review.needs_outcome > 0) {
          push(1, '核对实际成果与证据', '待核对 ' + (review.needs_evidence + review.needs_outcome) + ' 条',
            '漏洞 confirmed 不是权限成果；先分清实际结果与尚未完成的验证',
            '留下真实结果/缺失项并更新库记录，不虚构得分',
            'redteam_vuln_query → redteam_score_suggest')
        } else if (review.unavailable_rule > 0) {
          push(2, '核对不可用的计分规则', '不可用 ' + review.unavailable_rule + ' 条',
            '成果描述匹配的计分点已禁用、缺失或属于旧口径，不应直接尝试记分',
            '核对真实规则及适用范围，不能靠修改规则制造分数',
            'redteam_score_list → redteam_score_suggest')
        }
      }
      // Filter blocked keys before the 30-item candidate window to avoid starving later records.
      for (const v of windowFor(candidateQueue.ready, '复核有证据的候选漏洞', 'vuln')) {
        push(2, '复核有证据的候选漏洞', 'vuln #' + v.vuln_id,
          '该候选关联存活、未阻塞的资产，并已有初步证据；从高严重度记录优先核对，不从标题推断可利用性',
          '核对授权、证据有效性和复现结果后再决定状态；不直接计分',
          'redteam_task_context(target="vuln #' + v.vuln_id + '")')
      }
      for (const v of windowFor(candidateQueue.needs_evidence, '核对候选证据缺口', 'vuln')) {
        push(3, '核对候选证据缺口', 'vuln #' + v.vuln_id,
          '当前候选关联存活资产但缺少可核对的证据；没有证据时不要重复宣称漏洞成立',
          '补记现有观察结果或明确标记待补证据，不生成未经核实的结论',
          'redteam_task_context(target="vuln #' + v.vuln_id + '")')
      }
      for (const v of windowFor(candidateQueue.needs_scope, '核对候选与资产及授权范围的关联', 'vuln')) {
        push(3, '核对候选与资产及授权范围的关联', 'vuln #' + v.vuln_id,
          '该候选没有能在当前读取样本中匹配到的资产记录；不能直接判定目标允许测试',
          '核对实际资产 ID、授权范围和来源；无法确认就保持候选状态',
          'redteam_task_context(target="vuln #' + v.vuln_id + '") → redteam_scope_review')
      }
      const sessions = sessionReadiness(shells, tunnels)
      if (sessions.shell_status_review) {
        push(2, '复核现有入口状态', '已有 ' + sessions.shells_total + ' 条入口记录',
          '记录中没有状态为 online 的入口；不能按已可用入口继续派活',
          '更新实际连通状态或记录阻塞原因，不对离线入口进行后续操作',
          'redteam_webshell_list → redteam_session_check')
      }
      if (sessions.tunnel_status_review) {
        push(2, '核对现有隧道与目标侧归属', '已有 ' + sessions.tunnels_total + ' 条通道记录',
          '没有同时满足 active 与目标侧关联合法的通道；自建、停用或未知通道不代表跨界可达',
          '核对连接状态、目标侧关联和证据，不把 self-only 算成可用路径或得分',
          'redteam_tunnel_list → redteam_session_check')
      }
      if (sessions.active_target_tunnels > 0 && access.length === 0) {
        push(3, '核对已登记通道的可达范围', '有效通道 ' + sessions.active_target_tunnels + ' 条',
          '已有标记为 active 且关联目标侧的通道，但尚无访问结果；需核对范围和真实证据',
          '记录授权范围内已验证的连接结果，不从通道存在推断访问权限',
          'redteam_session_check → redteam_asset_query')
      }
      // 按稳定资产 ID 逐项给任务，不因总数变化让 blocked_task_key 失效。
      acts.push(...planUntestedAssetTasks(windowFor(untested, '漏洞发现', 'asset')))
      if (assets.length > 0 && live.length < assets.length * 0.5) {
        push(4, '补存活探测', 'assets=' + assets.length + ' live=' + live.length, '大量资产状态未知，后续排序不准', 'state 收敛', 'httpx 批量 + redteam_ingest')
      }
      if (acts.length === 0) {
        push(5, '复核任务记录与报告', '(当前无明确待办)', '没有发现新的可核对任务，不应为了进度制造操作',
          '确认已完成事项和未解决限制', 'redteam_score_list → redteam_report')
      }
      const lim = Math.max(1, Math.min(10, Math.floor(Number(args.limit) || 3)))
      const fullStats = store.stats(id)
      const state = {
        engagement_id: id,
        assets: assetCount, live: live.length, untested: untested.length,
        assets_sampled: assets.length, assets_truncated: false,
        vulns: vulnCount, vulns_sampled: vulnCount, vulns_truncated: false, vulns_relevant: vulnsAll.length,
        confirmed: confirmedCount, candidates: candidates.length,
        candidate_queue: {
          ready: candidateQueue.ready.length,
          needs_evidence: candidateQueue.needs_evidence.length,
          needs_scope: candidateQueue.needs_scope.length,
          deferred: candidateQueue.deferred.length,
          sampled: candidates.length,
          partial: false,
        },
        credentials: creds.length, webshells: shells.length, tunnels: tunnels.length,
        access: access.length, sessions_review: sessions,
        score_hits: hitCount,
        persisted_blocked_tasks: persistedBlockedKeys.length,
        score_points: Number(scoreBoard.summary && scoreBoard.summary.achievedPoints) || 0,
        recorded_hits: Number(scoreBoard.summary && scoreBoard.summary.hitCount) || 0,
        findings: Number(fullStats.vulns) || 0,
        reviewed_assets: Number(fullStats.reviewedAssets) || 0,
        evidence_items: Number(fullStats.httpEvidence) || 0,
      }
      const ordered = acts.sort((x, y) => x.priority - y.priority)
      let handoff = null
      if (previous) {
        const after = {
          engagement_id: String(id),
          score_points: state.score_points,
          counted_hits: state.score_hits,
          recorded_hits: state.recorded_hits,
          assets: state.assets,
          confirmed: state.confirmed,
          findings: state.findings,
          reviewed_assets: state.reviewed_assets,
          evidence_items: state.evidence_items,
        }
        const progress = compareProgress(previous.before, after)
        handoff = {
          task_key: previousKey,
          progress: { status: progress.status, delta: progress.delta, summary: progress.summary },
          ...decideTaskHandoff(progress, previous.outcome),
        }
      }
      // 完成后也不立即重派尚未改变状态的旧目标；hold 不会触发排除。
      if (handoff?.decision === 'skip' || handoff?.decision === 'continue') blockedKeys.push(previousKey)
      const available = filterBlockedActions(ordered, blockedKeys)
      const skipped = [...new Set([
        ...skippedWindows.filter((key) => blockedKeys.includes(key)),
        ...blockedKeys.filter((key) => ordered.some((action) => taskKey(action) === key)),
      ])]
      const focus = handoff?.decision === 'hold'
        ? { status: 'needs-review', task_key: previousKey, instruction: handoff.reason }
        : nextTaskCard(available, state)
      if (skipped.length && focus.status === 'idle') {
        focus.status = 'blocked'
        focus.instruction = '已跳过上一轮阻塞的任务，当前没有其他可信待办。请说明卡点；条件没有变化时不要重新派同一任务。'
      }
      return JSON.stringify({
        ok: true, engagement: id, state,
        skipped_task_key: skipped[0] || null, skipped_task_keys: skipped.slice(0, 100),
        skipped_total: skipped.length,
        handoff, focus, actions: focus.status === 'needs-review' ? [] : available.slice(0, lim),
        note: '下一张卡自动跳过数据库中已确认的阻塞任务。previous_task 与临时 blocked_task_key(s) 不会自动落库；需持久跳过时显式调用 redteam_task_block(action=block, task_key=..., reason=...)。条件恢复后用 action=unblock 解除。外部报告和推测均不直接计分。',
      }, null, 2)
    },
  })))
  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_access_add',
    description: '记录一次成功获得的访问会话（横向移动起点）。method 例如 vnc/rdp/ssh/web-shell/webshell/db；privilege 例如 admin/user/system。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string', required: true },
      username: { type: 'string' },
      method: { type: 'string', required: true, description: '获得访问的方式' },
      privilege: { type: 'string' },
      asset_id: { type: 'number' },
      session_ref: { type: 'string', description: '会话/证据引用，例如 runs/session-vnc-10.0.0.5.md' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAccess(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_access_list',
    description: '列出已获得的访问会话。',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listAccess(id, { host: args.host }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt_reset',
    description: '把角色系统提示词恢复为内置默认（新版模板）。老靶标想用上最新版角色提示词时用它；省略 role 则四个角色全部重置。',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', /* 角色白名单**从 ROLE_ORDER 派生**：写死 4 个值曾漏掉 assess，
          而预设明确要求主会话用本工具取资产梳理角色的提示词 —— 结果 enum 直接拒绝，
          资产梳理子智能体永远拿不到角色约束。派生后新增角色不会再漏。 */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.resetPrompts(id, args.role)
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ---------- WebShell 与内网隧道：打的过程中随时复用，避免"打到后面忘了还有入口" ---------- */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_sessions',
    description: '【每次决策前后都要看】一屏总览当前所有可复用入口：已上线的 WebShell、可用的内网隧道（含监听地址与可达网段）、凭据、访问会话，并给出在线/离线统计。打内网前先看这里，不要重复造轮子，也不要忘记已有的隧道。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const summary = store.sessionSummary(id)
      return JSON.stringify({
        ok: true, engagement: id, totals: summary.totals,
        webshells: summary.webshells.map((w) => ({
          id: w.id, url: w.url, type: w.shell_type, pass_key: w.pass_key, privilege: w.privilege,
          status: w.status, asset_ip: w.asset_ip, last_check: w.last_check, note: w.note,
        })),
        tunnels: summary.tunnels.map((t) => ({
          id: t.id, kind: t.kind, listen: t.listen, entry: t.entry, reach: t.reach,
          entry_kind: t.entry_kind, legit: t.legit,
          status: t.status, asset_ip: t.asset_ip, command: t.command, last_check: t.last_check, note: t.note,
        })),
        hint: '隧道 status=active 时可直接给扫描器用：-socks5 <listen> 或 --proxy socks5://<listen>；webshell status=online 时用对应客户端连接。'
          + ' 注意 legit=false（entry_kind=self-only，只在自己的 VPS/自建服务器上）**不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind，用 redteam_tunnel_update 补上目标侧那一端。',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_add',
    description: '登记一个已上线的 WebShell。**必须上传冰蝎马（behinder）或哥斯拉马（godzilla）的加密马**——用户在控制台要用对应客户端直连，一句话马/自研马/MemShell 用户连不上，不算可交付的入口。shell_type 只能填 godzilla | behinder；确实只能用其它形式时填 other 并在 note 里写清为什么。同一 url+pass_key 重复登记会合并刷新。登记后所有角色智能体都能复用它，不要重复打点。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      url: { type: 'string', required: true, description: 'WebShell 完整 URL' },
      shell_type: { type: 'string', description: 'godzilla（哥斯拉）| behinder（冰蝎）；其它形式才用 antsword/other 并说明原因' },
      pass_key: { type: 'string', description: '连接密码 / 密钥（冰蝎马写 pass，哥斯拉写 key）' },
      privilege: { type: 'string', description: '当前权限，例如 www-data / root / iis' },
      secret_ref: { type: 'string', description: '凭据/证据引用，例如 runs/ws-10.0.0.5.txt（不要把明文口令写进库）' },
      asset_id: { type: 'number' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addWebshell(id, { ...args, engagement: undefined, status: 'online', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_list',
    description: '列出已登记的 WebShell（含在线状态与最后检查时间）。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'online | offline | unknown' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listWebshells(id, args) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_update',
    description: '更新 WebShell 状态（被删/掉线/权限变化）或补充说明。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'WebShell 记录 id' },
      status: { type: 'string', description: 'online | offline | dead | unknown' },
      privilege: { type: 'string' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateWebshell(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_add',
    description: '登记一条内网隧道。**打进内网必须先用技能 suo5-tunnel 通过 WebShell/HTTP 建 socks5（kind=suo5）**；没有隧道就不要手搓内网探测脚本。listen 写本机可用地址（如 127.0.0.1:1080），reach 写它能到达的网段。登记后扫描器可直接 -socks5 <listen>。\n\n**红线：自己的 VPS / 自己配置的服务器不算隧道。** 只在你自己服务器上开的 socks5、frp 服务端、代理，没有碰到目标，**不算跨越靶标边界、不算边界突破或内网突破**（这类填 entry_kind=self-only，会被标成"不算突破"）。**必须说清目标侧的那一端**：\n· target-outbound — 目标主动连出到我方（**自己服务器收目标反弹 shell**、目标上跑 frp/Stowaway 客户端）；\n· target-http — 经目标 WebShell/HTTP 通道（suo5、Neo-ReGeorg、reGeorg）；\n· target-agent — 经目标已控进程/会话转发（SSH -R 由目标发起等）。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      kind: { type: 'string', required: true, description: 'suo5（首选，走 WebShell/HTTP）| socks5 | ssh-r | frp | chisel | other' },
      listen: { type: 'string', required: true, description: '本地监听地址 host:port' },
      entry: { type: 'string', description: '入口：WebShell URL / 跳板机 / 命令' },
      reach: { type: 'string', description: '可达网段，例如 10.0.0.0/8' },
      entry_kind: { type: 'string', description: '【重要】通道的目标侧那一端是什么：target-outbound（目标反弹 shell 到我方/目标上跑 frp 客户端）| target-http（经目标 WebShell 的 suo5/Neo-ReGeorg）| target-agent（经目标已控进程转发）| self-only（只在自己 VPS/自建服务器上，**不算突破**）' },
      webshell_id: { type: 'number', description: '由哪个 WebShell 建立' },
      asset_id: { type: 'number' },
      command: { type: 'string', description: '建立命令，便于重建' },
      pid: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addTunnel(id, { ...args, engagement: undefined, status: 'active', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_list',
    description: '列出已登记的内网隧道（含状态、监听地址、可达网段、entry_kind 与 legit 判定）。**legit=false 表示只在自己 VPS/自建服务器上开的通道，不算跨越靶标边界、不算突破**；legit=null 表示未声明 entry_kind。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'active | down | unknown' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listTunnels(id, args) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_update',
    description: '更新隧道状态（关闭/失效/更换监听地址）或补 entry_kind 判定。用完隧道务必标为 down 并说明，避免后续误用。**老记录没声明入口归属的（legit=null，界面显示"待确认"），用 entry_kind 补上目标侧那一端**，补完才算突破凭证。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true },
      status: { type: 'string', description: 'active | down | closed | unknown' },
      listen: { type: 'string' },
      reach: { type: 'string' },
      entry: { type: 'string', description: '入口：WebShell URL / 跳板机 / 命令' },
      entry_kind: { type: 'string', description: '补声明目标侧那一端：target-outbound | target-http | target-agent | self-only（只在自己服务器上，不算突破）' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateTunnel(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_check',
    description: '实测所有 WebShell 与隧道的连通性（由 host 侧真实发起 HTTP / TCP 连接），并把在线/离线状态回写数据库。开工前和长时间任务后各跑一次。',
    parameters: {
      engagement: { type: 'string' },
      timeoutMs: { type: 'number', description: '单次探测超时，默认 6000ms' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = await store.probeSessions(id, { timeoutMs: args.timeoutMs })
      const online = result.webshells.filter((w) => w.status === 'online').length
      const active = result.tunnels.filter((t) => t.status === 'active').length
      return JSON.stringify({
        ok: true, engagement: id, checked_at: result.checkedAt,
        summary: `WebShell 在线 ${online}/${result.webshells.length}，隧道可用 ${active}/${result.tunnels.length}`,
        webshells: result.webshells, tunnels: result.tunnels,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_path',
    description: '导出攻击图谱：资产拓扑 + 漏洞节点 + 已控制资产（meta.owned）。用于横向移动路径规划与战果汇报。节点过多时用 cidr 缩小范围。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      maxNodes: { type: 'number', description: '默认 400' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 400, 1500)
      const graph = store.attackGraph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: '图谱节点过多（' + graph.nodes.length + ' > ' + maxNodes + '），请指定 cidr 缩小范围',
          summary: graph.summary,
        }, null, 2)
      }
      return JSON.stringify({
        ok: true, engagement: id, summary: graph.summary,
        owned: graph.nodes.filter((n) => n.meta && n.meta.owned).map((n) => n.label),
        nodes: graph.nodes, edges: graph.edges,
      }, null, 2)
    },
  })))

  /* ================================================================== 域名 / Web 资产 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_web_list',
    description: '列出 Web 资产（含可直接访问的 URL 与页面标题）。做 Web 渗透前先看这里，优先从接口入手。',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listWeb(id, { cidr: args.cidr, limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total,
        items: result.items.map((w) => ({
          url: w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port)),
          title: w.title, ip: w.ip, segment: w.segment_cidr, port: w.port,
          service: [w.service, w.product, w.version].filter(Boolean).join(' '),
          provenance: w.provenance, asset_id: w.asset_id,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_domain_index',
    description: '按域名维度聚合资产：每个域名关联了哪些 IP/资产。用于梳理主域名、子域与 C 段的关系。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.domainIndex(id) }, null, 2)
    },
  })))

  /* ================================================================== 得分目标 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_list',
    description: '查看得分目标面板：所有得分点（名称/分类/分值/是否已拿下/命中证据）与总分进度。**每次规划下一步之前先看这里**，按分值高低决定先打什么。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listScorePoints(id, {})
      /* 按合并版的 8 个类别分组返回：智能体一眼看到"哪些类别还没打、每项上限用了多少" */
      const groups = (result.ruleGroups || []).map((g) => ({
        category: g.name,
        items: g.tiers.length,
        points: g.points,
        cap_sum: g.capSum,
      }))
      return JSON.stringify({
        ok: true, engagement: id, summary: result.summary,
        groups,
        items: result.items.map((p) => ({
          id: p.id, code: p.code, name: p.name, category: p.category, points: p.points,
          /* 合并版的档位说明（一条含多档时，记分要用 points 参数指定本档分值） */
          tier: p.tier, cap: p.cap, cap_used: p.cap_used, dedup_scope: p.dedup_scope,
          scope_label: p.scope_label,
          enabled: p.enabled, achieved: p.hits.length > 0, hits: p.hits.length,
          counted: p.counted, earned: p.earned,
          /* 该条因计分口径 / 已达上限而不计分的条数（把它当停止信号，别在同一条上刷） */
          capped: p.capped,
          /* 两个字段各司其职：service_summary 是"这条为什么有命中不计分"的整段说明；
             capped_reason 留给**逐条命中**的具体原因（在 hits[] 里），不要拿摘要冒充它。 */
          capped_summary: p.service_summary,
          evidence: p.hits.map((h) => (h.target ? h.target + '：' : '') + h.evidence).slice(0, 3),
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_hit',
    description: '记录一次得分。得分规则已按《突破入侵类得分规则（合并版）》重构为 **25 项**（一、获取权限 21 项 + 二、突破网络边界 4 项，共 8 个类别），'
      + '另有 8 条通用规则 G1–G8 横切全部条目。**记分前先用 `redteam_score_list` 读实际 code 与该条的上限/口径**，不要凭记忆写。\n\n'
      + '**证据只写结果**：目标资产 + 拿到了什么（账号/密码/权限/数据量），不要写取得过程与路径——过程由攻击得分链路的步骤负责。'
      + '能指向"用哪个漏洞拿到的"时带上 vuln_id，报告会自动附上该漏洞的原始请求。\n\n'
      + '**多档条目用 `points` 指定本档分值**：《合并版》把同一项的多个档位并成一条（如「服务器主机权限」普通 10 / 管理员 50、'
      + '「域名控制权限」一级 50 / 二级 20、「网络设备权限」普通 100 / 管理员 200）。记分时把 `points` 填成本次实际档位的分值；'
      + '不填就用该条的主档默认值。**同一系统只按最高权限计一次**（G1）——先记了普通档、后来提权到管理员档，'
      + '再记一条管理员档（points 填高档值），系统会自动顶掉普通档那条。\n\n'
      + '**红线一：账号类得分必须先实测能登录。** 拿到账号/口令后要用浏览器（browser-automation / kimi-webbridge）或等价会话'
      + '实测登录成功、能交互访问页面，才记账号权限分——**只有凭据不算拿到账号**；登不进去的写进 redteam_asset_test 的 `test` 参数。\n\n'
      + '**红线二：自己注册的账号不算得分权限。** 自助注册、自己新建的用户/角色/后台账号、自己给自己开的权限都不算——'
      + '演练得分针对**拿到别人已有的**账号与权限。这类用 self_created=true 记录（留过程），不计分、不计数、不进报告。\n\n'
      + '**红线三：注意该条的计分口径（G1/G3）。** 每条得分点自带口径：'
      + '`同一系统只算最高权限一次`／`同一服务只算最高一条`／`整个目标只算一次`（突破网络边界）／`按台·卡·个累加`（终端、云节点、算力卡）。'
      + '且每条有自己的**上限**（如服务器主机 600 分、Web 应用 2000 分、集权系统 4000 分），到上限后同条不再累计（G3）——'
      + '返回里会用 warning 告诉你"已达上限/已被顶掉"，把它当**停止信号**，换别的条目或别的资产推进，不要在同一条上刷。\n\n'
      + '**数据成果单独计分（G2）**：邮件数据、业务数据、数据资产等按重要程度另行记录，不与权限分混算；'
      + 'evidence 必须写出**实际数据量**（如「导出 1,320,000 条用户数据」）。',
    parameters: {
      engagement: { type: 'string' },
      code: { type: 'string', description: '得分点 code（或 point_id / point_name 任选其一）；先用 redteam_score_list 核对实际 code' },
      point_id: { type: 'number' },
      point_name: { type: 'string' },
      points: { type: 'number', description: '【多档条目必填】本次命中按哪一档计分（如服务器主机权限：普通权限填 10、管理员填 50；域名控制：一级 50、二级 20）。不填则用该条主档默认值。' },
      target: { type: 'string', description: '目标资产：URL / ip:port / 主机名（**带上端口**，服务/系统口径按它判定）' },
      asset_id: { type: 'number', description: '目标资产在库里的 id' },
      port: { type: 'number', description: '【建议填】这条得分落在哪个端口（口径判定按「资产 + 端口」；target 里已带端口时可不填）' },
      vuln_id: { type: 'number', description: '【建议填】用哪个漏洞拿到的分（报告据此附原始请求）' },
      step_id: { type: 'number', description: '对应的攻击链步骤 id（可选）' },
      evidence: { type: 'string', required: true, description: '【必填】结果：拿到的东西，例如「后台管理员 tomcat/Tomcat@2024（已实测浏览器可登录）」「数据库账号 root/xxx」「导出 132 万条用户数据」。多档条目请写明档位（如"管理员权限"）。' },
      self_created: { type: 'boolean', description: '【重要】这个账号/权限是不是**自己注册、自己创建**的？是则填 true —— 只作过程记录，不计分、不进报告。拿到别人已有的账号/权限不要填（默认 false）。' },
      note: { type: 'string' },
      recorded_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addScoreHit(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_point_save',
    description: '新增或修改得分点（分值/名称/分类/说明/启用）。用户也会在界面上编辑；智能体只在必要时用（例如发现规则里还有未被记录的得分项）。带 id 为修改，不带 id 为新增。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', description: '已有得分点 id（修改时传）' },
      name: { type: 'string', required: true },
      code: { type: 'string', description: '短代码（新增时建议给，便于记录得分）' },
      category: { type: 'string', description: '分类，如 账号权限 / 服务器权限 / 数据库 / 网络突破 / 数据 / 核心目标' },
      points: { type: 'number', description: '分值' },
      description: { type: 'string', description: '得分条件说明' },
      enabled: { type: 'boolean' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.saveScorePoint(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_assess',
    description: '给资产做「易打性评估」：预期能拿下哪些成果（账号权限/RCE/服务器权限/数据库权限/敏感数据/边界突破）、优先级多高、判断理由。信息收集收口时对每个资产调用一次，供指挥者按性价比排序。',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number' },
      ip: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high 容易出成果 / medium 一般 / low 难打或价值低' },
      potential: { type: 'string', description: '预期成果，如「账号权限+RCE」「数据库权限」「大量敏感信息」' },
      reason: { type: 'string', description: '判断理由：指纹版本命中 Nday、接口未鉴权、口令弱、暴露数据库、WAF 强弱等' },
      assessed_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.assessAsset(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== 证据 / 攻击链 / 报告 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_http_evidence_add',
    description: '保存一条 HTTP 证据：原始请求与响应。报告会把它渲染成可粘贴进 Burp Suite / Yakit 的原始报文，因此 request 必须是完整可重放的原始请求（含请求行、Host 等头部、必要时 body）。',
    parameters: {
      engagement: { type: 'string' },
      vuln_id: { type: 'number', description: '关联的漏洞 id（建议填）' },
      asset_id: { type: 'number' },
      label: { type: 'string', description: '这条证据的用途，例如「越权读取用户列表」' },
      method: { type: 'string', description: 'GET/POST/…' },
      url: { type: 'string' },
      status: { type: 'number', description: '响应状态码' },
      request: { type: 'string', required: true, description: '原始请求全文（Burp 可直接粘贴）' },
      response: { type: 'string', description: '响应全文或关键片段' },
      note: { type: 'string' },
      captured_by: { type: 'string', description: '采集角色' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addHttpEvidence(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* 原始 HTTP 证据可独立按 ID 追溯；摘要不向模型传回大段原始报文。 */
  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_http_evidence_query',
    description: '【只读】检索 HTTP 原始证据。可按 evidence id / vuln_id / asset_id 过滤；默认返回摘要、报文存在情况和长度。仅按具体 id 查询时默认 full，返回单条请求/响应（各最多 60000 字符），避免大量原始报文占用上下文。与哈希证据账本 redteam_evidence_list 不同。',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', description: 'HTTP 证据条目 ID；指定时默认返回单条完整正文。' },
      vuln_id: { type: 'number', description: '按关联漏洞 ID 过滤。' },
      asset_id: { type: 'number', description: '按关联资产 ID 过滤。' },
      detail: { type: 'string', enum: ['summary', 'full'], description: 'summary=摘要（默认）；full=单条原始请求/响应，必须提供 id。' },
      limit: { type: 'number', description: '每页最多 100，默认 20。' },
      offset: { type: 'number', description: '0 起分页偏移量。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.queryHttpEvidence(id, {
        id: args.id, vuln_id: args.vuln_id, asset_id: args.asset_id,
        detail: args.detail, limit: args.limit, offset: args.offset,
      })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain_add',
    description: '记录一个攻击链步骤。**报告里「这一步怎么来的」完全靠这条记录**：账号密码怎么来的、冰蝎马怎么上的、隧道怎么搭的，都要在这里用 `tool`（实际命令原文）+ `detail`（为什么这么做、线索从哪来）+ `result`（实际回显/结果）写清楚。攻击链页面与报告按 seq 排序展示。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      stage: { type: 'string', required: true, enum: ['recon', 'vuln', 'exploit', 'access', 'pivot', 'data', 'other'], description: '动作类型（兼容字段）：recon 信息收集 | vuln 漏洞发现 | exploit 利用 | access 获得权限 | pivot 内网突破 | data 敏感数据 | other。**阶段归属用 stage_code**，这个字段只用于老数据兜底。' },
      title: { type: 'string', required: true, description: '一句话描述这一步做了什么，例如「通过后台模板上传点上传冰蝎马」「用 suo5 建 socks5 隧道」' },
      detail: { type: 'string', description: '为什么这么做、线索从哪来，例如「登录页泄露版本 Coremail XT 5.0 → 匹配 CVE-2023-xxxx → 后台模板管理可上传」' },
      tool: { type: 'string', description: '【报告复现的关键】**实际执行的命令原文**，例如 `nuclei -t CVE-2021-xxxx.yaml -u http://x`、`suo5-linux-amd64 -t http://x/shell.jsp -l 1080`、`sqlmap -u "http://x?id=1" --dump`。不写这条，报告里这一步就没法复现。' },
      result: { type: 'string', description: '【报告复现的关键】实际结果/回显摘要，例如 `uid=0(root) gid=0(root)`、「返回 200，含 1.2 万条用户数据」、「后台管理员 tomcat 登录成功」' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      access_id: { type: 'number' },
      evidence_ref: { type: 'string', description: '证据文件/会话引用，例如 runs/session-vnc.md' },
      recorded_by: { type: 'string' },
      point_code: { type: 'string', description: '【这一步拿了分就填】得分点 code（如 rce / webshell / boundary），服务端会自动记一次分并把步骤与得分互相挂上。**必须同时给 evidence，否则不会记分**（步骤照常入库）。' },
      stage_code: { type: 'string', enum: ['recon', 'internet', 'boundary', 'internal', 'target'], description: '所属作战阶段（只有这 5 个合法值）：recon(信息收集) | internet(互联网资产权限) | boundary(边界突破·搭隧道) | internal(内网资产权限) | target(靶标系统权限)。写别的值（如外部工具常见的 external/foothold/tunnel/privilege）会被忽略并退回按 stage 兜底，步骤就不落在任何阶段。' },
      evidence: { type: 'string', description: '配合 point_code 使用：这一分拿到了什么（目标资产 + 账号/权限/数据量）——**不填就不记分**。' },
      self_created: { type: 'boolean', description: '配合 point_code 使用：这一步拿到的账号/权限是**自己注册/自建**的吗？是则 true（只留过程，不计分）' },
      target: { type: 'string', description: '配合 point_code 使用：目标资产' },
      seq: { type: 'number', description: '不填则自动追加到链尾' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addChainStep(id, { ...args, engagement: undefined, agent: agentOf(args), recorded_by: args.recorded_by || args.agent })
      /* 步骤落库后提醒两件事：报告要用的 tool/result 有没有写、这一步的得分有没有记 */
      const hints = []
      if (!args.tool) hints.push('这一步没写 `tool`（实际命令）：报告里"怎么做的"会变成空白，建议补一条步骤把命令写上。')
      if (!args.result) hints.push('这一步没写 `result`（实际回显/结果）：报告复现时会缺"打没打通"的证据。')
      if (result && result.score_hint) hints.push(result.score_hint)
      return JSON.stringify({ ok: true, engagement: id, ...result, hints: hints.length > 0 ? hints : undefined }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain',
    description: '读取完整攻击链（按步骤顺序），用于汇报与检查链路是否闭合（入口 → 权限 → 内网突破）。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listChain(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_add',
    description: '保存一个**实际生效**的攻击文件（脚本/POC/EXP/字典）到目标文件夹，供复用与交付。目录结构：attack-files/<IP|URL主机|C段>/<文件名>。evidence 必填且必须写清验证效果（例如"回显 uid=0"、"未授权返回 200 并含数据"）——**没打通的、只是尝试过的脚本不要放进来**。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: '目标：IP、URL 或 C 段（同一 IP 的多个端口会归到该 IP 文件夹）' },
      name: { type: 'string', required: true, description: '文件名，例如 cve-2021-22893.sh / vnc_brute.py' },
      kind: { type: 'string', enum: ['poc', 'exp', 'script', 'wordlist', 'other'], description: '类型：poc 验证 / exp 利用 / script 脚本 / wordlist 字典' },
      description: { type: 'string', description: '这个文件做什么（一句话）' },
      evidence: { type: 'string', required: true, description: '有效性证据：实际打通的输出/回显/影响，或对应漏洞/证据 id' },
      content: { type: 'string', description: '文件内容（与 path 二选一）' },
      path: { type: 'string', description: '已存在的文件路径（相对靶标目录或绝对路径），会复制进目标文件夹（与 content 二选一）' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      created_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAttackFile(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_list',
    description: '列出已保存的攻击文件（按目标文件夹分组）。开始打某个目标前先看这里，避免重复造轮子。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '只看某个目标' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.target) return JSON.stringify({ ok: true, engagement: id, items: store.listAttackFiles(id, { target: args.target }) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, folders: store.attackFileTree(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report_targets',
    description: '【已弃用，改用 redteam_score_report】按目标查看成果报告（每个 IP / URL / C 段一份）：成果漏洞（含可粘贴进 Burp/Yakit 的原始请求）、已获权限、凭据、攻击文件、攻击链。用于按目标汇报或检查某个目标还缺什么。',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: '只看某个目标的报告' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.reportTargets(id, {})
      const picked = args.target ? result.targets.filter((t) => t.key === args.target || t.label === args.target) : result.targets
      return JSON.stringify({
        ok: true, engagement: id, generated_at: result.generated_at, totals: result.totals,
        targets: picked.map((t) => ({ key: t.key, label: t.label, segment: t.segment, stats: t.stats })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_chain',
    description: '攻击链：按攻击面位置串起来的五个阶段 —— ① 信息收集（互联网侧）→ ② 互联网资产权限 → ③ 边界突破（搭隧道）→ ④ 内网资产权限 → ⑤ 靶标权限。返回每阶段的阶段目标、**实际拿到多少分与累计分**、涉及资产、以及边界突破阶段的真实隧道。开工时看它明确"现在在第几阶段、下一步该打哪一阶段"，汇报时按阶段给结论。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const chain = store.scoreChain(id)
      return JSON.stringify({
        ok: true, engagement: id,
        totals: { points: chain.summary.points, totalPoints: chain.summary.totalPoints, hits: chain.summary.hits,
          /* 按服务封顶（同资产同端口只算一次）而没计分的条数：账号类/数据库权限 */
          serviceCappedHits: chain.summary.serviceCappedHits || 0 },
        stages: (chain.stages || []).map((st) => ({
          code: st.code, name: st.name, goal: st.goal,
          points: st.points, cumulative: st.cumulative, counted: st.counted, hits: st.hits,
          steps: st.steps, tools: st.tools,
          methods: (st.sections || []).map((x) => x.label + '：' + (x.items || []).join('、')),
          scored: st.items.map((x) => ({ point: x.point_name, points: x.points, counted: x.counted, target: x.target,
            service: x.service || null, capped: x.capped === true, capped_reason: x.capped_reason || null })),
          assets: (st.assets || []).map((a) => a.ip + (a.scope === 'internal' ? '(内网)' : '(外网)') + ' 贡献' + a.points + '分'),
          tunnels: (st.tunnels || []).map((t) => t.kind + ' ' + t.listen + ' [' + t.status + '] 可达 ' + (t.reach || '—')),
        })),
        hint: '得分阶段是自动推导的（core-system→靶标、boundary→边界突破，其余按资产内外网归属）；写攻击链步骤时带 stage_code（只接受 recon/internet/boundary/internal/target）步骤计数才会落到正确阶段，写别的值会被忽略。账号权限与数据库权限按「同资产同端口」封顶：一个服务拿到最高权限即拿满，同服务重复命中标 capped=true 且不计分。',
      }, null, 2)
    },
  })))


  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_report',
    description: '攻击得分链路复现报告：只收录"拿到了分"的成果（没得分的漏洞不进报告），每一项都尽量附上可直接粘贴进 Yakit Repeater 复现的原始请求。需要交付报告时用这个，而不是 redteam_report。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '最多多少项，默认 500' },
      markdown: { type: 'boolean', description: 'true=返回 markdown 全文（默认 true）；false=只返回条目摘要' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const r = store.scoreReport(id, { limit: args.limit })
      if (args.markdown === false) {
        return JSON.stringify({ ok: true, engagement: id, summary: r.summary,
          items: r.items.map((x) => ({ seq: x.seq, point: x.point_name, points: x.points, counted: x.counted,
            target: x.target, gained: x.gained, requests: x.requests.length, missing_evidence: x.missing_evidence })) }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, summary: r.summary, markdown: r.markdown }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report',
    description: '【已弃用，改用 redteam_score_report】生成成果报告（Markdown）：只收录**已验证/已利用且中危以上**的成果漏洞（每条附可粘贴进 Burp/Yakit 的原始请求）、攻击链、已获权限与凭据、修复建议。信息收集的资产清单、待验证/误报、低危与信息级水洞都不会出现在报告里。想让发现进报告：先 redteam_vuln_update 置为 confirmed（验证通过）或 exploited（利用成功），再 redteam_http_evidence_add 补原始请求。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.report(id)
      return JSON.stringify({ ok: true, engagement: id, generated_at: result.generated_at, stats: result.stats, markdown: result.markdown }, null, 2)
    },
  })))

  /* 知识库开关：上游开源版把 POC/EXP 检索整体下架（工具名保留、执行直接返回关闭）。
     本机 fork 恢复该能力；REDTEAM_KB_ENABLED=0 可一键退回下架行为。 */
  const KB_ENABLED = process.env.REDTEAM_KB_ENABLED !== '0'
  const KB_DISABLED = JSON.stringify({ ok: false, error: '知识库未启用（REDTEAM_KB_ENABLED=0）', disabled: true }, null, 2)

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_search',
    description: '【打 Nday/1day 前的第一步】先查"现成的"两层：① **知识库**（本机沉淀的通用 POC/EXP，跨靶标共享，按"已验证 → 复用次数"排序）② **本机 nuclei 模板库**（上万条模板，CVE/组件名直接命中）。命中就取用：知识库用 redteam_poc_get 拿全文，模板直接 `nuclei -t <相对路径>`。**不要重复去互联网找或重新手搓**。两层都没有，再去互联网搜索或自己手搓，验证有效后用 redteam_poc_add 回填知识库。',
    parameters: {
      q: { type: 'string', description: '关键字：组件+版本、漏洞名、路径片段、正文里的特征串都行' },
      cve: { type: 'string', description: 'CVE / CNVD 编号，例如 CVE-2023-21839' },
      component: { type: 'string', description: '组件/产品名，例如 Weblogic、Shiro、泛微 OA、Nacos' },
      kind: { type: 'string', description: 'poc | exp | script | template | payload' },
      category: { type: 'string', description: '按**归类**筛（可多值，逗号分隔）：rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other' },
      engagement: { type: 'string', description: '按**来源靶标**筛（靶标 id 或名称关键词）：只看"在某个单位上验证过的"经验' },
      asset_target: { type: 'string', description: '按**发现资产**筛（IP / 域名 / URL 片段）' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web（互联网）| self（手搓）| manual（人工）| nuclei-template' },
      verified: { type: 'boolean', description: 'true 只看实测验证过的（优先用这些）' },
      templateLimit: { type: 'number', description: '本机 nuclei 模板最多返回几条，默认 20' },
      limit: { type: 'number', description: '知识库条目上限，默认 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      if (!KB_ENABLED) return KB_DISABLED
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      const q = args.q || args.cve || args.component || ''
      /* templateStats() / nucleiTemplatesDir() 都要扫模板目录：**一次调用只算一次**。
         原来这一小段里 templateStats() 被连着算了三遍（13k 模板的目录每次都要走一遍）。 */
      const tplStats = store.templateStats()
      const tpl = (q || args.category)
        ? store.searchTemplates(q, Math.min(Number(args.templateLimit) || 20, 100), 0, args.category || '')
        : { dir: tplStats.dir || store.nucleiTemplatesDir() || null, total: tplStats.total, items: [], byCategory: tplStats.byCategory }
      const hit = items.length > 0 || (tpl.items || []).length > 0
      return JSON.stringify({
        ok: true,
        knowledge_base: {
          total: stats.total, verified: stats.verified, reused: stats.reused,
          /* 归类概览：让智能体知道"哪类武器已经攒了多少"，缺哪类心里有数 */
          by_category: (stats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n + '（已验证 ' + c.verified + '）'),
          by_engagement: (stats.byEngagement || []).slice(0, 10).map((e) => e.engagement + ' ' + e.n),
        },
        local_templates: {
          dir: tplStats.dir, total: tplStats.total, cve_templates: tplStats.cve, matched: (tpl.items || []).length,
          by_category: (tplStats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n),
        },
        count: items.length,
        hint: hit
          ? '命中现成的：知识库条目用 redteam_poc_get 取全文；nuclei 模板直接用 `nuclei -t <模板相对路径>`。用完 redteam_poc_use 记一次复用。'
          : '知识库与本机模板库都没有：去互联网搜索（web_search / GitHub / ExploitDB / 厂商公告）或自己手搓，验证有效后务必 redteam_poc_add 回填知识库（带 category + engagement + asset_target + verified_note）。',
        templates: (tpl.items || []).map((t) => ({ path: t.path, name: t.name, severity: t.severity, tags: t.tags })),
        items: items.map((x) => ({
          id: x.id, code: x.code, title: x.title, kind: x.kind, category: x.category, cve: x.cve, component: x.component,
          versions: x.versions, language: x.language, source: x.source, source_url: x.source_url,
          verified: x.verified === 1, verified_note: x.verified_note, hit_count: x.hit_count,
          /* 来源溯源：哪条经验、哪个靶标、哪台资产、什么时候建的 */
          engagement: x.engagement_name || x.engagement_id || null, asset_target: x.asset_target || null,
          found_by_agent: x.found_by_agent || null, created_at: x.created_at,
          tags: x.tags, usage: x.usage, path: x.path, has_content: x.has_content === 1,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_get',
    description: '取一条知识库 POC/EXP 的**完整内容**（正文 + 用法 + 验证记录 + 落盘路径），可直接照用或改造成目标专用脚本。不传 id 时可用 code（redteam_poc_search 返回里的 code 字段）。',
    parameters: {
      id: { type: 'number', description: '知识库条目 id' },
      code: { type: 'string', description: '知识库条目的稳定标识（search 结果里的 code）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      if (!KB_ENABLED) return KB_DISABLED
      const row = store.getPoc(args.id !== undefined ? args.id : args.code)
      if (row === undefined) return JSON.stringify({ ok: false, error: '知识库没有这一条（先用 redteam_poc_search 检索）' }, null, 2)
      return JSON.stringify({ ok: true, ...row }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_add',
    description: '把**通用可复用**的 POC/EXP 落进知识库（跨靶标共享）。从互联网拿到的、自己手搓的、或已经调通验证过的都往这里放——只收录真正有效的，并写清来源与验证证据。判断标准：**换个目标还能用**的进知识库；只对本次靶标有效的脚本走 redteam_attack_file_add（攻击文件页）。同名（同一 code）会合并刷新，可用于更新版本。\n\n**回填三件套（缺了面板里就没有归类、追溯不到来源）**：① `category` 归类；② `engagement` + `asset_target` —— 这条知识是在哪个靶标、哪台资产上发现并验证的；③ `verified` + `verified_note` 验证证据。',
    parameters: {
      title: { type: 'string', required: true, description: '标题：组件 + 漏洞名/编号，例如「Weblogic T3 反序列化 CVE-2023-21839」' },
      kind: { type: 'string', description: 'poc（验证）| exp（利用）| script | template | payload' },
      category: { type: 'string', description: '【归类，建议必填】rce 远程命令执行 | deserialization 反序列化 | file-upload 文件上传 getshell | sqli SQL 注入 | unauthorized 未授权访问 | auth-bypass 认证绕过/越权 | weak-password 弱口令 | ssrf | xxe | path-traversal 目录穿越/任意文件读 | info-leak 信息泄露 | privesc 提权/横向 | tunnel 隧道/代理 | other 其它' },
      cve: { type: 'string', description: 'CVE / CNVD 编号' },
      component: { type: 'string', description: '组件/产品名（便于按组件检索）' },
      versions: { type: 'string', description: '影响版本范围' },
      severity: { type: 'string', description: 'critical | high | medium | low' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web（互联网扒的）| self（自己手搓）| manual（人工）| nuclei-template' },
      source_url: { type: 'string', description: '来源链接（互联网来源必填，便于复核）' },
      description: { type: 'string', description: '这个 POC 干什么、原理要点、前提条件' },
      usage: { type: 'string', description: '用法：完整命令行示例 + 需要替换的参数' },
      content: { type: 'string', description: '正文：脚本/POC 源码、原始请求包、nuclei 模板、调用步骤' },
      path: { type: 'string', description: '也可以给本机已有文件路径（相对 pocs/ 或绝对路径），由知识库读取正文' },
      filename: { type: 'string', description: '正文落盘文件名，默认按语言给（poc.py / poc.sh / poc.yaml…）' },
      verified: { type: 'boolean', description: '是否已实测验证（**只有在真实目标上验证过的才填 true**）' },
      verified_note: { type: 'string', description: '验证证据：在哪台目标、什么回显/结果、是否需要认证' },
      engagement: { type: 'string', description: '【来源靶标】这条知识是在哪个靶标上发现/验证的（填靶标 id 或单位名称）' },
      asset_target: { type: 'string', description: '【发现资产】具体是在哪台资产/哪个目标上验证成功的，例如 10.1.2.3:8080 或 http://oa.demo.com' },
      found_by_agent: { type: 'string', description: '发现它的角色 code（recon / assess / vuln-scan / exploit / internal）' },
      tags: { type: 'string', description: '逗号分隔标签，例如「java,反序列化,rce」' },
      created_by: { type: 'string', description: '哪个角色/智能体沉淀的' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      if (!KB_ENABLED) return KB_DISABLED
      /* engagement 这个参数名在本工具里表示"来源靶标"，不是"作用在哪个靶标"，
         所以不能走 resolveEngagement；只做名称补全，把 id 与中文名都记下来便于面板归类。 */
      const payload = Object.assign({}, args)
      if (typeof args.engagement === 'string' && args.engagement.trim() !== '') {
        const wanted = args.engagement.trim()
        const hit = store.listEngagements().find((e) => e.id === wanted || String(e.name) === wanted || String(e.name).includes(wanted))
        payload.engagement_id = hit ? hit.id : wanted
        payload.engagement_name = hit ? hit.name : wanted
      }
      const r = store.savePoc(payload)
      const stats = store.pocStats()
      return JSON.stringify({
        ok: true, created: r.created, code: r.poc.code, path: r.path,
        category: r.poc.category, engagement: r.poc.engagement_name || r.poc.engagement_id || null,
        asset_target: r.poc.asset_target || null, created_at: r.poc.created_at,
        verified: r.poc.verified === 1,
        hint: '已进知识库（归类：' + (r.poc.category || 'other') + '，建立时间：' + r.poc.created_at + '），'
          + '后续任何靶标的智能体 redteam_poc_search 都能直接命中；知识库共 ' + stats.total + ' 条。',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_list',
    description: '列出知识库里的 POC/EXP（可按 kind/source/component/verified 过滤，不带条件就是全部）。用于盘点"我们手上已经有哪些现成武器"，避免重复搜集。',
    parameters: {
      kind: { type: 'string' }, source: { type: 'string' }, component: { type: 'string' },
      verified: { type: 'boolean' }, limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      if (!KB_ENABLED) return KB_DISABLED
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      return JSON.stringify({ ok: true, stats: { total: stats.total, verified: stats.verified, by_kind: stats.byKind, by_source: stats.bySource },
        count: items.length,
        items: items.map((x) => ({ id: x.id, code: x.code, title: x.title, kind: x.kind, cve: x.cve, component: x.component,
          language: x.language, source: x.source, verified: x.verified === 1, hit_count: x.hit_count, tags: x.tags })) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_update',
    description: '更新知识库条目：补验证结论（verified + verified_note）、修正影响版本、补用法或正文、改标签。**在真实目标上验证通过后，一定要回来把 verified 置 true 并写清证据**——后续智能体会优先用已验证的。',
    parameters: {
      id: { type: 'number', description: '知识库条目 id' },
      code: { type: 'string', description: '或用 code 指定条目' },
      patch: {
        type: 'object', additionalProperties: true,
        description: '{ verified, verified_note, versions, usage, description, content, tags, severity, component, cve, source, source_url, language }',
      },
      verified: { type: 'boolean', description: '便捷写法：直接传 verified' },
      verified_note: { type: 'string', description: '便捷写法：直接传验证证据' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      if (!KB_ENABLED) return KB_DISABLED
      const patch = Object.assign({}, args.patch || {})
      if (args.verified !== undefined) patch.verified = args.verified
      if (args.verified_note !== undefined) patch.verified_note = args.verified_note
      const row = store.updatePoc(args.id !== undefined ? args.id : args.code, patch)
      return JSON.stringify({ ok: true, id: row.id, code: row.code, verified: row.verified === 1, verified_note: row.verified_note, updated_at: row.updated_at }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_use',
    description: '记一次知识库 POC/EXP 的复用（用在哪个靶标/目标）。复用次数高的条目会排前面，方便后来者优先选经过实战的武器。',
    parameters: {
      id: { type: 'number' },
      code: { type: 'string' },
      used_on: { type: 'string', description: '用在哪：靶标名 / 目标 IP / URL' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      if (!KB_ENABLED) return KB_DISABLED
      const r = store.markPocUsed(args.id !== undefined ? args.id : args.code, args.used_on)
      return JSON.stringify(r, null, 2)
    },
  })))

  /* ================================================================== 资产发现时间线 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_timeline',
    description: '资产「发现时间」视图：按天聚合"哪天收了多少资产"（区分内网/外网），并列出最近发现的资产。用于回答"这个资产是什么时候发现的"、检查信息收集有没有断层，也用于本轮收集的收口核对。',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: '最近资产条数，默认 50' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const data = store.discoveryTimeline(id, { limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id,
        span: data.span,
        days: data.days,
        recent: data.recent.map((a) => ({
          id: a.id, ip: a.ip, scope: a.scope, state: a.state, name: a.primary_name,
          discovered_at: a.discovered_at, last_seen: a.last_seen, open_ports: a.open_ports, priority: a.priority,
        })),
        hint: '发现时间 = 这条资产**第一次进入本库**的时刻；重复采集只刷新 last_seen。'
          + '报告附录与资产测绘页都按它排序。',
      }, null, 2)
    },
  })))

  function ledgerOf(engagementId) {
    if (typeof store.db !== 'function') throw new Error('redteam store unavailable')
    return new EvidenceLedger(store.db(engagementId))
  }
  function unknownsOf(engagementId) {
    if (typeof store.db !== 'function') throw new Error('redteam store unavailable')
    return new UnknownRegistry(store.db(engagementId))
  }

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_record',
    description: '记录一条作战证据。核心纪律：confidence 必须如实填写——claimed（子智能体口头报告，禁止直接采信）/ observed（你亲自核实过）/ derived（从 observed 推理）/ inferred（推测，必须标注）。ev_id 由内容哈希生成，改一字就变，落库后可防篡改核对。相关技能：evidence-discipline。',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string', required: true, description: '操作名，如 "nmap_scan"、"webshell_established"、"sql_injection_confirmed"' },
      parameters: { type: 'object', additionalProperties: true, description: '调用参数（JSON 对象，会参与哈希）' },
      result: { type: 'object', additionalProperties: true, required: true, description: '规范化结果（JSON 对象，会参与哈希）' },
      confidence: { type: 'string', description: 'claimed | observed | derived | inferred，默认 observed' },
      authority: { type: 'string', description: 'tool-output | database-record | screenshot | request-replay | subagent-report | operator-input，默认 tool-output' },
      limitations: { type: 'array', items: { type: 'string' }, description: '局限性说明，如 ["只扫了 Top1000 端口"]' },
      supporting_ev_ids: { type: 'array', items: { type: 'string' }, description: '支撑这条证据的其他 ev_id' },
      source_agent: { type: 'string', description: '哪个子智能体产出的（claimed 时必填）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).record({
        operation: args.operation,
        parameters: args.parameters ?? {},
        result: args.result,
        confidence: args.confidence,
        authority: args.authority,
        limitations: args.limitations ?? [],
        supporting_ev_ids: args.supporting_ev_ids ?? [],
        source_agent: args.source_agent,
        recorded_by: agentOf(args),
        engagement_id: id,
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_verify',
    description: '核对子智能体回报与证据账本是否一致（hash 级核对）。matched=false 表示子智能体改口、夸大或库里没有。',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string', required: true },
      parameters: { type: 'object', additionalProperties: true },
      result: { type: 'object', additionalProperties: true, required: true },
      confidence: { type: 'string' },
      authority: { type: 'string' },
      limitations: { type: 'array', items: { type: 'string' } },
      supporting_ev_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).verify({
        operation: args.operation,
        parameters: args.parameters ?? {},
        result: args.result,
        confidence: args.confidence ?? 'observed',
        authority: args.authority ?? 'tool-output',
        limitations: args.limitations ?? [],
        supporting_ev_ids: args.supporting_ev_ids ?? [],
      })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_upgrade',
    description: '把 claimed / inferred 升级为 observed。必须带 verified_result（亲自验证的回显/数据）。',
    parameters: {
      engagement: { type: 'string' },
      claimed_ev_id: { type: 'string', required: true, description: '要升级的证据 ID' },
      verified_result: { type: 'object', additionalProperties: true, description: '亲自验证后的实际结果' },
      verified_by: { type: 'string', description: '谁核实的，默认 coordinator' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).upgrade({
        claimed_ev_id: args.claimed_ev_id,
        verified_result: args.verified_result,
        verified_by: args.verified_by ?? agentOf(args),
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_list',
    description: '列出证据账本条目，可按 operation / confidence 过滤。汇报前先确认没有未升级的 claimed。',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string' },
      confidence: { type: 'string', description: 'claimed | observed | derived | inferred' },
      limit: { type: 'number' },
      offset: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const items = ledgerOf(id).list({
        operation: args.operation,
        confidence: args.confidence,
        engagement_id: id,
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
      })
      return JSON.stringify({ ok: true, engagement: id, items }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unverified_count',
    description: '当前靶标还有多少条 claimed/inferred 没有闭环核实。返回 >0 时汇报必须提醒未核实条数。',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const count = ledgerOf(id).countUnresolvedClaims(id)
      return JSON.stringify({
        ok: true, engagement: id, unverified_count: count,
        hint: count > 0 ? `还有 ${count} 条 claimed/inferred 未闭环核实，汇报时不要说"已拿到"` : '所有子智能体报告都已亲自核实闭环',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_record',
    description: '记录一个还没解决的作战问题。question+domain 相同会去重。',
    parameters: {
      engagement: { type: 'string' },
      question: { type: 'string', required: true },
      severity: { type: 'string', description: 'low | medium | high | critical，默认 medium' },
      domain: { type: 'string', description: '如 internal-recon / boundary-break / lateral-movement' },
      recommended_probe: { type: 'string', description: '建议的验证手段' },
      supporting_ev_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = unknownsOf(id).record({
        question: args.question,
        severity: args.severity ?? 'medium',
        domain: args.domain ?? 'general',
        recommended_probe: args.recommended_probe,
        supporting_ev_ids: args.supporting_ev_ids ?? [],
        engagement_id: id,
        recorded_by: agentOf(args),
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_resolve',
    description: '把未解决问题标为 resolved / contradicted / withdrawn。',
    parameters: {
      engagement: { type: 'string' },
      unk_id: { type: 'string', required: true },
      disposition: { type: 'string', required: true, description: 'resolved | contradicted | withdrawn' },
      resolution: { type: 'string', description: '解决说明' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = unknownsOf(id).resolve(args.unk_id, args.disposition, args.resolution, agentOf(args))
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_list',
    description: '列出未解决的作战问题，派活前先看 open 项。',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'open | investigating | blocked | contradicted | resolved' },
      severity: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const items = unknownsOf(id).list({
        status: args.status ?? 'open',
        severity: args.severity,
        engagement_id: id,
        limit: args.limit ?? 50,
      })
      return JSON.stringify({ ok: true, engagement: id, items }, null, 2)
    },
  })))
}
