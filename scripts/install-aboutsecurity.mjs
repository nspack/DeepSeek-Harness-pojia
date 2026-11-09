#!/usr/bin/env node
/**
 * Explicit, on-demand AboutSecurity skill checkout.
 * Keeps the upstream repository separate from dsh-purge; only the skills/
 * working tree is materialized. Never runs on plugin startup/postinstall.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const REMOTE = 'https://github.com/wgpsec/AboutSecurity.git'
const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/install-aboutsecurity.mjs [--home DSH_HOME] [--update]')
  process.exit(0)
}
const homeAt = args.indexOf('--home')
const specifiedHome = homeAt >= 0 ? args[homeAt + 1] : undefined
if (homeAt >= 0 && (!specifiedHome || specifiedHome.startsWith('--'))) {
  throw new Error('--home requires a directory')
}
const home = resolve(specifiedHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
const destination = join(home, 'redteam', 'external-skills', 'aboutsecurity')
const updating = args.includes('--update')

function git(argv) {
  const result = spawnSync('git', argv, { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('git exited with code ' + result.status)
}
function countSkills(dir) {
  let count = 0
  const stack = [dir]
  while (stack.length) {
    const folder = stack.pop()
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(folder, entry.name))
      else if (entry.isFile() && entry.name === 'SKILL.md') count += 1
    }
  }
  return count
}

if (updating) {
  if (!existsSync(join(destination, '.git'))) {
    throw new Error('AboutSecurity has not been installed at ' + destination)
  }
  git(['-C', destination, 'pull', '--ff-only'])
  git(['-C', destination, 'sparse-checkout', 'set', 'skills'])
} else if (existsSync(destination)) {
  console.log('Already installed: ' + destination)
  console.log('Use --update to refresh from upstream.')
  process.exit(0)
} else {
  mkdirSync(join(home, 'redteam', 'external-skills'), { recursive: true })
  try {
    git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', 'master', REMOTE, destination])
    git(['-C', destination, 'sparse-checkout', 'set', 'skills'])
  } catch (error) {
    // Only remove a checkout created in this attempt, never an existing user directory.
    rmSync(destination, { recursive: true, force: true })
    throw error
  }
}

const root = join(destination, 'skills')
if (!existsSync(root)) throw new Error('Upstream skills/ directory was not installed')
console.log('AboutSecurity skills ready: ' + countSkills(root))
console.log('Location: ' + root)
console.log('In DSH redteam mode, use redteam_skill_search then redteam_skill_read.')
