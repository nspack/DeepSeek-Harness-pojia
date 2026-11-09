/**
 * Search/read existing bundled skills and optionally installed AboutSecurity skills.
 * No network calls and no automatic installation.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'redteam')
const homeOf = (home) => home || process.env.DSH_HOME || join(homedir(), '.dsh')
export const aboutSecurityDir = (home) => join(homeOf(home), 'redteam', 'external-skills', 'aboutsecurity', 'skills')

function walk(root, fn) {
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()
    let items
    try { items = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const item of items) {
      const full = join(dir, item.name)
      // External repos may have symlinks; never follow them for indexing or reading.
      if (item.isDirectory()) pending.push(full)
      else if (item.isFile()) fn(full, item.name)
    }
  }
}

/**
 * 读 SKILL.md 的 frontmatter 标量字段。
 *
 * 支持 YAML 块标量（`description: |` / `>`）：上游 AboutSecurity 有 47 个技能用
 * 多行描述，旧实现只按 `key: value` 单行取，结果 `description` 变成字面量 "|"，
 * 面板与原生技能列表里就成了一条空描述——模型根本看不出这个技能什么时候该用。
 */
function metadata(md) {
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!frontmatter) return {}
  const lines = frontmatter[1].split(/\r?\n/)
  const fields = {}
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([a-z][\w-]*):\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    const block = /^([|>])([+-]?)$/.exec(value)
    if (block) {
      /* 收集比 key 缩进更深的后续行；`|` 保留换行，`>` 折叠成空格（YAML 语义）。 */
      const collected = []
      let j = i + 1
      for (; j < lines.length; j += 1) {
        const line = lines[j]
        if (line.trim() === '') { collected.push(''); continue }
        if (!/^\s/.test(line)) break
        collected.push(line)
      }
      const indents = collected.filter((line) => line !== '').map((line) => line.match(/^\s*/)[0].length)
      const cut = indents.length ? Math.min(...indents) : 0
      const body = collected.map((line) => line.slice(cut)).join('\n').replace(/\n+$/, '')
      value = block[1] === '|' ? body : body.split(/\n+/).map((s) => s.trim()).filter(Boolean).join(' ')
      i = j - 1
    } else {
      value = value.replace(/^(["'])([\s\S]*)\1$/, '$2')
    }
    fields[key] = value
  }
  return fields
}

export function listLocalSkills({ home } = {}) {
  const list = []
  walk(bundled, (file, name) => {
    if (!name.endsWith('.md')) return
    const body = readFileSync(file, 'utf8')
    const heading = /^\s*#\s+(.+)$/m.exec(body)
    list.push({
      key: 'redteam:' + name.slice(0, -3), source: 'redteam',
      name: name.slice(0, -3), title: heading?.[1] || name,
      description: '', file,
    })
  })
  const external = aboutSecurityDir(home)
  walk(external, (file, name) => {
    if (name !== 'SKILL.md') return
    const body = readFileSync(file, 'utf8')
    const data = metadata(body)
    const rel = relative(external, dirname(file)).split('\\').join('/')
    list.push({
      key: 'aboutsecurity:' + rel, source: 'aboutsecurity', name: data.name || rel.split('/').pop(),
      title: data.name || rel, description: data.description || '', file,
    })
  })
  return list
}

export function searchLocalSkills(query, { home, limit = 10 } = {}) {
  const skills = listLocalSkills({ home })
  const terms = String(query || '').toLowerCase().trim().split(/[\s,，]+/).filter(Boolean)
  const results = skills.map((s) => {
    let score = terms.length === 0 ? 1 : 0
    const name = s.name.toLowerCase()
    const text = (s.title + ' ' + s.description + ' ' + s.key).toLowerCase()
    for (const term of terms) {
      if (name === term) score += 50
      else if (name.includes(term)) score += 20
      else if (text.includes(term)) score += 8
    }
    return { skill: s, score }
  }).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.key.localeCompare(b.skill.key))
  const take = Math.max(1, Math.min(50, Number(limit) || 10))
  return {
    total: results.length, count: Math.min(results.length, take),
    aboutsecurity_installed: skills.some((s) => s.source === 'aboutsecurity'),
    items: results.slice(0, take).map(({ skill: s }) => ({
      key: s.key, name: s.name, title: s.title, description: s.description, source: s.source,
    })),
  }
}

export function readLocalSkill(key, { home, maxChars = 16000 } = {}) {
  const skill = listLocalSkills({ home }).find((entry) => entry.key === key)
  if (!skill) throw new Error('skill not found: ' + String(key || ''))
  const markdown = readFileSync(skill.file, 'utf8')
  const n = Math.max(1000, Math.min(100000, Number(maxChars) || 16000))
  return {
    key: skill.key, name: skill.name, source: skill.source,
    content: markdown.slice(0, n), truncated: markdown.length > n,
  }
}
