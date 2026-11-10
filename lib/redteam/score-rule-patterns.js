/**
 * 得分口径的匹配规则（从 `redteam_threescore_suggest` 里抽出来，便于单测）。
 *
 * 背景：一场演练里 8 条 confirmed 有 1 条写成「对象存储读取权限」，
 * 旧正则只认「对象存储权限」，中间的「读取」让它漏匹配 —— 插件于是给出
 * 空建议，成果被静默漏记。这里把"权限"前面的常见动作词统一收进 PERM。
 */

/* 名词与「权限」之间允许出现的动作词：读取 / 只读 / 读写 / 访问 / 列举 / 下载 / 上传 / 管理 / 操作 / 控制 */
export const PERM = '(?:(?:读取|只读|读写|访问|列举|下载|上传|管理|操作|控制)?(?:权限|访问权))'

export const SCORE_RULES = [
  { code: 'server-host', re: new RegExp('服务器(?:主机)?' + PERM + '|webshell|getshell|root 权限|管理员 shell|命令执行成功|system 权限', 'i') },
  { code: 'db-credential', re: new RegExp('数据库(?:' + PERM + '|凭据|登录成功)|能连库|远程连库成功|(?:mysql|postgres|redis) ' + PERM, 'i') },
  { code: 'web-app', re: new RegExp('后台(?:管理)?(?:权限|账号|登录成功)|管理面登录成功|web 应用' + PERM + '|账号' + PERM + '|会话' + PERM, 'i') },
  { code: 'file-storage', re: new RegExp('对象存储' + PERM + '|file storage|minio ' + PERM + '|s3 ' + PERM + '|oss ' + PERM + '|文件存储' + PERM, 'i') },
  { code: 'netdev', re: new RegExp('(?:防火墙|路由器|交换机|vpn|fortigate|网络设备)(?:' + PERM + '|管理权限|登录成功)', 'i') },
  { code: 'central-system', re: new RegExp('集权系统' + PERM + '|运维平台(?:管理)?' + PERM + '|堡垒机(?:管理)?' + PERM + '|域控(?:管理)?' + PERM + '|统一认证(?:管理)?' + PERM, 'i') },
  { code: 'terminal-access', re: new RegExp('终端' + PERM + '|pc ' + PERM + '|设备管理' + PERM, 'i') },
  { code: 'domain-control', re: new RegExp('域名控制' + PERM + '|dns 管理' + PERM + '|注册商' + PERM, 'i') },
  { code: 'cloud-platform', re: new RegExp('云平台(?:管理|访问|控制台)?' + PERM + '|云控制台' + PERM, 'i') },
]

/** 把一段"拿到的成果"映射到得分项 code（可能为空 = 未匹配，交给人工核对）。 */
export function codesForGained(text) {
  const value = String(text || '')
  return SCORE_RULES.filter((rule) => rule.re.test(value)).map((rule) => rule.code)
}
