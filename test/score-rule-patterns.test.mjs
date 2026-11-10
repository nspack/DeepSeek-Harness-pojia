/**
 * 得分口径匹配：中文里"权限"前常夹动作词（读取/只读/读写/访问…），
 * 旧正则只认「对象存储权限」，导致「对象存储读取权限」被判为未匹配、成果静默漏记。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { codesForGained } from '../lib/redteam/score-rule-patterns.js'

test('对象存储的各种写法都能命中 file-storage', () => {
  for (const text of [
    '对象存储权限（9054 个对象全量列举 + 任意读取）',
    '对象存储读取权限（9054 个对象全量列举 + 任意读取）',
    'MinIO 只读权限，桶 i-chat 可列举',
    'OSS 读写权限，可上传覆盖同名对象',
    'S3 访问权限（匿名 ListObjectsV2 成功）',
    '文件存储读取权限',
  ]) {
    assert.ok(codesForGained(text).includes('file-storage'), '未命中: ' + text)
  }
})

test('主机 / 数据库 / 后台 / 集权系统的动作词变体也要命中', () => {
  assert.ok(codesForGained('服务器主机权限（root shell）').includes('server-host'))
  assert.ok(codesForGained('服务器只读权限，可读 /etc/passwd').includes('server-host'))
  assert.ok(codesForGained('数据库只读权限，能连库').includes('db-credential'))
  assert.ok(codesForGained('后台管理账号，登录成功').includes('web-app'))
  assert.ok(codesForGained('会话权限（客服台 token 可交互）').includes('web-app'))
  assert.ok(codesForGained('堡垒机管理权限').includes('central-system'))
  assert.ok(codesForGained('云平台只读访问权限').includes('cloud-platform'))
})

test('不是权限的成果不该被硬套成得分项', () => {
  for (const text of [
    '接口层突破：全站前端 API 网关可达',
    'OCS 客服工作台存储型 XSS 注入点（载荷已持久化, 等触发回连）',
    '全站群配置解密密钥、全部 api_domain 清单、S3/OSS 桶路径',
  ]) {
    assert.deepEqual(codesForGained(text), [], '不该命中: ' + text)
  }
})
