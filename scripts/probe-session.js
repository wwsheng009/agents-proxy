'use strict'

// 判别性探针：原样重放原始 payload，仅替换 x-opencode-session / x-opencode-request，
// 判断上游 FreeTierError 的判定维度（格式 / 新鲜度 / 时间相关性）。
const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const PAYLOAD = 'data/replay/muc7umlx-1qdmbboy.json'
const OUT_DIR = 'data/replay'
const URL = 'https://opencode.ai/zen/v1/chat/completions'

const ORIG = {
  ses: 'ses_f3879bba0ffenHU9GSFayBniAm',
  msg: 'msg_0c786447b001WfBuPbap1t1GGY',
}

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// 复刻 packages/schema/src/identifier.ts 的算法
function makeId(prefix, descending, timestamp) {
  const current = BigInt(timestamp) * 0x1000n + 1n // counter = 1（与实测一致）
  const value = descending ? ~current : current
  let time = ''
  for (let i = 0; i < 6; i++) {
    const b = Number((value >> BigInt(40 - 8 * i)) & 0xffn)
    time += b.toString(16).padStart(2, '0')
  }
  const bytes = crypto.randomBytes(14)
  let rand = ''
  for (const b of bytes) rand += CHARS[b % 62]
  return prefix + time + rand
}

const now = Date.now()
const DAY = 86 * 60 * 60 * 1000 // 3.58 天（覆盖 36 位时间低位回绕窗口内）

const extra = process.argv[2] === 'extra'
const extra2 = process.argv[2] === 'extra2'
const extra3 = process.argv[2] === 'extra3'
const extra4 = process.argv[2] === 'extra4'
const extra5 = process.argv[2] === 'extra5'
const extra6 = process.argv[2] === 'extra6'
const probes = extra
  ? [
      { name: 'P4_malformed_short', ses: 'ses_curl_test_001', msg: ORIG.msg },
      { name: 'P5_bad_hex_length_ok', ses: 'ses_zzzzzzzzzzzz' + '0'.repeat(14), msg: ORIG.msg },
      { name: 'P7_missing_header', ses: null, msg: ORIG.msg },
    ]
  : extra6
    ? [
        { name: 'P22_ua_contains', ses: makeId('ses_', true, now - 2), msg: ORIG.msg, ua: 'curl/8.4.0 opencode/1.18.32' },
        { name: 'P23_bad_ses_old_ua', ses: 'ses_curl_test_001', msg: ORIG.msg, ua: 'opencode/0.0.1 test' },
        { name: 'P24_ua_uppercase', ses: makeId('ses_', true, now - 2), msg: ORIG.msg, ua: 'OpenCode/1.18.32 test' },
        { name: 'P25_ses_prefix_upper', ses: 'SES_' + 'f384a621fffe' + 'abcdef01234567', msg: ORIG.msg },
      ]
  : extra5
    ? [
        { name: 'P16_upper_hex', ses: 'ses_F384A621FFFE' + 'abcdef01234567', msg: ORIG.msg },
        { name: 'P17_ua_1_17_99', ses: makeId('ses_', true, now - 2), msg: ORIG.msg, ua: 'opencode/1.17.99 test' },
        { name: 'P18_ua_1_18_0', ses: makeId('ses_', true, now - 2), msg: ORIG.msg, ua: 'opencode/1.18.0 test' },
        { name: 'P19_no_project_hdr', ses: makeId('ses_', true, now - 2), msg: ORIG.msg, project: null },
        { name: 'P20_ua_prerelease', ses: makeId('ses_', true, now - 2), msg: ORIG.msg, ua: 'opencode/1.19.0-beta.1 test' },
        { name: 'P21_ua_two_part_ver', ses: makeId('ses_', true, now - 2), msg: ORIG.msg, ua: 'opencode/1.18 test' },
      ]
  : extra4
    ? [
        { name: 'P12_short_random', ses: 'ses_f384a621fffe' + 'a'.repeat(13), msg: ORIG.msg },
        { name: 'P13_bad_random_charset', ses: 'ses_f384a621fffe' + 'abcdef0123456-', msg: ORIG.msg },
        { name: 'P15_missing_msg_header', ses: makeId('ses_', true, now - 2), msg: null },
      ]
  : extra3
    ? [
        { name: 'P10_ses_ua_opencode_fake', ses: makeId('ses_', true, now - 2), msg: ORIG.msg, ua: 'opencode-fake' },
        {
          name: 'P11_ses_ua_opencode_slash',
          ses: makeId('ses_', true, now - 2),
          msg: ORIG.msg,
          ua: 'opencode/0.0.1 test',
        },
      ]
  : extra2
    ? [
        { name: 'P8_fresh_ses_curl_ua', ses: makeId('ses_', true, now - 2), msg: ORIG.msg, ua: 'curl/8.4.0' },
        { name: 'P9_fresh_ses_no_client_hdr', ses: makeId('ses_', true, now - 2), msg: ORIG.msg, client: null },
      ]
    : [
      { name: 'P0_control_orig', ses: ORIG.ses, msg: ORIG.msg },
      { name: 'P1_fresh_both', ses: makeId('ses_', true, now - 2), msg: makeId('msg_', false, now) },
      { name: 'P2_ses_now_msg_orig', ses: makeId('ses_', true, now), msg: ORIG.msg },
      {
        name: 'P3_both_3d_old',
        ses: makeId('ses_', true, now - DAY),
        msg: makeId('msg_', false, now - DAY + 2),
      },
    ]

const baseHeaders = {
  'content-type': 'application/json',
  'user-agent': 'opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
  'x-opencode-client': 'cli',
  'x-opencode-project': 'global',
  authorization: 'Bearer public',
}

const results = []
for (const p of probes) {
  const args = ['-sS', '-N', '-m', '30', '-D', '-', '-o', '-', '-X', 'POST', URL]
  const hs = { ...baseHeaders }
  if (p.msg !== null) hs['x-opencode-request'] = p.msg
  if (p.ses !== null) hs['x-opencode-session'] = p.ses
  if (p.ua !== undefined) hs['user-agent'] = p.ua
  if (p.client !== undefined) {
    if (p.client === null) delete hs['x-opencode-client']
    else hs['x-opencode-client'] = p.client
  }
  if (p.project !== undefined) {
    if (p.project === null) delete hs['x-opencode-project']
    else hs['x-opencode-project'] = p.project
  }
  for (const [k, v] of Object.entries(hs)) {
    args.push('-H', `${k}: ${v}`)
  }
  args.push('--data-binary', `@${PAYLOAD}`)
  const run = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 40000 })
  const out = `${run.stdout || ''}${run.stderr || ''}`
  const statusMatch = out.match(/^HTTP\/[\d.]+\s+(\d+)/m)
  const body = out.split(/\r?\n\r?\n/).slice(1).join('\n\n').slice(0, 220)
  const rec = {
    name: p.name,
    ses: p.ses,
    msg: p.msg,
    status: statusMatch ? Number(statusMatch[1]) : null,
    bodySnippet: body.replace(/\s+/g, ' ').slice(0, 200),
  }
  results.push(rec)
  console.log(JSON.stringify(rec))
}

const suffix = extra
  ? '-extra'
  : extra2
    ? '-extra2'
    : extra3
      ? '-extra3'
      : extra4
        ? '-extra4'
        : extra5
          ? '-extra5'
          : extra6
            ? '-extra6'
            : ''
fs.writeFileSync(`${OUT_DIR}/probe-matrix${suffix}.json`, JSON.stringify(results, null, 2))
console.log('saved', `${OUT_DIR}/probe-matrix${suffix}.json`)
