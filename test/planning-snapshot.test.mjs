import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { RedteamStore, dispatch } from '../lib/redteam/store-core.js'
import { compactVuln } from '../lib/redteam/query-options.js'
import { reviewCandidateQueue, reviewScoring } from '../lib/redteam/score-triage.js'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec([
    'CREATE TABLE asset (id INTEGER PRIMARY KEY, ip TEXT, state TEXT, test_status TEXT, priority TEXT, segment_cidr TEXT, test_notes TEXT, test_surface TEXT, test_updated_at TEXT)',
    'CREATE TABLE vuln (id INTEGER PRIMARY KEY, asset_id INTEGER, title TEXT, severity TEXT, status TEXT, evidence TEXT, gained TEXT, cve TEXT, target TEXT)',
    'CREATE TABLE http_evidence (id INTEGER PRIMARY KEY, vuln_id INTEGER, asset_id INTEGER, label TEXT, method TEXT, url TEXT, status INTEGER, request TEXT, response TEXT, note TEXT, captured_by TEXT, captured_at TEXT)',
    'CREATE INDEX idx_http_evidence_vuln ON http_evidence(vuln_id)',
  ].join(';') + ';')
  const addAsset = db.prepare("INSERT INTO asset(id, ip, state, test_status, priority) VALUES (?, ?, 'live', 'untested', 'medium')")
  const addVuln = db.prepare("INSERT INTO vuln(id, asset_id, title, severity, status, evidence) VALUES (?, ?, ?, 'low', 'candidate', '')")
  db.exec('BEGIN')
  try {
    for (let i = 1; i <= 2105; i++) addAsset.run(i, '192.0.2.' + i)
    for (let i = 1; i <= 1103; i++) addVuln.run(i, i === 1 ? 2105 : 1, 'finding-' + i)
    db.exec("INSERT INTO http_evidence(vuln_id, note) VALUES (1, 'actual observation'), (2, '')")
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    db.close()
    throw error
  }
  return { db, store: { db: () => db } }
}

test('planning snapshot includes entries past previous 2000/1000 caps without loading raw HTTP data', () => {
  const { db, store } = fixture()
  try {
    const view = RedteamStore.prototype.planningSnapshot.call(store, 'lab')
    assert.equal(view.assetCount, 2105)
    assert.equal(view.vulnCount, 1103)
    assert.equal(view.assets.length, 2105)
    assert.equal(view.vulns.length, 1103)
    assert.equal(view.assets.some((asset) => asset.id === 2105), true)

    const last = view.vulns.find((v) => v.id === 1)
    assert.equal(last.asset_id, 2105)
    assert.equal(last.has_http_evidence, 1)
    assert.equal(Object.hasOwn(last, 'http_evidence'), false)
    assert.equal(view.vulns.find((v) => v.id === 2).has_http_evidence, 0)
    const queue = reviewCandidateQueue(view.vulns, view.assets)
    assert.deepEqual(queue.ready.map((v) => v.vuln_id), [1])
    assert.equal(queue.needs_evidence.length, 1102)
    assert.equal(queue.needs_scope.length, 0)

    const review = reviewScoring([{
      ...last, status: 'confirmed', gained: '服务器权限',
    }], { items: [{ code: 'server-host', enabled: true, points: 50, hits: [] }] },
    [{ code: 'server-host', re: /服务器权限/ }])
    assert.equal(review.review_ready, 1)
  } finally {
    db.close()
  }
})

test('vulnerability offset pagination reaches rows past 1000 and reports true continuation', () => {
  const { db, store } = fixture()
  try {
    const page = RedteamStore.prototype.listVulns.call(store, 'lab', { limit: 200, offset: 1000 })
    assert.equal(page.total, 1103)
    assert.equal(page.items.length, 103)
    assert.equal(page.items[0].id, 103)
    assert.equal(page.items.at(-1).id, 1)
    assert.equal(page.offset, 1000)
    assert.equal(page.returned, 103)
    assert.equal(page.hasMore, false)
    assert.equal(page.nextOffset, null)

    const first = RedteamStore.prototype.listVulns.call(store, 'lab', { limit: 200, offset: 0 })
    assert.equal(first.nextOffset, 200)
    assert.equal(first.hasMore, true)
    assert.throws(() => RedteamStore.prototype.listVulns.call(store, 'lab', { offset: -1 }), /offset/)
  } finally {
    db.close()
  }
})



test('vulnerability task ID is directly queryable beyond first page, with consistent filters', () => {
  const { db, store } = fixture()
  try {
    const exact = RedteamStore.prototype.listVulns.call(store, 'lab', { id: 1, limit: 50 })
    assert.equal(exact.total, 1)
    assert.deepEqual(exact.items.map((item) => item.id), [1])
    assert.equal(exact.items[0].asset_id, 2105)
    assert.equal(exact.items[0].http_evidence[0].note, 'actual observation')
    assert.equal(exact.hasMore, false)
    const middle = RedteamStore.prototype.listVulns.call(store, 'lab', { id: 1030 })
    assert.deepEqual(middle.items.map((item) => item.id), [1030])
    const absent = RedteamStore.prototype.listVulns.call(store, 'lab', { id: 1, status: 'confirmed' })
    assert.equal(absent.total, 0)
    assert.deepEqual(absent.items, [])
    assert.equal(RedteamStore.prototype.listVulns.call(store, 'lab', { id: 999999 }).total, 0)
    assert.throws(() => RedteamStore.prototype.listVulns.call(store, 'lab', { id: -1 }), /vuln id/)
    assert.throws(() => RedteamStore.prototype.listVulns.call(store, 'lab', { id: 1.5 }), /vuln id/)
  } finally {
    db.close()
  }
})

test('taskBrief shows factual active and blocked notes alongside evidence gaps', () => {
  const { db } = fixture()
  const store = {
    db: () => db,
    planningSnapshot: RedteamStore.prototype.planningSnapshot,
    testStats: RedteamStore.prototype.testStats,
    taskBrief: RedteamStore.prototype.taskBrief,
    // taskBrief now also consults the current project's (empty in this fixture) scan history.
    listEngagements: () => [{ id: 'lab' }],
    dirOf: () => process.cwd() + '/__planning_fixture_without_scan_runs__',
  }
  try {
    db.prepare("UPDATE asset SET test_status='testing', test_notes=?, test_updated_at=? WHERE id=4")
      .run('[time] started\n[time] checking services', '2026-11-08T08:00:00Z')
    db.prepare("UPDATE asset SET test_status='blocked', test_notes=?, test_surface=? WHERE id=5")
      .run('[time] requires access approval', 'service unreachable')
    const result = dispatch(store, { op: 'taskBrief', engagement: 'lab' })
    assert.equal(result.ok, true)
    assert.equal(result.engagement, 'lab')
    assert.equal(result.active[0].id, 4)
    assert.equal(result.active[0].note, '[time] checking services')
    assert.equal(result.blocked[0].id, 5)
    assert.equal(result.blocked[0].note, '[time] requires access approval')
    assert.equal(result.counts.blocked, 1)
    assert.equal(result.counts.ready, 1)
    assert.equal(result.counts.needs_evidence, 1102)
    assert.equal(result.suggestion.target, 'vuln #1')
    assert.equal(result.suggestion.tab, 'findings')
    assert.match(result.note, /只读核查建议/)
  } finally {
    db.close()
  }
})

test('vulnerability list summary omits large HTTP bodies without losing evidence counts', () => {
  const { db, store } = fixture()
  try {
    const payload = 'GET /proof HTTP/1.1\n' + 'x'.repeat(70000)
    db.prepare('UPDATE http_evidence SET request = ? WHERE vuln_id = 1').run(payload)
    const page = RedteamStore.prototype.listVulns.call(store, 'lab', {
      limit: 50, offset: 0, withHttpEvidence: false,
    })
    assert.equal(page.total, 1103)
    assert.equal(page.items.length, 50)
    assert.equal(Object.hasOwn(page.items[0], 'http_evidence'), false)
    const one = RedteamStore.prototype.listVulns.call(store, 'lab', {
      id: 1, withHttpEvidence: false,
    })
    assert.equal(one.items[0].http_evidence_count, 1)
    assert.equal(Object.hasOwn(one.items[0], 'http_evidence'), false)
    const summary = compactVuln(one.items[0])
    assert.equal(summary.id, 1)
    assert.equal(summary.evidence_present, true)
    assert.equal(summary.http_evidence_count, 1)
    assert.equal(Object.hasOwn(summary, 'http_evidence'), false)
    assert.equal(JSON.stringify(summary).includes('/proof'), false)
    const empty = RedteamStore.prototype.listVulns.call(store, 'lab', {
      id: 2, withHttpEvidence: false,
    })
    assert.equal(empty.items[0].http_evidence_count, 0)
    assert.equal(compactVuln(empty.items[0]).evidence_present, false)
    const full = RedteamStore.prototype.listVulns.call(store, 'lab', { id: 1 })
    assert.equal(full.items[0].http_evidence.length, 1)
    assert.match(full.items[0].http_evidence[0].request, /truncated/)
  } finally {
    db.close()
  }
})

test('asset query open-port and test-status filters do not include closed ports', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec([
      'CREATE TABLE asset (id INTEGER PRIMARY KEY, ip TEXT, ip_int INTEGER, state TEXT, test_status TEXT, priority TEXT, discovered_at TEXT, first_seen TEXT)',
      'CREATE TABLE port (id INTEGER PRIMARY KEY, asset_id INTEGER, port INTEGER, state TEXT)',
      "INSERT INTO asset VALUES (1, '192.0.2.1', 1, 'live', 'untested', 'high', '2026-11-06', '2026-11-06')",
      "INSERT INTO asset VALUES (2, '192.0.2.2', 2, 'live', 'blocked', 'high', '2026-11-08', '2026-11-08')",
      "INSERT INTO asset VALUES (3, '192.0.2.3', 3, 'live', 'tested', 'medium', '2026-11-07', '2026-11-07')",
      "INSERT INTO port VALUES (1, 1, 443, 'open')",
      "INSERT INTO port VALUES (2, 2, 443, 'closed')",
      "INSERT INTO port VALUES (3, 3, 80, 'open')",
    ].join('; ') + ';')
    const store = {
      db: () => db,
      assetChildren: () => ({ ports: new Map(), names: new Map(), fingerprints: new Map() }),
      assetRow: (_db, row) => ({ id: row.id, ip: row.ip, test_status: row.test_status }),
    }
    const query = (options) => RedteamStore.prototype.listAssets.call(store, 'lab', options)
    assert.deepEqual(query({ port: 443, sort: 'ip' }).items.map((row) => row.id), [1])
    assert.deepEqual(query({ test_status: 'blocked' }).items.map((row) => row.id), [2])
    assert.deepEqual(query({ port: 443, test_status: 'blocked' }).items, [])
    assert.deepEqual(query({ ip: '192.0.2.3' }).items.map((row) => row.id), [3])
    assert.deepEqual(query({ sort: 'discovered' }).items.map((row) => row.id), [2, 3, 1])
  } finally {
    db.close()
  }
})

test('HTTP evidence query returns paged summaries and exact ID detail, preserving unrelated records', () => {
  const { db, store } = fixture()
  const selected = {
    ...store,
    queryHttpEvidence: RedteamStore.prototype.queryHttpEvidence,
  }
  try {
    const request = 'GET /private HTTP/1.1\\nHost: example.test\\n' + 'x'.repeat(65000)
    db.prepare('UPDATE http_evidence SET asset_id = ?, request = ?, response = ? WHERE vuln_id = 1')
      .run(2105, request, 'response'.repeat(10000))
    const listing = RedteamStore.prototype.queryHttpEvidence.call(selected, 'lab', { limit: 1 })
    assert.equal(listing.detail, 'summary')
    assert.equal(listing.total, 2)
    assert.equal(listing.returned, 1)
    assert.equal(listing.nextOffset, 1)
    assert.equal(Object.hasOwn(listing.items[0], 'request'), false)
    assert.equal(Object.hasOwn(listing.items[0], 'response'), false)
    assert.equal(JSON.stringify(listing).includes('/private'), false)

    const byVuln = selected.queryHttpEvidence('lab', { vuln_id: 1 })
    assert.equal(byVuln.total, 1)
    assert.equal(byVuln.items[0].asset_id, 2105)
    assert.equal(byVuln.items[0].has_request, true)
    assert.equal(byVuln.items[0].request_chars, request.length)
    const byAsset = selected.queryHttpEvidence('lab', { asset_id: 2105 })
    assert.equal(byAsset.total, 1)
    assert.equal(byAsset.items[0].vuln_id, 1)

    const full = selected.queryHttpEvidence('lab', { id: byVuln.items[0].id })
    assert.equal(full.detail, 'full')
    assert.equal(full.total, 1)
    assert.equal(full.items[0].request.startsWith('GET /private'), true)
    assert.match(full.items[0].request, /truncated/)
    assert.match(full.items[0].response, /truncated/)
    assert.equal(selected.queryHttpEvidence('lab', { id: 99999 }).total, 0)
    assert.equal(selected.queryHttpEvidence('lab', { offset: 10 }).hasMore, false)
    assert.throws(() => selected.queryHttpEvidence('lab', { detail: 'full' }), /requires an exact evidence id/)
    assert.throws(() => selected.queryHttpEvidence('lab', { id: -5 }), /positive safe integer/)
    assert.throws(() => selected.queryHttpEvidence('lab', { vuln_id: 1.3 }), /positive safe integer/)
    assert.throws(() => selected.queryHttpEvidence('lab', { offset: -1 }), /offset/)
  } finally {
    db.close()
  }
})

