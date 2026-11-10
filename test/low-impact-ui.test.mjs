import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatch } from '../lib/redteam/store-core.js'

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')

test('workbench has a real low-impact tab in both source and embedded UI', () => {
  for (const path of ['lib/redteam/client.js', 'client.js']) {
    const src = read(path)
    assert.match(src, /function LowImpactTab\(props\)/, path)
    assert.match(src, /\['low-impact', '低干扰'\]/, path)
    assert.match(src, /st\.tab === 'low-impact'/, path)
    assert.match(src, /op: 'platformConfigSave', config: \{ scanPreferences: draft \}/, path)
    assert.match(src, /maskHistory \? '目标已隐藏'/, path)
    assert.match(src, /item\.output_file && !maskHistory/, path)
  }
})

test('workbench API saves only scan preferences and preserves existing configuration', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'redteam-impact-ui-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = { root: dir }
  let result = dispatch(store, { op: 'platformConfigSave',
    config: { tools: { nmap: '/mock/nmap' } } })
  assert.equal(result.ok, true)
  result = dispatch(store, { op: 'platformConfigSave', config: { scanPreferences: {
    mode: 'low-impact', timeoutSeconds: 60, captureDiagnostics: false, maskHistory: true,
  } } })
  assert.equal(result.ok, true)
  assert.equal(result.config.tools.nmap, '/mock/nmap')
  assert.deepEqual(result.config.scanPreferences, {
    mode: 'low-impact', timeoutSeconds: 60, captureDiagnostics: false, maskHistory: true,
  })
  const loaded = dispatch(store, { op: 'platformConfigGet' })
  assert.deepEqual(loaded.config.scanPreferences, result.config.scanPreferences)
})
