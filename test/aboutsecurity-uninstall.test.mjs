/**
 * AboutSecurity 检出目录的卸载守卫。
 *
 * 这个脚本会 `rm -rf` 一个来自网络的目录，所以必须证明三件事：
 *   1. 没装时说"没得删"，且不创建任何东西；
 *   2. 目标不是 git 检出（用户自己的同名目录）时拒绝删除；
 *   3. 是检出时才真删，且只删那一个目录。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/install-aboutsecurity.mjs', import.meta.url))

function homeInTemp(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-aboutsec-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  return home
}

const run = (home, ...flags) => spawnSync(process.execPath, [script, '--home', home, ...flags], { encoding: 'utf8', windowsHide: true })

test('未安装时 --remove 只报告没得删，不创建目录', t => {
  const home = homeInTemp(t)
  const result = run(home, '--remove')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Nothing to remove/)
  assert.equal(existsSync(join(home, 'redteam', 'external-skills', 'aboutsecurity')), false)
})

test('目录不是 git 检出时拒绝删除（防止误删用户自己的同名目录）', t => {
  const home = homeInTemp(t)
  const dir = join(home, 'redteam', 'external-skills', 'aboutsecurity')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notes.md'), 'user data', 'utf8')
  const result = run(home, '--remove')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /refusing to remove/)
  assert.ok(existsSync(join(dir, 'notes.md')), '用户文件必须还在')
})

test('是检出目录时才真删，且不动父目录', t => {
  const home = homeInTemp(t)
  const parent = join(home, 'redteam', 'external-skills')
  const dir = join(parent, 'aboutsecurity')
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'skills.md'), 'x', 'utf8')
  const result = run(home, '--remove')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Removed:/)
  assert.equal(existsSync(dir), false)
  assert.ok(existsSync(parent), '父目录必须保留')
})

test('--help 说明三种用法', t => {
  const home = homeInTemp(t)
  const result = run(home, '--help')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--update/)
  assert.match(result.stdout, /--remove/)
})
