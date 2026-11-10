/**
 * FOFA-like structured search over an engagement's existing SQLite assets.
 * Offline/read-only: no network requests, enrichment calls or target scans.
 */
export const LOCAL_ASSET_FIELDS = Object.freeze([
  'domain', 'host', 'ip', 'port', 'title', 'banner', 'url',
  'service', 'product', 'app', 'fingerprint', 'cert', 'protocol', 'scope', 'source',
])

function tokenize(query) {
  const src = String(query || '').trim()
  if (!src) throw new Error('请输入查询条件，例如 domain="example.org"')
  if (src.length > 1200) throw new Error('查询表达式不能超过 1200 字符')
  const tokens = []
  const re = /\s*(?:([a-z_]\w*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s()&|]+)|(&&|\|\||\bAND\b|\bOR\b)|([()]))/iy
  let pos = 0
  while (pos < src.length) {
    re.lastIndex = pos
    const m = re.exec(src)
    if (!m) throw new Error('查询语法错误，位置 ' + (pos + 1))
    pos = re.lastIndex
    if (tokens.length > 60) throw new Error('查询条件过多')
    if (m[1]) {
      let value = m[2]
      if (value[0] === '"' || value[0] === "'") {
        value = value.slice(1, -1).replace(/\\(["'\\])/g, '$1')
      }
      if (!value.trim()) throw new Error(m[1] + ' 的查询值不能为空')
      tokens.push({ type: 'filter', field: m[1].toLowerCase(), value })
    } else if (m[3]) {
      tokens.push({ type: m[3] === '&&' || m[3].toUpperCase() === 'AND' ? 'and' : 'or' })
    } else {
      tokens.push({ type: m[4] })
    }
  }
  return tokens
}

const likeValue = (value) => '%' + String(value).replace(/[\\%_]/g, '\\$&') + '%'
const likeSql = (column) => column + " LIKE ? ESCAPE '\\'"
function anyLike(columns, args, value) {
  for (const column of columns) args.push(likeValue(value))
  return '(' + columns.map(likeSql).join(' OR ') + ')'
}

function clause(field, value) {
  if (!LOCAL_ASSET_FIELDS.includes(field)) {
    if (field === 'body') throw new Error('当前本地库不含网页正文；请用 title=、banner= 或 fingerprint=')
    throw new Error('暂不支持 ' + field + '；可用字段：' + LOCAL_ASSET_FIELDS.join('、'))
  }
  const args = []
  let sql
  if (field === 'ip') {
    sql = 'a.ip = ?'
    args.push(value)
  } else if (field === 'port') {
    const port = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('port 必须为 1–65535 的整数')
    }
    sql = "EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.state = 'open' AND p.port = ?)"
    args.push(port)
  } else if (field === 'scope') {
    if (!['external', 'internal'].includes(value)) throw new Error('scope 仅支持 external / internal')
    sql = 'a.scope = ?'
    args.push(value)
  } else if (field === 'source') {
    if (!['passive', 'active'].includes(value)) throw new Error('source 仅支持 passive / active')
    sql = 'EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.provenance = ?)'
    args.push(value)
  } else if (field === 'protocol') {
    if (!['tcp', 'udp'].includes(value)) throw new Error('protocol 仅支持 tcp / udp')
    sql = 'EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND p.proto = ?)'
    args.push(value)
  } else if (field === 'domain') {
    sql = '(' + likeSql('a.primary_name') + ' OR EXISTS (SELECT 1 FROM asset_name n'
      + ' WHERE n.asset_id = a.id AND ' + likeSql('n.name') + '))'
    args.push(likeValue(value), likeValue(value))
  } else if (field === 'host') {
    sql = '(a.ip = ? OR ' + likeSql('a.primary_name')
      + ' OR EXISTS (SELECT 1 FROM asset_name n WHERE n.asset_id = a.id AND '
      + likeSql('n.name') + '))'
    args.push(value, likeValue(value), likeValue(value))
  } else if (field === 'title' || field === 'banner' || field === 'url') {
    sql = 'EXISTS (SELECT 1 FROM port p WHERE p.asset_id = a.id AND ' + likeSql('p.' + field) + ')'
    args.push(likeValue(value))
  } else if (field === 'service') {
    sql = 'EXISTS (SELECT 1 FROM service s JOIN port p ON p.id = s.port_id'
      + ' WHERE p.asset_id = a.id AND ' + anyLike(['s.name', 's.product'], args, value) + ')'
  } else if (field === 'product' || field === 'app') {
    sql = '(EXISTS (SELECT 1 FROM service s JOIN port p ON p.id = s.port_id'
      + ' WHERE p.asset_id = a.id AND ' + anyLike(['s.product', 's.cpe'], args, value) + ')'
      + ' OR EXISTS (SELECT 1 FROM fingerprint f WHERE f.asset_id = a.id AND '
      + likeSql('f.product') + '))'
    args.push(likeValue(value))
  } else if (field === 'fingerprint') {
    sql = 'EXISTS (SELECT 1 FROM fingerprint f WHERE f.asset_id = a.id AND '
      + anyLike(['f.product', 'f.vendor', 'f.category', 'f.evidence'], args, value) + ')'
  } else if (field === 'cert') {
    sql = "(EXISTS (SELECT 1 FROM observation o WHERE o.entity_kind = 'asset'"
      + " AND o.entity_id = a.id AND o.attr LIKE 'cert%' AND " + likeSql('o.value') + ')'
      + ' OR EXISTS (SELECT 1 FROM fingerprint f WHERE f.asset_id = a.id'
      + " AND (f.category LIKE '%cert%' OR f.category LIKE '%tls%') AND "
      + likeSql('f.evidence') + '))'
    args.push(likeValue(value), likeValue(value))
  }
  return { sql, args }
}

/** Return parameterized SQL only; caller adds it to the existing asset list WHERE. */
export function compileLocalAssetQuery(query) {
  const tokens = tokenize(query)
  let pos = 0
  let count = 0
  const accept = (type) => tokens[pos]?.type === type ? tokens[pos++] : null
  const atom = (depth) => {
    if (depth > 8) throw new Error('查询括号嵌套过深')
    if (accept('(')) {
      const nested = orExpr(depth + 1)
      if (!accept(')')) throw new Error('查询括号不匹配')
      return { sql: '(' + nested.sql + ')', args: nested.args }
    }
    const item = accept('filter')
    if (!item) throw new Error('此处应填写 字段=值 或括号表达式')
    if (++count > 24) throw new Error('查询最多支持 24 个过滤条件')
    return clause(item.field, item.value)
  }
  const andExpr = (depth) => {
    let first = atom(depth)
    while (accept('and')) {
      const second = atom(depth)
      first = { sql: '(' + first.sql + ' AND ' + second.sql + ')', args: [...first.args, ...second.args] }
    }
    return first
  }
  const orExpr = (depth) => {
    let first = andExpr(depth)
    while (accept('or')) {
      const second = andExpr(depth)
      first = { sql: '(' + first.sql + ' OR ' + second.sql + ')', args: [...first.args, ...second.args] }
    }
    return first
  }
  const result = orExpr(0)
  if (pos !== tokens.length) throw new Error('查询结尾存在不完整表达式')
  return { where: result.sql, args: result.args, clauses: count, query: String(query).trim() }
}
