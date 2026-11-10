import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  artexToolRoots, findArtexTool, inspectArtex, probeLocalArtex, ARTEX_SHARED_TOOLS,
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

test('optional ARTEX_HOME shares portable tools from data/tools and tools', (t) => {
  const home = workspace(t)
  const portable = join(home, 'ARTEX-portable')
  const dataTool = put(join(portable, 'data', 'tools', 'katana', 'current', 'katana.exe'))
  const fallbackTool = put(join(portable, 'tools', 'subfinder', '2.1.0', 'subfinder.exe'))
  const env = { ARTEX_HOME: portable, PATH: '' }
  assert.equal(findArtexTool('katana', { env, platform: 'win32' }), dataTool)
  assert.equal(findArtexTool('subfinder', { env, platform: 'win32' }), fallbackTool)
  const resolved = resolveTool('katana', {
    root: join(home, 'dsh', 'redteam'),
    config: { platform: 'windows', toolkitDir: join(home, 'empty'), binDirs: [], tools: {} },
    env,
  })
  assert.equal(resolved.source, 'artex')
  assert.equal(resolved.path, dataTool)
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

test('ARTEX is mounted in the RedTeam Resources tab and uses the existing read-only bridge', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../lib/redteam/client.js', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(source, /function ArtexTab\(\)/)
  assert.match(source, /\['artex', 'ARTEX'\]/)
  assert.match(source, /else if \(st\.tab === 'artex'\) body = h\(ArtexTab\)/)
  assert.match(client, /function ArtexTab\(\)/)
  assert.doesNotMatch(client, /function ArtexLinkSection\(\)/)
  assert.match(client, /fetch\('\/dsh-purge\/artex', \{ method: 'GET' \}\)/)
  assert.match(server, /path: "\/dsh-purge\/artex"/)
  assert.match(server, /const state = await inspectArtex\(\)/)
  assert.match(server, /reused: resolveTool\(item\.id\)\.path === item\.path/)
})

test('local health distinguishes verified ARTEX from authenticated or unrelated services', async () => {
  const examples = [
    { status: 200, body: { ok: true, service: 'artex', version: '0.5' },
      expected: 'detected' },
    { status: 200, body: { ok: false, service: 'artex' }, expected: 'degraded' },
    { status: 200, body: { ok: true, service: 'other' }, expected: 'service_candidate' },
    { status: 200, body: { ok: true }, expected: 'service_candidate' },
    { status: 401, body: {}, expected: 'service_candidate' },
    { status: 403, body: {}, expected: 'service_candidate' },
    { status: 404, body: {}, expected: 'service_candidate' },
    { status: 302, body: {}, expected: 'service_candidate' },
  ]
  for (const item of examples) {
    const got = await probeLocalArtex({ fetchFn: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:8787/api/health')
      assert.equal(options.method, 'GET')
      assert.equal(options.redirect, 'manual')
      assert.equal(options.headers, undefined, 'no ARTEX credentials are forwarded')
      return {
        status: item.status,
        ok: item.status >= 200 && item.status < 300,
        json: async () => item.body,
      }
    } })
    assert.equal(got.state, item.expected, 'HTTP ' + item.status + ' / ' + JSON.stringify(item.body))
    assert.equal(got.httpStatus, item.status)
  }
})

test('malformed health and connection errors do not disrupt DSH', async () => {
  const malformed = await probeLocalArtex({ fetchFn: async () => ({
    status: 200, ok: true, json: async () => { throw new SyntaxError('malformed') },
  }) })
  assert.equal(malformed.state, 'service_candidate')
  const unreachable = await probeLocalArtex({ fetchFn: async () => { throw new Error('ECONNREFUSED') } })
  assert.equal(unreachable.state, 'absent')
  assert.equal(unreachable.httpStatus, null)
  assert.ok(!JSON.stringify(unreachable).includes('ECONNREFUSED'))
})

test('protected endpoint is only an unverified candidate and does not authorize ARTEX UI actions', async (t) => {
  const home = workspace(t)
  put(join(home, 'ARTEX', 'tools', 'nuclei', 'current', 'nuclei.exe'))
  const status = await inspectArtex({
    env: { LOCALAPPDATA: home },
    platform: 'win32',
    probe: async () => ({ state: 'service_candidate', httpStatus: 401, reason: 'authentication required' }),
  })
  assert.equal(status.online, false)
  assert.equal(status.state, 'service_candidate')
  assert.equal(status.httpStatus, 401)
  assert.equal(status.toolCount, 1)
})

test('tool files without a responding service are shown installed/offline, not connected', async (t) => {
  const home = workspace(t)
  put(join(home, 'ARTEX', 'tools', 'dnsx', 'current', 'dnsx.exe'))
  const status = await inspectArtex({
    env: { LOCALAPPDATA: home }, platform: 'win32',
    probe: async () => ({ state: 'absent', httpStatus: null }),
  })
  assert.equal(status.state, 'installed_offline')
  assert.equal(status.online, false)
  assert.equal(status.toolCount, 1)
})

test('RedTeam ARTEX tab distinguishes unverified and offline service states', () => {
  const source = readFileSync(new URL('../lib/redteam/client.js', import.meta.url), 'utf8')
  assert.match(source, /service_candidate: '8787 端口有响应/)
  assert.match(source, /installed_offline: 'ARTEX 本机工具已发现/)
  assert.match(source, /state && state\.online \? h\('a'/)
  assert.match(source, /找到文件不代表可执行已验证/)
})
