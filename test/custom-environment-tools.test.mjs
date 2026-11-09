import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadPlatformConfig, savePlatformConfig, resolveTool, resolveAllTools, platformSummary,
} from '../lib/redteam/platform-config.js'
import { probeInstalledTool } from '../lib/redteam/tool-health.js'

test('custom tool paths persist and augment built-in tools without replacing them', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'redteam-extra-tools-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'my-tool.exe')
  writeFileSync(file, 'fixture')
  savePlatformConfig({ customTools: [
    { name: 'My Toolkit', path: file },
    { name: 'Missing CLI', path: join(root, 'missing') },
  ] }, root)
  const config = loadPlatformConfig(root)
  assert.equal(config.customTools.length, 2)
  assert.equal(config.customTools[0].name, 'My Toolkit')
  assert.equal(resolveTool('custom:0', { root }).path, file)
  assert.equal(resolveTool('custom:1', { root }).path, null)
  const all = resolveAllTools({ root })
  assert.ok(all.find((t) => t.id === 'nmap'))
  assert.equal(all.length, 19)
  assert.equal(all.at(-2).label, 'My Toolkit')
  assert.ok(platformSummary(root).tools.found >= 1)
  assert.equal(platformSummary(root).tools.items.at(-2).path, file)
  assert.equal(platformSummary(root).tools.items.at(-2).canProbe, false)
  savePlatformConfig({ notes: 'preserved' }, root)
  assert.equal(loadPlatformConfig(root).customTools.length, 2)
  const unknown = resolveTool('custom:999', { root })
  assert.equal(unknown.path, null)
})

test('blank extra-tool rows can be omitted; probe does not execute custom binary', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'redteam-extra-tools-empty-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'cli.exe')
  writeFileSync(file, 'fixture')
  const cfg = savePlatformConfig({ customTools: [{ name: '', path: '' }, { name: 'CLI', path: file }] }, root)
  assert.equal(cfg.customTools.length, 1)
  assert.equal(resolveTool('custom:0', { root }).path, file)
  const result = await probeInstalledTool('custom:0', {
    root, execFileFn: () => { throw new Error('custom tool should not be launched') },
  })
  assert.equal(result.status, 'unknown')
  assert.equal(resolveAllTools({ root }).length, 18)
  savePlatformConfig({ customTools: [] }, root)
  assert.equal(resolveAllTools({ root }).length, 17)
})
