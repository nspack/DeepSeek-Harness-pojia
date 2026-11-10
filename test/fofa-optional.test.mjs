import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('FOFA absent is an optional diagnostic, not a global preflight missing item', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'redteam-no-fofa-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.FOFA_KEY
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousKey === undefined) delete process.env.FOFA_KEY
    else process.env.FOFA_KEY = previousKey
    rmSync(root, { recursive: true, force: true })
  })
  process.env.DSH_HOME = root
  delete process.env.FOFA_KEY
  const mod = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(mod, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{}')
  writeFileSync(join(mod, 'package.json'), '{"name":"@deepseek-ai/dsh-tools","main":"index.js"}')
  writeFileSync(join(mod, 'index.js'), 'exports.defineTool = spec => spec\n')
  const { apply } = await import('../lib/redteam/tools.js')
  const registry = new Map()
  const ctx = {
    redteam: { root, listEngagements: () => [] },
    tools: { register(spec) { registry.set(spec.name, spec) } },
    effect: (setup) => { const cleanup = setup(); t.after(() => cleanup?.()) },
    on: () => () => {},
  }
  apply(ctx)
  const result = JSON.parse(await registry.get('redteam_preflight').execute({}, {}))
  assert.ok(result.onboarding)
  assert.equal(result.onboarding.configured.fofa_key, 'missing')
  assert.ok(result.onboarding.optional_missing.some((x) => x.includes('FOFA_KEY')))
  assert.ok(result.onboarding.missing.every((x) => !x.includes('FOFA_KEY')))
  assert.match(result.onboarding.optional_missing.join(' '), /可选/)
  const selected = JSON.parse(await registry.get('redteam_preflight').execute({ include: 'recon-pipeline' }, {}))
  assert.ok(selected.onboarding.missing.every((x) => !x.includes('FOFA_KEY')))
})

test('recon instructions prioritize local-first discovery and preserve optional FOFA support', async () => {
  const { DEFAULT_PROMPTS } = await import('../lib/redteam/store-core.js')
  assert.match(DEFAULT_PROMPTS.recon, /被动信息收集（默认不需要 FOFA）/)
  assert.match(DEFAULT_PROMPTS.recon, /subfinder/)
  assert.match(DEFAULT_PROMPTS.recon, /fofa-recon/)
  const pipeline = readFileSync(new URL('../skills/redteam/recon-pipeline.md', import.meta.url), 'utf8')
  assert.match(pipeline, /推荐顺序（默认无 FOFA）/)
  assert.match(pipeline, /FOFA_KEY/)
  assert.match(readFileSync(new URL('../skills/redteam/fofa-recon.md', import.meta.url), 'utf8'),
    /不是侦察阶段的前置依赖/)
})
