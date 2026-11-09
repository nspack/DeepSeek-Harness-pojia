import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeScanFeedback, scanFeedbackTask, matchTaskScan } from '../lib/redteam/scan-feedback.js'

const row = (run_id, kind, target, status, extra = {}) => ({
  run_id, kind, target, status, ...extra,
})

test('recent run wins for the same exact target and tool; repeated attempts stay visible', () => {
  const summary = summarizeScanFeedback([
    row('2026-11-10T02-00-00-000Z-aaaaaaaa', 'nmap', '192.0.2.7', 'imported', { assets: 1 }),
    row('2026-11-10T01-00-00-000Z-bbbbbbbb', 'nmap', '192.0.2.7', 'failed'),
    row('2026-11-10T00-00-00-000Z-cccccccc', 'httpx', '192.0.2.7', 'previewed'),
  ])
  assert.equal(summary.total_scans, 3)
  assert.equal(summary.distinct_targets, 2)
  assert.equal(summary.repeated_targets, 1)
  assert.equal(summary.latest.status, 'imported')
  assert.equal(summary.latest.attempts, 2)
  assert.equal(summary.pending_review, 1)
  assert.equal(summary.recommendation.status, 'previewed')
  assert.equal(scanFeedbackTask(summary).tool.includes('redteam_scan_history'), true)
})

test('only most recent state per target is actionable, with failures requiring review, never silent retry', () => {
  const feedback = summarizeScanFeedback([
    row('2026-11-10T04-00-00-000Z-aaaaaaaa', 'httpx', 'https://x.example', 'import-failed'),
    row('2026-11-10T03-00-00-000Z-bbbbbbbb', 'nmap', '192.0.2.3', 'timeout'),
    row('2026-11-10T02-00-00-000Z-cccccccc', 'nmap', '192.0.2.4', 'no-findings'),
    row('2026-11-10T01-00-00-000Z-dddddddd', 'nmap', '192.0.2.5', 'imported'),
  ])
  assert.equal(feedback.pending_review, 3)
  assert.equal(feedback.recommendation.status, 'import-failed')
  const task = scanFeedbackTask(feedback)
  assert.equal(task.priority, 2)
  assert.match(task.why, /不重新扫描/)
  assert.equal(task.target, 'scan #2026-11-10T04-00-00-000Z-aaaaaaaa')
  assert.equal(scanFeedbackTask(summarizeScanFeedback([])), null)
})

test('asset task keeps its original action and tool but annotates existing scan evidence', () => {
  const feedback = summarizeScanFeedback([
    row('2026-11-10T02-00-00-000Z-aaaaaaaa', 'nmap', '192.0.2.7', 'imported'),
  ])
  const items = matchTaskScan([
    { action: '漏洞发现', target: 'asset #7', why: '等待核对', tool: 'redteam_task_context' },
    { action: '漏洞发现', target: 'asset #8', why: '等待核对', tool: 'redteam_task_context' },
  ], [{ id: 7, ip: '192.0.2.7' }, { id: 8, ip: '192.0.2.8' }], feedback)
  assert.equal(items[0].prior_scan.status, 'imported')
  assert.match(items[0].why, /先用 redteam_scan_history/)
  assert.equal(items[0].tool, 'redteam_task_context')
  assert.equal(items[1].prior_scan, undefined)
  assert.equal(items[1].why, '等待核对')
})

test('later successful run cancels old failure for the same target', () => {
  const state = summarizeScanFeedback([
    row('2026-11-10T02-00-00-000Z-aaaaaaaa', 'httpx', 'https://x.example', 'imported'),
    row('2026-11-10T01-00-00-000Z-bbbbbbbb', 'httpx', 'https://x.example', 'failed'),
  ])
  assert.equal(state.pending_review, 0)
  assert.equal(state.recommendation, null)
  assert.equal(state.repeated_targets, 1)
})

test('next-action, overview, and embedded UI share the scan feedback flow', async () => {
  const { readFileSync } = await import('node:fs')
  const store = readFileSync(new URL('../lib/redteam/store-core.js', import.meta.url), 'utf8')
  const tools = readFileSync(new URL('../lib/redteam/tools.js', import.meta.url), 'utf8')
  const ui = readFileSync(new URL('../lib/redteam/client.js', import.meta.url), 'utf8')
  const embedded = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(store, /scanFeedback = listScanHistory\(this, id/)
  assert.match(store, /scan_feedback:/)
  assert.match(tools, /const scanFollowup = scanFeedbackTask\(scanFeedback\)/)
  assert.match(tools, /matchTaskScan\(acts, assets, scanFeedback\)/)
  for (const client of [ui, embedded]) {
    assert.match(client, /扫描历史与反馈/)
    assert.match(client, /重复目标/)
  }
})
