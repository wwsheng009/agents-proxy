# -*- coding: utf-8 -*-
"""EFFORT 值域实验：同一 200 基准 body（H13：12 真工具、无 effort、真身份头），
逐值加入 reasoning_effort，观察上游接受边界。

基线预期：absent -> 200（H13 实测）；max -> 500（H10 实测）。
目标：区分「上游完全不支持该字段」vs「只拒绝部分取值」。
"""
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


def run(name, value, present=True):
    body = json.loads(json.dumps(base))
    if present:
        body['reasoning_effort'] = value
    else:
        body.pop('reasoning_effort', None)
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
    head = tail[:110].replace('\n', ' ')
    print('== %-10s effort=%-10s => HTTP %s | %s' % (name, value if present else 'absent',
                                                     r.stdout.strip(), head))


run('absent', '', present=False)
run('max', 'max')
run('high', 'high')
run('medium', 'medium')
run('minimal', 'minimal')
run('none', 'none')
run('bogus', 'ultra-insane')