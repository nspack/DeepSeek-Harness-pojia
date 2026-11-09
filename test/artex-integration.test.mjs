import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  artexToolRoots, findArtexTool, inspectArtex, ARTEX_SHARED_TOOLS,
} from '../lib/artex-integration.js'
import { resolveTool } from '../lib/redteam/platform-config.js'

function workspace(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-purge-artex-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}
function put(file) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'test binary')
  return file
}

test('ARTEX Windows Tool Manager current layout is reusable without copying or config writes', (t) => {
  const home = workspace(t)
  const path = put(join(home, 'ARTEX', 'tools', 'nuclei', 'current', 'nuclei.exe'))
  const env = { LOCALAPPDATA: home, PATH: '' }
  assert.equal(findArtexTool('nuclei', { env, platform: 'win32' }), path)
  assert.equal(findArtexTool('nmap', { env, platform: 'win32' }), null, 'unknown ARTEX inventory is not guessed')
  const root = join(home, 'dsh', 'redteam')
  const config = { platform: 'windows', tools: {}, toolkitDir: join(home, 'empty'), binDirs: [] }
  const resolved = resolveTool('nuclei', { root, config, env })
  assert.equal(resolved.path, path)
  assert.equal(resolved.source, 'artex')
})

test('explicit user tool path wins over ARTEX shared binary', (t) => {
  const home = workspace(t)
  put(join(home, 'ARTEX', 'tools', 'nuclei', 'current', 'nuclei.exe'))
  const own = put(join(home, 'dsh-tools', 'nuclei.exe'))
  const resolved = resolveTool('nuclei', {
    root: join(home, 'dsh', 'redteam'),
    config: { platform: 'windows', toolkitDir: join(home, 'empty'), binDirs: [], tools: { nuclei: own } },
    env: { LOCALAPPDATA: home, PATH: '' },
  })
  assert.equal(resolved.path, own)
  assert.equal(resolved.source, 'config')
})

test('ARTEX versioned fallback excludes inactive previous staging files', (t) => {
  const home = workspace(t)
  const root = join(home, 'ARTEX', 'tools', 'ffuf')
  put(join(root, '.previous', 'ffuf.exe'))
  put(join(root, '.pending', 'ffuf.exe'))
  assert.equal(findArtexTool('ffuf', { env: { LOCALAPPDATA: home }, platform: 'win32' }), null)
  const active = put(join(root, '2.1.0', 'ffuf.exe'))
  assert.equal(findArtexTool('ffuf', { env: { LOCALAPPDATA: home }, platform: 'win32' }), active)
})

test('custom ARTEX_TOOL_DIRS are searched before managed binaries', (t) => {
  const home = workspace(t)
  const custom = join(home, 'custom-tools')
  const customFile = put(join(custom, 'subfinder.exe'))
  put(join(home, 'ARTEX', 'tools', 'subfinder', 'current', 'subfinder.exe'))
  const env = { LOCALAPPDATA: home, ARTEX_TOOL_DIRS: custom }
  assert.equal(artexToolRoots(env)[0], custom)
  assert.equal(findArtexTool('subfinder', { env, platform: 'win32' }), customFile)
  assert.ok(ARTEX_SHARED_TOOLS.includes('subfinder'))
})

test('status separates live ARTEX from binary existence and never reports credentials', async (t) => {
  const home = workspace(t)
  const file = put(join(home, 'ARTEX', 'tools', 'dnsx', 'current', 'dnsx.exe'))
  const env = { LOCALAPPDATA: home, ARTEX_PG_DSN: 'postgres://private:key@host/db' }
  const live = await inspectArtex({ env, platform: 'win32', probe: async () => ({ version: '0.3-test' }) })
  assert.equal(live.ok, true)
  assert.equal(live.online, true)
  assert.equal(live.version, '0.3-test')
  assert.equal(live.toolCount, 1)
  assert.equal(live.tools[0].path, file)
  assert.ok(!JSON.stringify(live).includes('postgres://'))
  const offline = await inspectArtex({ env, platform: 'win32', probe: async () => null })
  assert.equal(offline.online, false)
  assert.equal(offline.toolCount, 1, 'installed tools remain reusable while service is stopped')
})

test('cleaning UI displays verified local ARTEX service and tool reuse without any auto-execute action', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(client, /function ArtexLinkSection\(\)/)
  assert.match(client, /apiJson\("\/dsh-purge\/artex"\)/)
  assert.match(client, /h\(ArtexLinkSection\)/)
  assert.match(client, /DSH 已复用/)
  assert.match(server, /path: "\/dsh-purge\/artex"/)
  assert.match(server, /const state = await inspectArtex\(\)/)
  assert.match(server, /reused: resolveTool\(item\.id\)\.path === item\.path/)
})
