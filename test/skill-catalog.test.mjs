import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aboutSecurityDir, listLocalSkills, readLocalSkill, searchLocalSkills } from '../lib/redteam/skill-catalog.js'

test('内建 redteam 技能可检索，无 AboutSecurity 时不影响原有技能', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'purge-skill-search-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const entries = listLocalSkills({ home })
  assert.ok(entries.some((e) => e.key === 'redteam:web-injection'))
  const result = searchLocalSkills('web-injection', { home })
  assert.equal(result.aboutsecurity_installed, false)
  assert.ok(result.items.some((e) => e.key === 'redteam:web-injection'))
})

test('外部 AboutSecurity 的嵌套 SKILL.md 能搜索与按 key 读取', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'purge-aboutsecurity-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const root = join(aboutSecurityDir(home), 'recon', 'passive-recon')
  mkdirSync(root, { recursive: true })
  const body = '---\nname: passive-recon\ndescription: "被动 OSINT 与威胁情报"\n---\n# 内容\n测试正文'
  writeFileSync(join(root, 'SKILL.md'), body)
  const result = searchLocalSkills('OSINT', { home })
  assert.equal(result.aboutsecurity_installed, true)
  assert.equal(result.total, 1)
  assert.equal(result.items[0].key, 'aboutsecurity:recon/passive-recon')
  assert.equal(readLocalSkill(result.items[0].key, { home }).content, body)
  assert.throws(() => readLocalSkill('aboutsecurity:../../secret', { home }), /not found/)
})

test('技能搜索、读取只读且返回数量受请求约束', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'purge-skill-bounds-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const results = searchLocalSkills('', { home, limit: 3 })
  assert.equal(results.items.length, 3)
  const item = readLocalSkill('redteam:web-injection', { home, maxChars: 1000 })
  assert.equal(item.content.length <= 1000, true)
  assert.equal(item.key, 'redteam:web-injection')
})
