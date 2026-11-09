/**
 * Optional native DSH provider for skills installed on demand from AboutSecurity.
 *
 * The existing redteam_skill_search/redteam_skill_read tools remain available
 * even when a host does not expose skills.registerProvider().
 */
import { dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { listLocalSkills } from './skill-catalog.js'
import { onAboutSecurityChange } from './aboutsecurity-manager.js'

export const ABOUTSECURITY_PROVIDER = 'dsh-purge-aboutsecurity'

export function nativeAboutSecurityName(key) {
  const path = String(key || '').replace(/^aboutsecurity:/, '')
  return 'aboutsecurity-' + path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function externalEntries(home) {
  return listLocalSkills({ home }).filter((entry) => entry.source === 'aboutsecurity')
}

function summary(entry) {
  return {
    name: nativeAboutSecurityName(entry.key),
    description: entry.description || entry.title || entry.name,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom',
    provider: ABOUTSECURITY_PROVIDER,
    rank: 650,
    path: entry.file,
    resourceBase: { kind: 'directory', path: dirname(entry.file) },
    locator: entry.key,
  }
}

export function createNativeAboutSecurityProvider({ home } = {}) {
  return {
    name: ABOUTSECURITY_PROVIDER,
    async list() {
      return externalEntries(home).map(summary)
    },
    async get(candidate) {
      const entries = externalEntries(home)
      const entry = entries.find((item) =>
        item.key === candidate?.locator || nativeAboutSecurityName(item.key) === candidate?.name)
      if (!entry) throw new Error('AboutSecurity skill no longer installed: ' + (candidate?.name || '?'))
      const markdown = readFileSync(entry.file, 'utf8')
      const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown)
      return {
        ...summary(entry),
        content: frontmatter ? markdown.slice(frontmatter[0].length) : markdown,
      }
    },
  }
}

/**
 * Lifecycle: the DSH skill service may appear later than the redteam UI.
 * Attach only when it does; register after install/update and dispose with
 * the injected scope. Absent native services do not change model-tool access.
 */
export function connectNativeAboutSecurity(ctx, { home } = {}) {
  if (typeof ctx?.inject !== 'function') return false
  ctx.inject(['skills'], (scope) => {
    const native = scope?.skills
    if (!native || typeof native.registerProvider !== 'function') return
    let dispose
    const refresh = () => {
      if (dispose) {
        dispose()
        dispose = undefined
      }
      if (!externalEntries(home).length) return
      dispose = native.registerProvider(() => createNativeAboutSecurityProvider({ home }))
    }
    try { refresh() } catch (error) {
      ctx.logger?.warn?.('AboutSecurity native skill registration failed: %s', error?.message || String(error))
    }
    const unsubscribe = onAboutSecurityChange(() => {
      try { refresh() } catch (error) {
        ctx.logger?.warn?.('AboutSecurity native skill refresh failed: %s', error?.message || String(error))
      }
    })
    scope.effect(() => () => {
      unsubscribe()
      if (dispose) {
        dispose()
        dispose = undefined
      }
    })
  })
  return true
}
