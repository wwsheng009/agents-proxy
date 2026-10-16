# -*- coding: utf-8 -*-
"""补测 low / xhigh，完成官方 7 值 (none/minimal/low/medium/high/xhigh/max) 边界图。"""
import json
import subprocess

TEMP = 'C:/Users/vince/AppData/Local/Temp/'
OUT = TEMP + 'effort-out.txt'
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
    base = json.load(f)


def run(name, value):
    body = json.loads(json.dumps(base))
    body['reasoning_effort'] = value
    path = TEMP + 'eff-' + name + '.json'
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(body, f, ensure_ascii=False)
    r = subprocess.run(['curl.exe', '-sS', '-m', '60', '-o', OUT, '-w', '%{http_code}',
                        PROXY] + HDRS + ['--data-binary', '@' + path],
                       capture_output=True, text=True)
    tail = ''
    try:
        with open(OUT, encoding='utf-8') as f:
            tail = f.read()
    except Exception:
        pass
    head = tail[:80].replace('\n', ' ')
    print('== %-10s effort=%-10s => HTTP %s | %s' % (name, value, r.stdout.strip(), head))


run('low', 'low')
run('xhigh', 'xhigh')
run('medium2', 'medium')  # 确定性复核