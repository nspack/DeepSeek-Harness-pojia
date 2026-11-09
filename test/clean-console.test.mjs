import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function isolated(name, next, globals = {}) {
  const from = client.indexOf('\t\tfunction ' + name + '(')
  const to = client.indexOf('\t\tfunction ' + next + '(', from)
  assert.ok(from > 0 && to > from, name + ' must be defined before ' + next)
  return runInNewContext('(' + client.slice(from, to).trim() + ')', globals)
}

const filterPatchRows = isolated('filterPatchRows', 'formatPatchDiagnostics')
const formatPatchDiagnostics = isolated('formatPatchDiagnostics', 'PatchGroups', {
  tallyPatches: (rows) => rows.reduce((o, row) => {
    o.total += 1
    if (row.st === 'applied' || row.st === 'already') o.applied += 1
    else if (row.st === 'pending') o.pending += 1
    else if (row.st === 'unmatched') o.unmatched += 1
    else o.skipped += 1
    return o
  }, { applied: 0, pending: 0, unmatched: 0, skipped: 0, total: 0 }),
  patchIdLabel: (r) => (r.ids || [r.id]).map((id) => '#' + id).join('/'),
  statusLabel: (st) => st,
})

const rows = [
  { id: 1, ids: [1], st: 'already', layer: 'Code', title: 'Log Prefix' },
  { id: 2, ids: [2, 12], st: 'pending', layer: 'Prompt', title: 'Prompt Compose' },
  { id: 3, ids: [3], st: 'unmatched', layer: 'Tools', title: 'Tool Call' },
  { id: 4, ids: [4], st: 'missing_file', layer: 'Code', title: 'Optional Extension' },
  { id: 5, ids: [5], st: 'skipped', layer: 'Compat', title: 'Compatibility' },
]

test('cleaning patch browser searches patch ID, merged IDs, title and layer', () => {
  assert.equal(filterPatchRows(rows, 'all', '#12').map((r) => r.id).join(','), '2')
  assert.equal(filterPatchRows(rows, 'all', 'prompt compose').map((r) => r.id).join(','), '2')
  assert.equal(filterPatchRows(rows, 'all', 'tools').map((r) => r.id).join(','), '3')
  assert.equal(filterPatchRows(rows, 'all', 'nonexistent').length, 0)
  assert.equal(filterPatchRows(rows, 'all', '   ').length, 5)
})

test('cleaning status filters distinguish attention from normal skips', () => {
  assert.equal(filterPatchRows(rows, 'attention', '').map((r) => r.id).join(','), '2,3')
  assert.equal(filterPatchRows(rows, 'pending', '').map((r) => r.id).join(','), '2')
  assert.equal(filterPatchRows(rows, 'unmatched', '').map((r) => r.id).join(','), '3')
  assert.equal(filterPatchRows(rows, 'skipped', '').map((r) => r.id).join(','), '4,5')
  assert.equal(filterPatchRows(rows, 'applied', '').map((r) => r.id).join(','), '1')
  assert.equal(filterPatchRows(rows, 'attention', 'tool').map((r) => r.id).join(','), '3')
})

test('copyable cleaning report includes host, all statuses, and recorded failure without prompt body', () => {
  const report = formatPatchDiagnostics({
    plugin_version: '1.1.92-test',
    surface: 'desktop',
    ai_base: 'D:\\Apps\\DSH',
    dsh_home: 'D:\\DSH',
    shim_cmd: 'patched',
    shim_ps1: 'n/a',
    has_backup: true,
    apply_progress: { kind: 'apply', stage: 'patch', detail: 'patch #3', error: 'pattern not found' },
    override: 'SECRET_PROMPT_SHOULD_NOT_APPEAR',
  }, rows, (s) => s)
  assert.match(report, /D:\\Apps\\DSH/)
  assert.match(report, /2 待应用|1 待应用/)
  assert.match(report, /1 没对上/)
  assert.match(report, /2 跳过/)
  assert.match(report, /流程错误: pattern not found/)
  assert.match(report, /#2\/#12 Prompt Compose \| pending/)
  assert.ok(!report.includes('SECRET_PROMPT_SHOULD_NOT_APPEAR'))
})

test('cleaning UI provides interactive filters, real error details and accessible diagnostic fallback', () => {
  assert.match(client, /"aria-pressed": mode === value/)
  assert.match(client, /onChange: \(e\) => setSearch\(e.target.value\)/)
  assert.match(client, /复制完整诊断/)
  assert.match(client, /清洗流程失败：/)
  assert.match(client, /复制失败；已展开诊断文本/)
  assert.match(client, /跳过不代表失败/)
})


test('grouped patch diagnostics disclose each underlying ID when rollout state is mixed', () => {
  const grouped = [{ id: 2, ids: [2, 12], st: 'applied', layer: 'Prompt', title: 'Prompt Compose' }]
  const state = {
    ai_base: 'D:\\DSH',
    patch_status: { 2: 'applied', 12: 'missing_file' },
  }
  const report = formatPatchDiagnostics(state, grouped, (s) => s)
  assert.match(report, /#2\/#12 Prompt Compose \| applied/)
  assert.match(report, /子补丁：#2 applied \(applied\)；#12 missing_file \(missing_file\)/)
  assert.match(client, /dshp-clean-member-states/)
  assert.match(client, /new Set\(r\.ids\.map\(\(id\) => state\.patch_status\[id\]/)
})

test('single-ID patches do not add redundant child-state lines', () => {
  const report = formatPatchDiagnostics({
    patch_status: { 7: 'pending' },
  }, [{ id: 7, ids: [7], st: 'pending', layer: 'Code', title: 'Entry' }], (s) => s)
  assert.ok(!report.includes('子补丁：'))
})
