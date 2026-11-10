/**
 * 数据质量的两个新计数（旧实现看不见的两类交付缺件）：
 *   · unlinkedHttpEvidence      —— 证据在，但没挂到任何漏洞，报告里对不上结论；
 *   · confirmedWithoutHttpEvidence —— 漏洞已确认，却一条原始请求都没有，不可复现。
 * 旧实现只数"悬空外键"，因此这两种情况会一路绿灯。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RedteamStore } from '../lib/redteam/store-core.js'

function storeInTemp(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dq-'))
  const store = new RedteamStore(root)
  t.after(() => {
    try { store.close() } catch { /* 已关闭 */ }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  return store
}

test('孤儿证据与"确认但无原始请求"都会让质量检查亮灯', t => {
  const store = storeInTemp(t)
  const { id } = store.openEngagement('QualityFixture', [])
  store.addVuln(id, { title: 'confirmed 但没有原始请求', severity: 'high', status: 'confirmed', evidence: '只有一句结论' })
  store.addHttpEvidence(id, { label: '没挂漏洞的证据', method: 'GET', url: 'http://192.0.2.1/a', request: 'GET /a', response: '200' })

  const report = store.dataQuality(id)
  assert.equal(report.counts.confirmedWithoutHttpEvidence, 1)
  assert.equal(report.counts.unlinkedHttpEvidence, 1)
  assert.equal(report.status, 'attention')
  assert.ok(report.issues.some((item) => item.code === 'confirmedWithoutHttpEvidence'))
  assert.ok(report.issues.some((item) => item.code === 'unlinkedHttpEvidence'))
})

test('把证据挂回漏洞后计数归零、重新变绿', t => {
  const store = storeInTemp(t)
  const { id } = store.openEngagement('QualityFixed', [])
  const vuln = store.addVuln(id, { title: '补过证据的漏洞', severity: 'high', status: 'confirmed', evidence: '结论' })
  const evidence = store.addHttpEvidence(id, {
    vuln_id: vuln.id, label: '原始请求', method: 'GET', url: 'http://192.0.2.1/b',
    request: 'GET /b HTTP/1.1', response: 'HTTP/1.1 200 OK',
  })
  assert.ok(evidence.id > 0)

  const report = store.dataQuality(id)
  assert.equal(report.counts.confirmedWithoutHttpEvidence, 0)
  assert.equal(report.counts.unlinkedHttpEvidence, 0)
  assert.equal(report.status, 'no_issues_detected')
})
