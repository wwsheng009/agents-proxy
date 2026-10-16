# -*- coding: utf-8 -*-
"""从 H3.json 派生三个单删变体并逐个重放（真身份头固定）。"""
import json
import os
import subprocess

TEMP = 'C:/Users/vince/AppData/Local/Temp/'
OUT = TEMP + 'bisect-out-h3.txt'
PROXY = 'http://127.0.0.1:8791/zen/v1/chat/completions'

base = json.load(open(TEMP + 'H3.json', encoding='utf-8'))

HDRS = [
    '-H', 'content-type: application/json',
    '-H', 'user-agent: opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    '-H', 'x-opencode-client: cli',
    '-H', 'x-opencode-project: 1f9130b43992545b68d65738e3c6ba62841dfe7c',
    '-H', 'x-opencode-request: msg_0c9bb24fb001TI7LRun69aGlvG',
    '-H', 'x-opencode-session: ses_f364648d7ffeWzlplbBQBlKBQK',
]

for key in ('parallel_tool_calls', 'prompt_cache_key', 'temperature'):
    x = json.loads(json.dumps(base))
    x.pop(key, None)
    path = TEMP + 'H3a_' + key + '.json'
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(x, f, ensure_ascii=False)
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
    head = tail[:160].replace('\n', ' ')
    print('== H3a minus %s => HTTP %s | %s' % (key, code, head))