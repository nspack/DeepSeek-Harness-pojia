import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { aboutSecurityDir } from '../lib/redteam/skill-catalog.js'
import { aboutSecurityStatus, startAboutSecurity } from '../lib/redteam/aboutsecurity-manager.js'
import {
  ABOUTSECURITY_PROVIDER, nativeAboutSecurityName,
  createNativeAboutSecurityProvider, connectNativeAboutSecurity,
} from '../lib/redteam/aboutsecurity-provider.js'
import { skillLibraryOf } from '../lib/redteam/skill-availability.js'

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'purge-native-aboutsecurity-'))
  t.after(() => rmSync(home, { force: true, recursive: true }))
  return home
}
function addSkill(home, content = '# harmless skill body') {
  const file = join(aboutSecurityDir(home), 'recon', 'passive-recon', 'SKILL.md')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '---\nname: passive-recon\ndescription: "被动情报收集"\n---\n' + content)
  return file
}
async function untilReady(home) {
  for (let i = 0; i < 60 && aboutSecurityStatus({ home }).busy; i++) await sleep(10)
  assert.equal(aboutSecurityStatus({ home }).busy, false, 'operation did not complete')
}
function fakeScope() {
  let provider
  let disposeCount = 0
  let cleanup = () => {}
  return {
    skills: {
      registerProvider(factory) {
        provider = factory()
        return () => { disposeCount++; provider = undefined }
      },
    },
    effect(fn) { cleanup = fn() },
    get provider() { return provider },
    get disposeCount() { return disposeCount },
    dispose() { cleanup() },
  }
}

test('native provider uses namespaced stable names and supplies complete skill bodies', async (t) => {
  const home = setup(t)
  const file = addSkill(home, '# read-only OSINT instructions')
  const provider = createNativeAboutSecurityProvider({ home })
  const found = await provider.list()
  assert.equal(found.length, 1)
  assert.equal(found[0].name, 'aboutsecurity-recon-passive-recon')
  assert.equal(found[0].provider, ABOUTSECURITY_PROVIDER)
  assert.equal(found[0].path, file)
  assert.equal(skillLibraryOf(found[0]), 'aboutsecurity')
  const body = await provider.get(found[0])
  assert.ok(body.content.includes('read-only OSINT instructions'))
  assert.ok(!body.content.startsWith('---'))
  assert.deepEqual(body.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(nativeAboutSecurityName('aboutsecurity:recon/passive-recon'), found[0].name)
  await assert.rejects(() => provider.get({ name: 'aboutsecurity-unknown' }), /no longer installed/)
})

test('native skills register on existing checkout and deregister with host scope', async (t) => {
  const home = setup(t)
  addSkill(home)
  const scope = fakeScope()
  const ctx = { inject(names, callback) { assert.deepEqual(names, ['skills']); callback(scope) } }
  assert.equal(connectNativeAboutSecurity(ctx, { home }), true)
  assert.equal(scope.provider.name, ABOUTSECURITY_PROVIDER)
  assert.equal((await scope.provider.list()).length, 1)
  scope.dispose()
  assert.equal(scope.disposeCount, 1)
  assert.equal(scope.provider, undefined)
})

test('install and update refresh native registration; failed updates retain usable skills', async (t) => {
  const home = setup(t)
  const scope = fakeScope()
  const ctx = { inject(_deps, callback) { callback(scope) } }
  connectNativeAboutSecurity(ctx, { home })
  assert.equal(scope.provider, undefined)
  const operations = []
  const result = startAboutSecurity({ home, runGit: async (argv) => {
    operations.push(argv)
    if (argv[0] === 'clone') {
      mkdirSync(join(argv.at(-1), '.git'), { recursive: true })
      const original = join(argv.at(-1), 'skills', 'recon', 'passive-recon', 'SKILL.md')
      mkdirSync(dirname(original), { recursive: true })
      writeFileSync(original, '---\nname: passive-recon\ndescription: test\n---\n# first')
    }
  } })
  assert.equal(result.busy, true)
  await untilReady(home)
  assert.ok(scope.provider)
  assert.equal((await scope.provider.list()).length, 1)
  assert.equal(operations.length, 2)
  const update = startAboutSecurity({ home, update: true, runGit: async (argv) => { operations.push(argv); addSkill(home, '# updated') } })
  assert.equal(update.busy, true)
  await untilReady(home)
  assert.ok(scope.disposeCount >= 1)
  assert.match((await scope.provider.get((await scope.provider.list())[0])).content, /updated/)
  const broken = startAboutSecurity({ home, update: true, runGit: async () => { throw new Error('offline') } })
  assert.equal(broken.busy, true)
  await untilReady(home)
  assert.match(aboutSecurityStatus({ home }).error, /offline/)
  assert.ok(scope.provider, 'failed update must not unregister previous skills')
  scope.dispose()
})

test('older hosts without native injection keep model-tool fallback', () => {
  assert.equal(connectNativeAboutSecurity({}), false)
})
