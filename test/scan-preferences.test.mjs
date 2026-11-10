import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPlatformConfig, savePlatformConfig, normalizeScanPreferences } from '../lib/redteam/platform-config.js'

test('scan preferences persist independently without replacing existing tool paths', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'redteam-scan-options-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(normalizeScanPreferences(), {
    mode: 'standard', timeoutSeconds: 180, captureDiagnostics: true, maskHistory: false,
  })
  savePlatformConfig({ tools: { nmap: '/mock/nmap' }, env: { FOFA_KEY: 'fixture' } }, dir)
  const saved = savePlatformConfig({ scanPreferences: {
    mode: 'low-impact', timeoutSeconds: 60, captureDiagnostics: false, maskHistory: true,
  } }, dir)
  assert.deepEqual(saved.scanPreferences, {
    mode: 'low-impact', timeoutSeconds: 60, captureDiagnostics: false, maskHistory: true,
  })
  assert.equal(loadPlatformConfig(dir).tools.nmap, '/mock/nmap')
  assert.equal(loadPlatformConfig(dir).env.FOFA_KEY, 'fixture')
  const reset = savePlatformConfig({ scanPreferences: { timeoutSeconds: -42, mode: 'unlisted' } }, dir)
  assert.equal(reset.scanPreferences.timeoutSeconds, 180)
  assert.equal(reset.scanPreferences.mode, 'standard')
  assert.equal(reset.scanPreferences.maskHistory, true)
})
