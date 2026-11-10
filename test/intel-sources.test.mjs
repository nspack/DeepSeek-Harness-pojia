import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INTEL_SOURCES, normalizeIntelSources } from '../lib/redteam/intel-sources.js'
import { loadPlatformConfig, savePlatformConfig, platformSummary } from '../lib/redteam/platform-config.js'
import { dispatch } from '../lib/redteam/store-core.js'

test('internet asset search sources have distinct official browser entries and honest execution states', () => {
  assert.deepEqual(INTEL_SOURCES.map((x) => x.id),
    ['local', 'fofa', 'shodan', 'censys', 'zoomeye', 'quake', 'hunter', 'netlas'])
  assert.equal(INTEL_SOURCES[0].mode, 'local')
  assert.equal(INTEL_SOURCES.find((x) => x.id === 'fofa').mode, 'existing-skill')
  for (const src of INTEL_SOURCES.filter((x) => x.id !== 'local' && x.id !== 'fofa')) {
    assert.equal(src.mode, 'website-only')
    assert.ok(src.url.startsWith('https://'))
    assert.match(src.details, /没有直连 .* API/)
  }
  assert.deepEqual(normalizeIntelSources(), { selected: ['local'], preferred: 'local' })
  assert.deepEqual(normalizeIntelSources({
    selected: ['shodan', 'local', 'shodan', 'fake', 44], preferred: 'shodan',
  }), { selected: ['shodan', 'local'], preferred: 'shodan' })
  assert.deepEqual(normalizeIntelSources({ selected: ['invalid'], preferred: 'invalid' }),
    { selected: [], preferred: 'local' })
})

test('multi-provider preferences persist through existing platform API without losing FOFA key or tool paths', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'redteam-intel-sources-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  savePlatformConfig({ env: { FOFA_KEY: 'fixture-key' }, tools: { nmap: '/mock/nmap' } }, root)
  const store = { root }
  const response = dispatch(store, { op: 'platformConfigSave', config: {
    intelSources: { selected: ['local', 'censys', 'shodan', 'quake'], preferred: 'shodan' },
  } })
  assert.equal(response.ok, true)
  assert.deepEqual(response.config.intelSources,
    { selected: ['local', 'censys', 'shodan', 'quake'], preferred: 'shodan' })
  assert.equal(response.config.env.FOFA_KEY, 'fixture-key')
  assert.equal(response.config.tools.nmap, '/mock/nmap')
  const roundTrip = dispatch(store, { op: 'platformConfigGet' })
  assert.deepEqual(roundTrip.config.intelSources, response.config.intelSources)
  assert.deepEqual(platformSummary(root).intelSources.map((x) => x.id), INTEL_SOURCES.map((x) => x.id))
  assert.deepEqual(loadPlatformConfig(root).intelSources, response.config.intelSources)
  assert.equal(readFileSync(join(root, 'config.json'), 'utf8').includes('fixture-key'), true)
})

test('source and embedded workbench offer real selection controls and identify external API limits', () => {
  const load = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  for (const path of ['lib/redteam/client.js', 'client.js']) {
    const src = load(path)
    assert.match(src, /function LocalAssetSearchTab/)
    assert.match(src, /\['local-search', '测绘中心'\]/)
    assert.match(src, /source\.mode === 'existing-skill'/)
    assert.match(src, /source\.mode === 'local'/)
    assert.match(src, /onClick: saveSources/)
    assert.match(src, /op: 'platformConfigSave', config: \{ intelSources: chosen \}/)
    assert.match(src, /source\.url, target: '_blank', rel: 'noopener noreferrer'/)
    assert.match(src, /官网入口 · API 未接入/)
    assert.match(src, /本地资产组合查询 · 已接通/)
  }
})
