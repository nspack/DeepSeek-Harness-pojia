import test from 'node:test'
import assert from 'node:assert/strict'
import { markLocalSkillCatalog, markNativeSkillCatalog } from '../lib/redteam/skill-registry-state.js'

const inventory = () => ({
  ok: true,
  items: [
    { name: 'active-scan', library: 'redteam', availability: 'available' },
    { name: 'office-doc', library: 'official', availability: 'listed' },
    { name: 'recon/passive-recon', library: 'aboutsecurity', availability: 'available' },
  ],
})

test('local fallback preserves readability but does not claim native registration', () => {
  const original = inventory()
  const result = markLocalSkillCatalog(original, 'unavailable')
  assert.equal(result.registryState, 'unavailable')
  assert.equal(result.hostListedCount, 0)
  assert.equal(result.items[0].availability, 'available')
  assert.equal(result.items[0].hostListed, false)
  assert.equal(original.items[0].hostListed, undefined)
  assert.equal(result.items[1].hostListed, undefined)
  assert.equal(result.items[2].hostListed, false)
  assert.match(result.note, /宿主/)
})

test('official-only native listing still marks local redteam skills as unregistered', () => {
  const result = markLocalSkillCatalog(inventory(), 'no-redteam')
  assert.equal(result.registryState, 'no-redteam')
  assert.equal(result.items[0].hostListed, false)
  assert.equal(result.hostListedCount, 0)
  assert.match(result.note, /没有列出红队技能/)
})

test('native scoped skill listing marks only redteam entries as host-listed', () => {
  const result = markNativeSkillCatalog(inventory(), 1)
  assert.equal(result.registryState, 'listed')
  assert.equal(result.hostListedCount, 1)
  assert.equal(result.items[0].hostListed, true)
  assert.equal(result.items[1].hostListed, undefined)
  assert.equal(result.items[2].hostListed, false, 'external skill is readable but not native registered')
  assert.equal(result.items[0].availability, 'available')
})

test('missing or unsuccessful catalogs retain their original error result', () => {
  const bad = { ok: false, error: 'host unavailable' }
  assert.equal(markLocalSkillCatalog(bad, 'empty'), bad)
  assert.equal(markNativeSkillCatalog(bad, 2), bad)
})
