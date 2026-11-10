import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reviewArtexSarif } from '../lib/redteam/artex-report-review.js'

const sample = {
  version: '2.1.0',
  runs: [{
    tool: { driver: { name: 'ARTEX', rules: [] } },
    results: [
      {
        ruleId: 'ARTEX-01', level: 'error', kind: 'fail',
        message: { text: 'Observed access control issue', markdown: 'PRIVATE_RAW_TRAFFIC' },
        partialFingerprints: { artexFindingId: '15' },
        properties: { findingId: 15, taskId: 3, assetIds: [6, 2], severity: 'critical', status: 'confirmed' },
      },
      {
        ruleId: 'ARTEX-02', level: 'note', kind: 'pass',
        message: { text: 'Previously fixed issue' },
        properties: { findingId: 16, taskId: null, severity: 'low', status: 'fixed' },
      },
      {
        ruleId: 'ARTEX-03', level: 'warning', kind: 'review',
        message: { text: 'Needs manual review' },
        properties: { findingId: 17, taskId: 4, assetIds: [11], severity: 'medium', status: 'pending' },
      },
    ],
  }],
}

test('ARTEX SARIF preserves finding, task, asset and triage lineage without inventing DSH verification', () => {
  const out = reviewArtexSarif(sample)
  assert.equal(out.source, 'ARTEX SARIF 2.1.0')
  assert.equal(out.read_only, true)
  assert.equal(out.artex_runs, 1)
  assert.equal(out.unique_findings, 3)
  assert.deepEqual({ ...out.status_counts }, { confirmed: 1, fixed: 1, pending: 1 })
  assert.deepEqual(out.items[0].asset_ids, [6, 2])
  assert.equal(out.items[0].task_id, 3)
  assert.equal(out.items[0].reported_status, 'confirmed')
  assert.equal(out.items[0].dsh_status, 'candidate')
  assert.equal(out.items[0].proof_included, false)
  assert.equal(out.independently_confirmed_by_dsh, 0)
  assert.equal(JSON.stringify(out).includes('PRIVATE_RAW_TRAFFIC'), false)
  assert.equal(out.items[1].reported_kind, 'pass')
  assert.equal(out.items[2].reported_status, 'pending')
})

test('duplicate rows and pagination do not undercount unique findings', () => {
  const copy = structuredClone(sample)
  copy.runs[0].results.push(structuredClone(copy.runs[0].results[0]))
  const result = reviewArtexSarif(copy, 1)
  assert.equal(result.unique_findings, 3)
  assert.equal(result.duplicates_skipped, 1)
  assert.equal(result.items.length, 1)
  assert.equal(result.omitted, 2)
})

test('reject malformed, foreign and ID-less reports rather than declaring zero findings', () => {
  assert.throws(() => reviewArtexSarif({}), /SARIF 2.1.0/)
  assert.throws(() => reviewArtexSarif({ version: '2.1.0', runs: [] }), /ARTEX/)
  assert.throws(() => reviewArtexSarif({ version: '2.1.0',
    runs: [{ tool: { driver: { name: 'Other' } }, results: [] }] }), /ARTEX/)
  const missing = structuredClone(sample)
  delete missing.runs[0].results[0].properties.findingId
  assert.throws(() => reviewArtexSarif(missing), /findingId/)
  const broken = structuredClone(sample)
  delete broken.runs[0].results
  assert.throws(() => reviewArtexSarif(broken), /missing results/)
  assert.throws(() => reviewArtexSarif(sample, 0), /limit/)
})

test('ARTEX report review route and embedded resource tab are both connected', () => {
  const server = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const rt = readFileSync(new URL('../lib/redteam/client.js', import.meta.url), 'utf8')
  const embedded = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(server, /path: "\/dsh-purge\/artex\/report-preview"/)
  assert.match(server, /reviewArtexSarif\(body\.sarif\)/)
  assert.match(rt, /\/dsh-purge\/artex\/report-preview/)
  assert.match(rt, /ARTEX SARIF 报告/)
  assert.match(embedded, /ARTEX SARIF 报告/)
})
