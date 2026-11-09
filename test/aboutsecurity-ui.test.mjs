import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { aboutSecurityDir, listLocalSkills, readLocalSkill, searchLocalSkills } from '../lib/redteam/skill-catalog.js'
import { aboutSecurityStatus, startAboutSecurity } from '../lib/redteam/aboutsecurity-manager.js'

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'purge-aboutsecurity-ui-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    rmSync(home, { recursive: true, force: true })
  })
  return home
}
function putSkill(root) {
  const skill = join(root, 'recon', 'passive-recon', 'SKILL.md')
  mkdirSync(dirname(skill), { recursive: true })
  writeFileSync(skill, '---\nname: passive-recon\ndescription: "被动 OSINT"\n---\n# 被动检索')
}
test('AboutSecurity absent: status is read-only and builtin skill directory remains visible', async (t) => {
  const home = fixture(t)
  const snap = aboutSecurityStatus({ home })
  assert.equal(snap.ok, true)
  assert.equal(snap.installed, false)
  assert.equal(snap.skills, 0)
  assert.equal(aboutSecurityStatus({ home }).busy, false)
  const skills = listLocalSkills({ home })
  assert.ok(skills.some((x) => x.source === 'redteam'))
  assert.ok(!skills.some((x) => x.source === 'aboutsecurity'))
})

test('existing AboutSecurity skills show separately, with a readable body and no false native registry claim', async (t) => {
  const home = fixture(t)
  const root = aboutSecurityDir(home)
  mkdirSync(join(dirname(root), '.git'), { recursive: true })
  putSkill(root)
  const snap = aboutSecurityStatus({ home })
  assert.equal(snap.installed, true)
  assert.equal(snap.skills, 1)
  const catalog = listLocalSkills({ home }).filter((x) => x.source === 'aboutsecurity')
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].key, 'aboutsecurity:recon/passive-recon')
  const found = searchLocalSkills('OSINT', { home })
  assert.equal(found.total, 1)
  const detail = readLocalSkill(catalog[0].key, { home })
  assert.ok(detail.content.includes('被动检索'))
  assert.throws(() => readLocalSkill('aboutsecurity:../../outside', { home }), /not found/)
})

test('explicit install is asynchronous, updates status and does not start automatically', async (t) => {
  const home = fixture(t)
  const commands = []
  const start = startAboutSecurity({ home, runGit: async (argv) => {
    commands.push(argv)
    if (argv[0] === 'clone') {
      mkdirSync(join(argv.at(-1), '.git'), { recursive: true })
      putSkill(join(argv.at(-1), 'skills'))
    }
  } })
  assert.equal(start.ok, true)
  assert.equal(start.busy, true)
  for (let i = 0; i < 30 && aboutSecurityStatus({ home }).busy; i++) await delay(10)
  const ready = aboutSecurityStatus({ home })
  assert.equal(ready.busy, false)
  assert.equal(ready.installed, true)
  assert.equal(ready.skills, 1)
  assert.equal(commands[0][0], 'clone')
  assert.equal(commands[1][2], 'sparse-checkout')
  const again = startAboutSecurity({ home, runGit: async () => { throw new Error('should not run') } })
  assert.equal(again.ok, false)
  assert.equal(again.installed, true)
})


test('host and embedded client both expose the install/status UI without importing optional host dependencies', () => {
  const ui = readFileSync(new URL('../lib/redteam/ui.js', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('../lib/redteam/client.js', import.meta.url), 'utf8')
  const embedded = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  for (const op of ['aboutSecurityStatus', 'aboutSecurityInstall', 'aboutSecurityUpdate']) {
    assert.ok(ui.includes(op), 'host missing ' + op)
    assert.ok(panel.includes(op), 'panel missing ' + op)
    assert.ok(embedded.includes(op), 'embedded panel missing ' + op)
  }
  assert.match(ui, /request\.library === 'aboutsecurity'/)
  assert.match(ui, /hostListed: false/)
  assert.match(panel, /按功能分类筛选/)
  assert.match(panel, /按技能来源筛选/)
  assert.match(embedded, /AboutSecurity 扩展技能库/)
})
