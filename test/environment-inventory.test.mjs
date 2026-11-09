import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { TOOL_CATALOG, resolveTool, scanFolderForTools } from '../lib/redteam/platform-config.js'
import { ARTEX_SHARED_TOOLS } from '../lib/artex-integration.js'
import { probeInstalledTool } from '../lib/redteam/tool-health.js'

const create = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'redteam-tool-inventory-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
const put = (file) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'fixture')
  return file
}

test('all ARTEX supported binaries have DSH catalog entries (including naabu/katana)', () => {
  const ids = TOOL_CATALOG.map((x) => x.id)
  assert.equal(ids.length, 17)
  assert.equal(new Set(ids).size, ids.length)
  for (const name of ARTEX_SHARED_TOOLS) assert.ok(ids.includes(name), name)
})

test('folder assignment and ARTEX fallback find newly covered tools', (t) => {
  const root = create(t)
  const naabu = put(join(root, 'bundle', 'naabu.exe'))
  const katana = put(join(root, 'bundle', 'katana.exe'))
  const scan = scanFolderForTools(root)
  assert.equal(scan.assigned.naabu, naabu)
  assert.equal(scan.assigned.katana, katana)
  const artexHome = create(t)
  const artexNaabu = put(join(artexHome, 'ARTEX', 'tools', 'naabu', 'current', 'naabu.exe'))
  const tool = resolveTool('naabu', {
    config: { platform: 'windows', toolkitDir: join(root, 'missing'), tools: {}, binDirs: [] },
    root: join(root, 'redteam'), env: { LOCALAPPDATA: artexHome, PATH: '' },
  })
  assert.equal(tool.source, 'artex')
  assert.equal(tool.path, artexNaabu)
})

test('version probe is explicit, id-based, and never invokes an absent or unknown binary', async (t) => {
  const root = create(t)
  const file = put(join(root, 'tools', 'katana.exe'))
  let called = 0
  const options = {
    root, config: { platform: 'windows', tools: { katana: file }, toolkitDir: root, binDirs: [] },
    execFileFn: (exe, args, opts, done) => {
      called += 1
      assert.equal(exe, file)
      assert.deepEqual(args, ['-version'])
      assert.equal(opts.shell, false)
      assert.equal(opts.timeout, 3000)
      done(null, 'katana version 1.2.3\n', '')
    },
  }
  const ok = await probeInstalledTool('katana', options)
  assert.equal(ok.status, 'runnable')
  assert.equal(ok.version, 'katana version 1.2.3')
  assert.equal(called, 1)
  const unknown = await probeInstalledTool('../../escape', options)
  assert.equal(unknown.status, 'unknown')
  const missing = await probeInstalledTool('naabu', {
    root, config: { platform: 'windows', tools: {}, toolkitDir: root, binDirs: [] }, env: { PATH: '' },
    execFileFn: () => { throw new Error('must not execute') },
  })
  assert.equal(missing.status, 'missing')
  assert.equal(called, 1)
})

test('unsupported version flags are not guessed; executable failure remains distinct from path discovery', async (t) => {
  const root = create(t), file = put(join(root, 'fscan.exe'))
  const skipped = await probeInstalledTool('fscan', {
    root, config: { tools: { fscan: file } },
    execFileFn: () => { throw new Error('not called') },
  })
  assert.equal(skipped.status, 'path-only')
  const fail = await probeInstalledTool('nmap', {
    root, config: { tools: { nmap: file } },
    execFileFn: (_exe, _args, _opts, done) => done(new Error('bad binary'), '', ''),
  })
  assert.equal(fail.status, 'failed')
})
