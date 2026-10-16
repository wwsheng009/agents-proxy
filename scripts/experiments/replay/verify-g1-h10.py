# -*- coding: utf-8 -*-
"""核对 H10 与 G1 的 JSON 等价性，并对二者做重复重放（同一组头），
区分“确定性 500”与“上游间歇性 500”。"""
import json
import subprocess

TEMP = 'C:/Users/vince/AppData/Local/Temp/'
OUT = TEMP + 'bisect-out-h10.txt'
PROXY = 'http://127.0.0.1:8791/zen/v1/chat/completions'

g1 = json.load(open(TEMP + 'G1.json', encoding='utf-8'))
h10 = json.load(open(TEMP + 'H10.json', encoding='utf-8'))

# 1) 深度等价比较
def deep_diff(a, b, path='$'):
    diffs = []
    if type(a) is not type(b):
        return ['%s: type %s vs %s' % (path, type(a).__name__, type(b).__name__)]
    if isinstance(a, dict):
        for k in set(a) | set(b):
            if k not in a:
                diffs.append('%s.%s only in H10' % (path, k))
            elif k not in b:
                diffs.append('%s.%s only in G1' % (path, k))
            else:
                diffs += deep_diff(a[k], b[k], '%s.%s' % (path, k))
    elif isinstance(a, list):
        if len(a) != len(b):
            diffs.append('%s: len %d vs %d' % (path, len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            diffs += deep_diff(x, y, '%s[%d]' % (path, i))
    elif a != b:
        sa, sb = str(a), str(b)
        diffs.append('%s: %r vs %r' % (path, sa[:80], sb[:80]))
    return diffs

diffs = deep_diff(g1, h10)
print('### deep diff G1 vs H10: %d diffs' % len(diffs))
for d in diffs[:30]:
    print('   ', d)

HDRS = [
    '-H', 'content-type: application/json',
    '-H', 'user-agent: opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    '-H', 'x-opencode-client: cli',
    '-H', 'x-opencode-project: 1f9130b43992545b68d65738e3c6ba62841dfe7c',
    '-H', 'x-opencode-request: msg_0c9bb24fb001TI7LRun69aGlvG',
    '-H', 'x-opencode-session: ses_f364648d7ffeWzlplbBQBlKBQK',
]

def run(tag, path):
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
    head = tail[:120].replace('\n', ' ')
    print('== %s => HTTP %s | %s' % (tag, code, head))

# 2) 重复重放
run('G1-replay#1', TEMP + 'G1.json')
run('G1-replay#2', TEMP + 'G1.json')
run('H10-replay#1', TEMP + 'H10.json')
run('H10-replay#2', TEMP + 'H10.json')