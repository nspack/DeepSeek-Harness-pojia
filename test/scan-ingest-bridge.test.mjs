import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('scan ingestion connects scanner format to the existing asset store', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'redteam-ingest-'))
  const previous = process.env.DSH_HOME
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  const module = join(home, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(module, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{}')
  writeFileSync(join(module, 'package.json'), '{"name":"@deepseek-ai/dsh-tools","main":"index.js"}')
  writeFileSync(join(module, 'index.js'), 'exports.defineTool = s => s\n')
  process.env.DSH_HOME = home
  const { apply } = await import('../lib/redteam/tools.js')
  const registry = new Map(), imports = []
  const store = {
    root: home,
    listEngagements: () => [{ id: 'demo' }],
    dirOf: id => join(home, 'engagements', id),
    importBundle: (id, bundle) => {
      imports.push({ id, bundle })
      return { scan_run_id: 7, counts: { assets: bundle.assets.length } }
    },
    assetStats: () => ({ total: 1 }),
  }
  apply({ redteam: store, tools: { register: x => registry.set(x.name, x) },
    on: () => () => {}, effect: fn => { const dispose = fn(); t.after(() => dispose?.()) } })
  const file = join(home, 'nmap.xml')
  writeFileSync(file, '<nmaprun><host><address addr="192.0.2.8" addrtype="ipv4"/>'
    + '<ports><port protocol="tcp" portid="443"><state state="open"/>'
    + '<service name="https"/></port></ports></host></nmaprun>')
  const result = JSON.parse(await registry.get('redteam_ingest').execute({
    engagement: 'demo', file, kind: 'nmap', commit: true,
    scanArgv: ['nmap', '-sT', '-sV', '-oX', '-', '192.0.2.8'],
  }, {}))
  assert.equal(result.ok, true)
  assert.equal(result.assets, 1)
  assert.equal(result.ports, 1)
  assert.equal(imports[0].bundle.assets[0].ports[0].port, 443)
  assert.equal(imports[0].bundle.scan.argv[0], 'nmap')
  const bad = JSON.parse(await registry.get('redteam_scan_run').execute({
    engagement: '../escape', kind: 'nmap', target: '192.0.2.8',
  }, {}))
  assert.equal(bad.ok, false)
  assert.match(bad.error, /engagement not found/)
})
