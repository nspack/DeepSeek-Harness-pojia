#!/usr/bin/env node
/** Local ARTEX/DSH diagnostic. Never reads ARTEX credentials or executes tools. */
import { inspectArtex } from '../lib/artex-integration.js'
import { resolveTool } from '../lib/redteam/platform-config.js'

const withPaths = process.argv.includes('--paths')
const status = await inspectArtex()
const tools = status.tools.map(item => {
  const active = resolveTool(item.id)
  return {
    name: item.id,
    fileFound: true,
    dshSource: active.source,
    reused: active.path === item.path,
    ...(withPaths ? { artexPath: item.path, dshPath: active.path } : {}),
  }
})
console.log(JSON.stringify({
  state: status.state,
  online: status.online,
  httpStatus: status.httpStatus,
  version: status.version,
  summary: status.note,
  tools,
}, null, 2))
