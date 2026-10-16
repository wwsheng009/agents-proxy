# -*- coding: utf-8 -*-
"""H6：H3（12 真工具、去 effort）把 system 换成 REAL 真实 opencode agent 提示词后重放。"""
import json
import subprocess

TEMP = 'C:/Users/vince/AppData/Local/Temp/'
OUT = TEMP + 'bisect-out-h6.txt'
PROXY = 'http://127.0.0.1:8791/zen/v1/chat/completions'

with open(TEMP + 'H3.json', encoding='utf-8') as f:
    h3 = json.load(f)

with open(r'E:\projects\ai\opencode-proxy\proxy.log', encoding='utf-8') as f:
    recs = [json.loads(l) for l in f.read().splitlines() if l.strip()]
real = json.loads([r for r in recs if r.get('direction') == 'request'][-1]['body']['preview'])

h3['messages'][0]['content'] = real['messages'][0]['content']
path = TEMP + 'H6.json'
with open(path, 'w', encoding='utf-8') as f:
    json.dump(h3, f, ensure_ascii=False)
print('H6 written, system chars:', len(h3['messages'][0]['content']))

HDRS = [
    '-H', 'content-type: application/json',
    '-H', 'user-agent: opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    '-H', 'x-opencode-client: cli',
    '-H', 'x-opencode-project: 1f9130b43992545b68d65738e3c6ba62841dfe7c',
    '-H', 'x-opencode-request: msg_0c9bb24fb001TI7LRun69aGlvG',
    '-H', 'x-opencode-session: ses_f364648d7ffeWzlplbBQBlKBQK',
]
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
head = tail[:200].replace('\n', ' ')
print('== H6 (real system + real 12 tools + aicli 其余字段) => HTTP %s | %s' % (code, head))