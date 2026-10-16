# -*- coding: utf-8 -*-
"""H17/H18：工具数量下界（2 个/3 个真实工具）。"""
import json
import subprocess

TEMP = 'C:/Users/vince/AppData/Local/Temp/'
OUT = TEMP + 'bisect-out-p2.txt'
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
by = {t['function']['name']: t for t in h13['tools']}


def run(name, names):
    body = json.loads(json.dumps(h13))
    body['tools'] = [by[n] for n in names]
    path = TEMP + name + '.json'
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
    head = tail[:130].replace('\n', ' ')
    print('== %s tools=%d => HTTP %s | %s' % (name, len(names), r.stdout.strip(), head))


run('H17', ['bash', 'read'])
run('H18', ['bash', 'read', 'grep'])