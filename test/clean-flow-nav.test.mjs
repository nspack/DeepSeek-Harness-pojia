import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const rt = readFileSync(new URL('../lib/redteam/client.js', import.meta.url), 'utf8')

test('cleaning bar measures workflow progress and shows patch coverage separately', () => {
  assert.match(root, /const flowFinished = Boolean\(job && job\.stage === "done" && !job\.error && !job\.active\)/)
  assert.match(root, /const pct = flowFinished \? 100 : jobOn/)
  assert.doesNotMatch(root, /:\s*\(located && total \? Math\.round\(\(applied \/ total\)/)
  assert.match(root, /清洗流程：/)
  assert.match(root, /补丁已应用/)
  assert.match(root, /role: "progressbar", "aria-label": "清洗流程进度"/)
  assert.match(root, /flowInterrupted \? h\("p"/)
})

test('client does not overwrite a terminal apply response with late status polling', () => {
  assert.match(root, /const actionTerminal = useRef\(false\)/)
  assert.match(root, /if \(stop \|\| !d \|\| actionTerminal\.current\) return/)
  assert.match(root, /actionTerminal\.current = true/)
  assert.match(root, /无法确认操作结果/)
})

test('redteam main section headings are real controls and each page remains navigable', () => {
  assert.match(rt, /h\('button', \{\s*type: 'button', className: 'rt-tab-group-title'/)
  assert.match(rt, /title: '打开' \+ section\.label \+ '首页'/)
  assert.match(rt, /setUI\(\{ tab: page \}\)/)
  assert.match(rt, /\['artex', 'ARTEX'\]/)
  assert.match(rt, /else if \(st\.tab === 'artex'\) body = h\(ArtexTab\)/)
  assert.match(rt, /h\('button', \{[\s\S]*?className: 'rt-tab' \+ \(st\.tab === t\[0\]/)
})

test('cleaning panel no longer houses ARTEX and embedded drill gets the updated navigator', () => {
  assert.doesNotMatch(root, /function ArtexLinkSection\(\)/)
  assert.match(root, /function ArtexTab\(\)/)
  assert.match(root, /className: 'rt-tab-group-title'/)
  assert.match(rt, /fetch\('\/dsh-purge\/artex', \{ method: 'GET' \}\)/)
})
