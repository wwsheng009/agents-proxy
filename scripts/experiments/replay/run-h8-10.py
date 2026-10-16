# -*- coding: utf-8 -*-
"""H8-H10：从 H7（500）向 G6（200）逐步对齐字段，锁定 500 元凶。

H8  = H7 - temperature - parallel_tool_calls - prompt_cache_key  （仍 max_tokens 8000、无 stream_options）
H9  = H8 且 max_tokens -> 32000
H10 = H9 且加 stream_options {include_usage:true}（此时应等价 G6，预期 200 收口）
"""
import json
import subprocess

TEMP = 'C:/Users/vince/AppData/Local/Temp/'
OUT = TEMP + 'bisect-out-h8.txt'
PROXY = 'http://127.0.0.1:8791/zen/v1/chat/completions'

with open(TEMP + 'H7.json', encoding='utf-8') as f:
    h7 = json.load(f)

HDRS = [
    '-H', 'content-type: application/json',
    '-H', 'user-agent: opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    '-H', 'x-opencode-client: cli',
    '-H', 'x-opencode-project: 1f9130b43992545b68d65738e3c6ba62841dfe7c',
    '-H', 'x-opencode-request: msg_0c9bb24fb001TI7LRun69aGlvG',
    '-H', 'x-opencode-session: ses_f364648d7ffeWzlplbBQBlKBQK',
]


def run(name, body):
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
    head = tail[:180].replace('\n', ' ')
    print('== %s => HTTP %s | %s' % (name, code, head))


h8 = json.loads(json.dumps(h7))
for k in ('temperature', 'parallel_tool_calls', 'prompt_cache_key'):
    h8.pop(k, None)
run('H8', h8)

h9 = json.loads(json.dumps(h8))
h9['max_tokens'] = 32000
run('H9', h9)

h10 = json.loads(json.dumps(h9))
h10['stream_options'] = {'include_usage': True}
run('H10', h10)