import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listScanHistory, inspectScanArtifact } from '../lib/redteam/scan-history.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'redteam-scan-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dirOf = (id) => join(root, id)
  const store = { dirOf, listEngagements: () => [{ id: 'alpha' }, { id: 'beta' }] }
  const write = (eng, id, kind, status, payload, result = {}) => {
    const dir = join(dirOf(eng), 'scan-output')
    mkdirSync(dir, { recursive: true })
    const ext = kind === 'nmap' ? 'xml' : 'jsonl'
    writeFileSync(join(dir, id + '.' + ext), payload)
    const bytes = Buffer.byteLength(payload)
    const sha256 = createHash('sha256').update(payload).digest('hex')
    writeFileSync(join(dir, id + '.json'), JSON.stringify({
      runId: id, kind, status, target: '192.0.2.1', bytes, sha256,
      outputFile: join(dir, id + '.' + ext), startedAt: '2026-11-09T00:00:00Z',
      finishedAt: '2026-11-09T00:00:20Z', ingestion: result, ingested: status === 'imported',
    }))
  }
  return { store, write, root }
}
const ONE = '2026-11-09T01-00-00-000Z-aaaaaaaa'
const TWO = '2026-11-09T02-00-00-000Z-bbbbbbbb'

test('list is scoped, sorted, paged and describes ingestion without claiming verification', (t) => {
  const { store, write } = fixture(t)
  write('alpha', ONE, 'nmap', 'imported', '<nmaprun/>',
    { assets: 2, ports: 4, imported: { scan_run_id: 19 } })
  write('alpha', TWO, 'httpx', 'failed', 'error')
  write('beta', TWO, 'nmap', 'imported', '<nmaprun/>', { assets: 100 })
  const list = listScanHistory(store, 'alpha', { limit: 1 })
  assert.equal(list.total, 2)
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].status, 'failed')
  assert.equal(listScanHistory(store, 'alpha', { offset: 1 }).items[0].scan_run_id, 19)
  assert.equal(listScanHistory(store, 'alpha', { status: 'imported' }).total, 1)
  assert.equal(listScanHistory(store, 'beta').total, 1)
  assert.throws(() => listScanHistory(store, '../alpha'), /engagement not found/)
})

test('artifact checksum verification catches changes and refuses invalid IDs', async (t) => {
  const { store, write, root } = fixture(t)
  write('alpha', ONE, 'nmap', 'imported', '<nmaprun/>')
  const verified = await inspectScanArtifact(store, 'alpha', ONE)
  assert.equal(verified.status, 'verified')
  assert.equal(verified.ok, true)
  writeFileSync(join(root, 'alpha', 'scan-output', ONE + '.xml'), 'modified')
  const changed = await inspectScanArtifact(store, 'alpha', ONE)
  assert.equal(changed.status, 'changed')
  assert.equal(changed.ok, false)
  await assert.rejects(() => inspectScanArtifact(store, 'alpha', '../secret'), /invalid scan run id/)
  assert.equal((await inspectScanArtifact(store, 'alpha', TWO)).status, 'not-found')
})

test('unreadable manifest is reported, not silently counted as successful scan', (t) => {
  const { store, write, root } = fixture(t)
  write('alpha', ONE, 'nmap', 'imported', '<nmaprun/>')
  const path = join(root, 'alpha', 'scan-output', TWO + '.json')
  writeFileSync(path, '{bad json')
  const items = listScanHistory(store, 'alpha')
  assert.equal(items.total, 1)
  assert.equal(items.unreadable, 1)
  assert.equal(items.items[0].next.includes('核对'), true)
})

test('workbench API uses the same scan history records as the agent', async (t) => {
  const { store, write } = fixture(t)
  write('alpha', ONE, 'nmap', 'imported', '<nmaprun/>', { assets: 1 })
  const { dispatch, dispatchAsync } = await import('../lib/redteam/store-core.js')
  const list = dispatch(store, { op: 'scanHistory', engagement: 'alpha' })
  assert.equal(list.ok, true)
  assert.equal(list.total, 1)
  assert.equal(list.items[0].run_id, ONE)
  const check = await dispatchAsync(store, {
    op: 'scanArtifactInspect', engagement: 'alpha', run_id: ONE,
  })
  assert.equal(check.status, 'verified')
  const missing = await dispatchAsync(store, {
    op: 'scanArtifactInspect', engagement: 'unknown', run_id: ONE,
  })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /engagement not found/)
})

test('scan history is exposed in workbench navigation and model tool list', async () => {
  const { readFileSync } = await import('node:fs')
  const frontend = readFileSync(new URL('../lib/redteam/client.js', import.meta.url), 'utf8')
  const built = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const tool = readFileSync(new URL('../lib/redteam/tools.js', import.meta.url), 'utf8')
  for (const code of [frontend, built]) {
    assert.match(code, /function ScanHistoryTab/)
    assert.match(code, /scanArtifactInspect/)
    assert.match(code, /\['scan-history', '扫描记录'\]/)
  }
  assert.match(tool, /name: 'redteam_scan_history'/)
})
