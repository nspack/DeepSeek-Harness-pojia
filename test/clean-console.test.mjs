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

const filterPatchRows = isolated('filterPatchRows', 'patchStatusChanges')
const patchStatusChanges = isolated('patchStatusChanges', 'formatPatchDiagnostics', {
  patchIdLabel: (r) => (r.ids || [r.id]).map((id) => '#' + id).join('/'),
})
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

test('read-only rescan compares prior and next patch states, including added and missing rows', () => {
  const before = [
    { id: 2, ids: [2, 12], title: 'Compose', st: 'pending' },
    { id: 3, ids: [3], title: 'Injection', st: 'unmatched' },
    { id: 4, ids: [4], title: 'Optional', st: 'skipped' },
  ]
  const after = [
    { id: 2, ids: [2, 12], title: 'Compose', st: 'already' },
    { id: 3, ids: [3], title: 'Injection', st: 'unmatched' },
    { id: 5, ids: [5], title: 'New patch', st: 'pending' },
  ]
  const changes = patchStatusChanges(before, after)
  assert.equal(changes.length, 3)
  assert.equal(changes[0].id, '#2/#12')
  assert.equal(changes[0].before, 'pending')
  assert.equal(changes[0].after, 'already')
  assert.equal(changes[1].id, '#5')
  assert.equal(changes[1].before, '未列出')
  assert.equal(changes[2].id, '#4')
  assert.equal(changes[2].after, '未列出')
  assert.equal(patchStatusChanges(after, after).length, 0)
})

test('diagnostics surface host discovery and sealed-asar failures', () => {
  const report = formatPatchDiagnostics({
    plugin_version: 'test',
    surface: 'desktop',
    ai_base: '',
    missing_ai_base: 'Unable to find the active desktop installation',
    desktop_exe: 'D:\\Apps\\DeepSeek\\Harness.exe',
    asar_still_sealed: true,
  }, [], (s) => s)
  assert.match(report, /宿主定位说明: Unable to find/)
  assert.match(report, /桌面程序: D:\\Apps\\DeepSeek\\Harness.exe/)
  assert.match(report, /app.asar 仍封装/)
})

test('rescan and filtered diagnostic export use read-only host endpoint without touching prompt editor', () => {
  assert.match(client, /const refreshPatchStatus = useCallback\(async \(\) => \{/)
  assert.match(client, /const status = await apiJson\("\/dsh-purge\/status"\)/)
  assert.match(client, /h\(PatchGroups, \{ state: s, onRefresh: refreshPatchStatus/)
  assert.match(client, /patchStatusChanges\(rows, updated\)/)
  assert.match(client, /复制当前筛选/)
  assert.match(client, /copyDiagnostics\(filteredDiagnostics, "当前筛选"\)/)
  assert.match(client, /setShownDiagnostics\(text\)/)
  assert.match(client, /shownDiagnostics \|\| diagnostics/)
})
