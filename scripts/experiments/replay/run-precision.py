# -*- coding: utf-8 -*-
"""精度测试：opencode 工具面是“必须完整 12 个”还是“真实 schema 子集即可”。

H15 = H13 只保留 6 个真实工具 [bash, read, write, edit, grep, glob]
H16 = H13 只保留 1 个真实工具 [bash]（真实 schema，对比早期 S4 的最小伪造 schema 403）
"""
import json
import subprocess

TEMP = 'C:/Users/vince/AppData/Local/Temp/'
OUT = TEMP + 'bisect-out-precision.txt'
PROXY = 'http://127.0.0.1:8791/zen/v1/chat/completions'

HDRS = [
    '-H', 'content-type: application/json',
    '-H', 'user-agent: opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    '-H', 'x-opencode-client: cli',
    '-H', 'x-opencode-project: 1f9130b43992545b68d65738e3c6ba62841dfe7c',
    '-H', 'x-opencode-request: msg_0c9bb24fb001TI7LRun69aGlvG',
    '-H', 'x-opencode-session: ses_f364648d7ffeWzlplbBQBlKBQK',
]

with open(TEMP + 'H13.json', encoding='utf-8') as f:
    h13 = json.load(f)

by_name = {t['function']['name']: t for t in h13['tools']}
print('available:', sorted(by_name))


def run(name, tools):
    body = json.loads(json.dumps(h13))
    body['tools'] = tools
    path = TEMP + name + '.json'
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(body, f, ensure_ascii=False)
    r = subprocess.run(['curl.exe', '-sS', '-m', '60', '-o', OUT, '-w', '%{http_code}',
                        PROXY] + HDRS + ['--data-binary', '@' + path],
                       capture_output=True, text=True)
    code = r.stdout.strip()
    tail = ''
    try:
        with open(OUT, encoding='utf-8') as f:
            tail = f.read()
    except Exception:
        pass
    head = tail[:130].replace('\n', ' ')
    print('== %s (tools=%d) => HTTP %s | %s' % (name, len(tools), code, head))


sub = ['bash', 'read', 'write', 'edit', 'grep', 'glob']
run('H15', [by_name[n] for n in sub])
run('H16', [by_name['bash']])