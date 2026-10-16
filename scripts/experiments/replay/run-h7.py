# -*- coding: utf-8 -*-
"""H7：H6 基础上补 REAL 的完整消息历史（user pwd / assistant tool_calls / tool 回填），
其余字段保持 aicli（max_tokens 8000/temperature 0.7/parallel_tool_calls/prompt_cache_key）。
判别 messages 历史结构是否 500 的元凶。"""
import json
import subprocess

TEMP = 'C:/Users/vince/AppData/Local/Temp/'
OUT = TEMP + 'bisect-out-h7.txt'
PROXY = 'http://127.0.0.1:8791/zen/v1/chat/completions'

with open(TEMP + 'H6.json', encoding='utf-8') as f:
    h6 = json.load(f)

with open(r'E:\projects\ai\opencode-proxy\proxy.log', encoding='utf-8') as f:
    recs = [json.loads(l) for l in f.read().splitlines() if l.strip()]
real = json.loads([r for r in recs if r.get('direction') == 'request'][-1]['body']['preview'])

# H6 的 system 已是真实 system；把 messages 补齐为 REAL 的完整 4 条结构
h7 = json.loads(json.dumps(h6))
h7['messages'] = json.loads(json.dumps(real['messages']))
path = TEMP + 'H7.json'
with open(path, 'w', encoding='utf-8') as f:
    json.dump(h7, f, ensure_ascii=False)
print('H7 written, messages:', [(m.get('role'), m.get('tool_calls') is not None) for m in h7['messages']])

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
print('== H7 (real msgs + aicli 其余字段 + real 12 tools) => HTTP %s | %s' % (code, head))