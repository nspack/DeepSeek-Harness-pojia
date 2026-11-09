/**
 * Optional AboutSecurity skill checkout for the RedTeam UI.
 * Git is invoked with fixed argv (never a shell); no work is done at startup.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { aboutSecurityDir } from './skill-catalog.js'

const REMOTE = 'https://github.com/wgpsec/AboutSecurity.git'
const jobs = new Map()

const listeners = new Set()

/** Re-read native providers only after a successful user-initiated checkout/update. */
export function onAboutSecurityChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}


function location(home) {
  return dirname(aboutSecurityDir(resolve(home || process.env.DSH_HOME || join(homedir(), '.dsh'))))
}

function countSkills(dir) {
  let count = 0
  const pending = [dir]
  while (pending.length) {
    let entries
    const dir = pending.pop()
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const item of entries) {
      if (item.isDirectory()) pending.push(join(dir, item.name))
      else if (item.isFile() && item.name === 'SKILL.md') count += 1
    }
  }
  return count
}

async function git(args) {
  await new Promise((resolve, reject) => {
    const child = spawn('git', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const append = (data) => { output = (output + String(data)).slice(-1200) }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('Git failed (' + code + '): ' + output)))
  })
}

export function aboutSecurityStatus({ home } = {}) {
  const destination = location(home)
  const count = countSkills(join(destination, 'skills'))
  const running = jobs.get(destination)
  const checkedOut = existsSync(join(destination, '.git'))
  return {
    ok: true, installed: checkedOut && count > 0, skills: count,
    busy: running?.busy === true, phase: running?.busy ? running.phase : (running?.error ? 'error' : checkedOut && count > 0 ? 'ready' : 'not_installed'),
    error: running?.error || null,
    path: join(destination, 'skills'),
    source: 'wgpsec/AboutSecurity',
  }
}

export function startAboutSecurity({ home, update = false, runGit = git } = {}) {
  const destination = location(home)
  const running = jobs.get(destination)
  if (running?.busy) return { ...aboutSecurityStatus({ home }), ok: false, error: 'AboutSecurity 安装或更新正在进行' }
  const present = existsSync(destination)
  if (update && !existsSync(join(destination, '.git'))) {
    return { ...aboutSecurityStatus({ home }), ok: false, error: '尚未通过 Git 安装 AboutSecurity，不能更新' }
  }
  if (!update && present) {
    return { ...aboutSecurityStatus({ home }), ok: false, error: '目标目录已存在；如已安装请使用更新，否则先检查目录' }
  }

  const job = { busy: true, phase: update ? 'updating' : 'installing', error: null }
  jobs.set(destination, job)
  const stage = destination + '.install-' + process.pid + '-' + Date.now()
  void Promise.resolve().then(async () => {
    try {
      if (update) {
        await runGit(['-C', destination, 'pull', '--ff-only'])
        await runGit(['-C', destination, 'sparse-checkout', 'set', 'skills'])
      } else {
        mkdirSync(dirname(destination), { recursive: true })
        await runGit(['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', 'master', REMOTE, stage])
        await runGit(['-C', stage, 'sparse-checkout', 'set', 'skills'])
        if (countSkills(join(stage, 'skills')) === 0) throw new Error('上游技能目录为空')
        renameSync(stage, destination)
      }
      if (countSkills(join(destination, 'skills')) === 0) throw new Error('没有找到可用的 SKILL.md')
      for (const listener of listeners) {
        try { listener(destination) } catch { /* UI installation remains successful; native provider can retry */ }
      }
    } catch (error) {
      job.error = String(error?.message || error).slice(0, 600)
      if (!update) {
        try { rmSync(stage, { force: true, recursive: true }) } catch { /* temporary folder cleanup */ }
      }
    } finally {
      job.busy = false
      job.phase = job.error ? 'error' : 'ready'
    }
  })
  return aboutSecurityStatus({ home })
}
