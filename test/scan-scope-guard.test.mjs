/**
 * 扫描范围门禁：这个函数决定 `redteam_scan_run` 会不会真的对某个目标发流量。
 * 旧实现完全没有校验——模型写错一个 IP 就会扫到无关资产。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { targetInScope } from '../lib/redteam/scan-runner.js'

test('登记了 scope：范围内放行，范围外拒绝', () => {
  const scopes = ['192.0.2.0/24', 'example.test', '*.lab.example.test']
  assert.equal(targetInScope(scopes, '192.0.2.10').ok, true)
  assert.equal(targetInScope(scopes, '192.0.2.10').reason, 'ip-matched')
  assert.equal(targetInScope(scopes, 'https://example.test/x').ok, true)
  assert.equal(targetInScope(scopes, 'a.lab.example.test').ok, true)
  assert.equal(targetInScope(scopes, 'a.lab.example.test').reason, 'name-only')

  const outside = targetInScope(scopes, '198.51.100.7')
  assert.equal(outside.ok, false)
  assert.equal(outside.reason, 'outside-scope')
  assert.deepEqual(outside.scopes, scopes)

  assert.equal(targetInScope(scopes, 'evil.test').ok, false)
})

test('没登记 scope：默认拒绝，显式 confirm 才放行', () => {
  assert.deepEqual(targetInScope([], '192.0.2.10'), { ok: false, reason: 'scope-empty-needs-confirm' })
  assert.equal(targetInScope([], '192.0.2.10', { confirm: true }).ok, true)
  assert.equal(targetInScope([], '192.0.2.10', { confirm: true }).reason, 'scope-empty-confirmed')
  /* 空字符串 / 空白项不算登记 */
  assert.equal(targetInScope(['   ', ''], '192.0.2.10').ok, false)
})

test('空目标一律拒绝，不因 scope 为空就放过', () => {
  assert.equal(targetInScope(['192.0.2.0/24'], '').ok, false)
  assert.equal(targetInScope([], '').ok, false)
  assert.equal(targetInScope([], '   ', { confirm: true }).ok, false)
})

test('IPv6 scope 也能匹配', () => {
  const scopes = ['2001:db8::/32']
  assert.equal(targetInScope(scopes, '2001:db8::1').ok, true)
  assert.equal(targetInScope(scopes, '2001:db9::1').ok, false)
})
