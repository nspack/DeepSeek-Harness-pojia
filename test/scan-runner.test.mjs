import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCommand, runDiscoveryScan, executeScanAndIngest } from '../lib/redteam/scan-runner.js'

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'redteam-scan-run-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('Nmap and httpx command arrays are explicit and contain no shell', () => {
  assert.deepEqual(scanCommand('nmap', '192.0.2.1', { ports: '80,443' }).args,
    ['-sT', '-sV', '--open', '-oX', '-', '-p', '80,443', '192.0.2.1'])
  assert.deepEqual(scanCommand('httpx', 'https://example.org').args,
    ['-u', 'https://example.org', '-json', '-silent'])
  assert.throws(() => scanCommand('nmap', '-oX /tmp/file'), /target/)
  assert.throws(() => scanCommand('nmap', 'host;whoami'), /hostname/)
  assert.throws(() => scanCommand('nmap', 'example.org', { ports: '80;whoami' }), /ports/)
  assert.throws(() => scanCommand('httpx', 'file:///etc/passwd'), /HTTP/)
})

test('running a local scanner preserves raw output and verifiable metadata', async (t) => {
  const root = temp(t)
  const executable = join(root, 'nmap.exe')
  writeFileSync(executable, 'fixture')
  let invoked = 0
  const run = await runDiscoveryScan({
    kind: 'nmap', target: '192.0.2.1', ports: '80,443', outputDir: join(root, 'records'),
  }, {
    root, config: { platform: 'windows', tools: { nmap: executable }, toolkitDir: root, binDirs: [] },
    env: { PATH: '' },
    execFileFn: (path, args, cfg, done) => {
      invoked++
      assert.equal(path, executable)
      assert.equal(cfg.shell, false)
      assert.equal(cfg.timeout, 180000)
      assert.equal(args.at(-1), '192.0.2.1')
      done(null, '<nmaprun><host></host></nmaprun>', '')
    },
  })
  assert.equal(invoked, 1)
  assert.equal(run.status, 'executed')
  assert.equal(run.ok, true)
  assert.match(readFileSync(run.outputFile, 'utf8'), /nmaprun/)
  const manifest = JSON.parse(readFileSync(run.manifestFile, 'utf8'))
  assert.equal(manifest.sha256, run.sha256)
  assert.equal(manifest.target, '192.0.2.1')
  assert.equal(manifest.source, 'config')
})

test('failed execution preserves diagnostics but never invokes ingestion', async (t) => {
  const root = temp(t), file = join(root, 'httpx.exe')
  writeFileSync(file, 'fixture')
  const result = await executeScanAndIngest({
    kind: 'httpx', target: 'https://example.org', outputDir: join(root, 'runs'),
  }, {
    root, config: { platform: 'windows', tools: { httpx: file }, toolkitDir: root, binDirs: [] },
    env: { PATH: '' },
    execFileFn: (_bin, _argv, _cfg, done) => done(new Error('binary exited 1'), '', 'bad input'),
    ingest: () => { throw new Error('must not ingest failed run') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.ingested, false)
  assert.equal(JSON.parse(readFileSync(result.manifestFile, 'utf8')).status, 'failed')
})

test('successful run reuses ingestion and records the outcome on the same manifest', async (t) => {
  const root = temp(t), file = join(root, 'httpx.exe')
  writeFileSync(file, 'fixture')
  let calls = 0
  const result = await executeScanAndIngest({
    kind: 'httpx', target: 'https://example.org', outputDir: join(root, 'runs'),
  }, {
    root, config: { platform: 'windows', tools: { httpx: file }, toolkitDir: root, binDirs: [] },
    env: { PATH: '' },
    execFileFn: (_bin, args, cfg, done) => {
      assert.deepEqual(args, ['-u', 'https://example.org', '-json', '-silent'])
      done(null, '{"url":"https://example.org","port":443}\n', '')
    },
    ingest: ({ file, kind, argv, commit }) => {
      calls++
      assert.equal(kind, 'httpx')
      assert.equal(commit, true)
      assert.equal(argv[0], '-u')
      assert.match(readFileSync(file, 'utf8'), /example.org/)
      return { ok: true, assets: 1, ports: 1, imported: { scan_run_id: 7 } }
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.status, 'imported')
  assert.equal(result.ingested, true)
  const manifest = JSON.parse(readFileSync(result.manifestFile, 'utf8'))
  assert.equal(manifest.ingested, true)
  assert.equal(manifest.ingestion.imported.scan_run_id, 7)
})

test('scanner output without recognized findings never reports a successful import', async (t) => {
  const root = temp(t), file = join(root, 'nmap.exe')
  writeFileSync(file, 'fixture')
  const result = await executeScanAndIngest({
    kind: 'nmap', target: '192.0.2.99', outputDir: join(root, 'runs'),
  }, {
    root, config: { platform: 'windows', tools: { nmap: file }, toolkitDir: root, binDirs: [] },
    env: { PATH: '' },
    execFileFn: (_bin, _argv, _cfg, done) => done(null, '<nmaprun></nmaprun>', ''),
    ingest: () => ({ ok: true, assets: 0, ports: 0, vulns: 0 }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'no-findings')
  assert.equal(result.ingested, false)
  assert.equal(JSON.parse(readFileSync(result.manifestFile, 'utf8')).status, 'no-findings')
})
