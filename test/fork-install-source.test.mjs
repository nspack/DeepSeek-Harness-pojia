import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { purgePnpmBuildSpecs } from '../lib/profile-insert.js'

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8')
const fork = 'wxcvm/dsh-purge'
const version = JSON.parse(read('../package.json')).version
const tarball = `https://codeload.github.com/${fork}/tar.gz/refs/tags/v${version}`

test('fork package metadata installs from its own maintained repository', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.repository.url, `git+https://github.com/${fork}.git`)
  assert.equal(pkg.homepage, `https://github.com/${fork}#readme`)
  assert.equal(pkg.bugs.url, `https://github.com/${fork}/issues`)
  assert.equal(pkg.dsh.install.tarball, tarball)
  assert.equal(pkg.dsh.install.zip, `https://codeload.github.com/${fork}/zip/refs/tags/v${version}`)
  assert.equal(pkg.dsh.install.git, `https://github.com/${fork}.git`)
  assert.ok(purgePnpmBuildSpecs().includes(`dsh-purge@${tarball}`))
})

test('built-in updater and profile fallback no longer point at the original repository', () => {
  const updater = read('../lib/update.js')
  const profile = read('../lib/profile-insert.js')
  assert.ok(updater.includes('const REPO = "wxcvm/dsh-purge";'))
  assert.ok(!updater.includes('YuJunZhiXue/dsh-purge'))
  assert.ok(profile.includes('pkg?.dsh?.install?.tarball'))
  assert.ok(!profile.includes('YuJunZhiXue/dsh-purge'))
})

test('English and Chinese installation instructions select this fork without deleting upstream attribution', () => {
  const version = JSON.parse(read('../package.json')).version
  for (const name of ['README.md', 'README.zh-CN.md']) {
    const content = read('../' + name)
    assert.match(content, /https:\/\/codeload\.github\.com\/wxcvm\/dsh-purge\/tar\.gz\/refs\/heads\/master/)
    assert.doesNotMatch(content, /https:\/\/codeload\.github\.com\/YuJunZhiXue\/dsh-purge\//)
    assert.match(content, /git clone https:\/\/github\.com\/wxcvm\/dsh-purge\.git/)
    assert.match(content, /repo=wxcvm%2Fdsh-purge/)
    assert.ok(content.includes('version=' + version + '&repo='))
    assert.ok(content.includes('downloadUrl=https%3A%2F%2Fcodeload.github.com%2Fwxcvm%2Fdsh-purge%2Ftar.gz%2Frefs%2Ftags%2Fv' + version))
    assert.ok(content.includes('YuJunZhiXue/dsh-purge'), 'original attribution retained')
  }
})

test('Windows Desktop installer pins the current release and supports rollback', () => {
  const version = JSON.parse(read('../package.json')).version
  const script = read('../scripts/update-desktop-fork.ps1')
  /* 版本不再写死在脚本里：默认从 package.json 读，避免"发版忘了改脚本"导致装错标签。
     -Version 保留显式覆盖（回滚到指定版本时用）。 */
  assert.match(script, /\[string\]\$Version = ''/, 'must accept an explicit -Version override')
  assert.ok(script.includes("Join-Path $repoRoot 'package.json'"), 'must derive the version from package.json')
  assert.ok(script.includes('https://codeload.github.com/wxcvm/dsh-purge/tar.gz/refs/tags/v$version'))
  assert.ok(!/^\$version = '\d/m.test(script), 'no hardcoded version literal')
  assert.match(script, /pnpm install --frozen-lockfile --ignore-scripts/)
  assert.match(script, /\[switch\]\$CheckOnly/)
  assert.ok(version.length > 0)
})
