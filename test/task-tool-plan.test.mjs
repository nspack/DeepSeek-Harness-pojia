import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { listTaskToolProfiles, planTaskTools, verifyTaskTool } from '../lib/redteam/task-tool-plan.js'

const workspace = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-tools-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
const fileAt = (path) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'fixture'); return path }
const configFor = (root, tools) => ({ platform: 'windows', toolkitDir: join(root, 'none'),
  binDirs: [], tools })

test('profiles contain only declared tool IDs and have stable task labels', () => {
  const profiles = listTaskToolProfiles()
  assert.ok(profiles.length >= 5)
  assert.equal(new Set(profiles.map((p) => p.id)).size, profiles.length)
  assert.ok(profiles.find((p) => p.id === 'web').toolIds.includes('katana'))
})

test('task selection picks an installed, verifiable candidate over a path-only one', (t) => {
  const root = workspace(t)
  const fscan = fileAt(join(root, 'fscan.exe'))
  const nmap = fileAt(join(root, 'nmap.exe'))
  const plan = planTaskTools('internal', {
    root, config: configFor(root, { fscan, nmap }), env: { PATH: '' },
  })
  assert.equal(plan.status, 'located')
  assert.equal(plan.selected.id, 'nmap')
  assert.equal(plan.selected.verification, 'not-run')
  assert.ok(plan.candidates.find((c) => c.id === 'fscan').detected)
  assert.ok(plan.candidates.every((c) => c.verification === 'not-run'))
})

test('unknown tasks and missing binaries do not run anything', async (t) => {
  const root = workspace(t)
  const options = {
    root, config: configFor(root, {}), env: { PATH: '' },
    execFileFn: () => { throw new Error('must not execute') },
  }
  const unknown = await verifyTaskTool('wrong-task', options)
  assert.equal(unknown.ok, false)
  const missing = await verifyTaskTool('web', options)
  assert.equal(missing.status, 'missing')
  assert.equal(missing.verification, null)
  assert.equal(missing.selected, null)
})

test('explicit version verification proves only a local command ran', async (t) => {
  const root = workspace(t)
  const katana = fileAt(join(root, 'katana.exe'))
  let runCount = 0
  const plan = await verifyTaskTool('web', {
    root, config: configFor(root, { katana }), env: { PATH: '' },
    execFileFn: (path, args, options, done) => {
      runCount++
      assert.equal(path, katana)
      assert.deepEqual(args, ['-version'])
      assert.equal(options.shell, false)
      done(null, 'katana 2.0\n', '')
    },
  })
  assert.equal(runCount, 1)
  assert.equal(plan.status, 'version-verified')
  assert.equal(plan.selected.id, 'katana')
  assert.equal(plan.verification.version, 'katana 2.0')
  assert.match(plan.note, /未向任何目标/)
})

test('path-only tools never launch binaries even on verify request', async (t) => {
  const root = workspace(t)
  const impacket = fileAt(join(root, 'secretsdump.py'))
  const plan = await verifyTaskTool('identity', {
    root, config: configFor(root, { impacket }), env: { PATH: '' },
    execFileFn: () => { throw new Error('must not launch') },
  })
  assert.equal(plan.selected.id, 'impacket')
  assert.equal(plan.status, 'path-only')
  assert.equal(plan.verification.status, 'path-only')
})

test('environment API and embedded client expose task-tool choice without target execution', async () => {
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../lib/redteam/ui.js', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../lib/redteam/client.js', import.meta.url), 'utf8')
  const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(host, /platformTaskPlan/)
  assert.match(host, /planTaskTools/)
  for (const text of [source, bundle]) {
    assert.match(text, /按任务选择工具/)
    assert.match(text, /platformTaskPlan/)
    assert.match(text, /验证推荐工具版本/)
  }
})
