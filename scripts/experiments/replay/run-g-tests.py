# -*- coding: utf-8 -*-
"""生成 G 系列判别测试体并重放经 Node proxy（8791），定位第④道形态校验。

G1: REAL body 原样 -> 基线 200
G3: REAL body 的 system 换成伪造提示词 -> 判别 H-A（system 是否必须真实）
G4: aicli body（保留 reasoning_effort=500雷）只把 46 tools 换成 REAL 12 工具
    -> 403=tools 校验仍在（连带伪造 system）；500=tools 已过、死在 effort
G5: aicli body 去 reasoning_effort + system 换 REAL 真实 agent system + tools 换 REAL 12
    + 补 stream_options -> 200=完整形态可过
"""
import json
import os
import subprocess
import sys
import time

TEMP = os.environ.get('TEMP', r'C:\Users\vince\AppData\Local\Temp')
OUT = os.path.join(TEMP, 'bisect-out-g.json')
PROXY = 'http://127.0.0.1:8791/zen/v1/chat/completions'

log_path = r'E:\projects\ai\opencode-proxy\proxy.log'
aicli_path = (r'C:\Users\vince\.aicli\chat-logs\2026\09\22'
              r'\session_20260922230527_c7Bu8vVR\http\001_request_provider_wrapper.json')

with open(log_path, encoding='utf-8') as f:
    recs = [json.loads(l) for l in f.read().splitlines() if l.strip()]
req_rec = [r for r in recs if r.get('direction') == 'request'][-1]
real = json.loads(req_rec['body']['preview'])

with open(aicli_path, encoding='utf-8') as f:
    aicli = json.load(f)['body_json']

print('REAL msgs:', [(m.get('role'), m.get('tool_calls') is not None) for m in real['messages']])
asst = real['messages'][2]
print('assistant tool_calls:', json.dumps(asst.get('tool_calls'), ensure_ascii=False)[:600])
print('tool msg:', json.dumps(real['messages'][3], ensure_ascii=False)[:600])

# G1: REAL 原样
real_copy = json.loads(json.dumps(real))

# G3: REAL 但 system 伪造
g3 = json.loads(json.dumps(real))
g3['messages'] = [dict(m) for m in g3['messages']]
g3['messages'][0]['content'] = 'You are a helpful assistant.'

# G4: aicli body（保留 reasoning_effort），tools 换 REAL 12 工具
g4 = json.loads(json.dumps(aicli))
g4['tools'] = json.loads(json.dumps(real['tools']))

# G5: 真实形态（aicli 骨架 + 真实 system/tools，去 reasoning_effort，补 stream_options）
g5 = json.loads(json.dumps(aicli))
g5.pop('reasoning_effort', None)
g5['tools'] = json.loads(json.dumps(real['tools']))
g5['messages'] = [dict(m) for m in g5['messages']]
g5['messages'][0]['content'] = real['messages'][0]['content']  # 真实 opencode agent system
g5['stream_options'] = {'include_usage': True}

cases = {'G1': g1 if False else real_copy, 'G3': g3, 'G4': g4, 'G5': g5}

for name, body in cases.items():
    path = os.path.join(TEMP, name + '.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(body, f, ensure_ascii=False)
    print('written', path, os.path.getsize(path), 'bytes')

    r = subprocess.run(
        ['curl.exe', '-sS', '-m', '90', '-o', OUT, '-w', '%{http_code}',
         PROXY, '-H', 'content-type: application/json', '--data-binary', '@' + path],
        capture_output=True, text=True)
    code = r.stdout.strip()
    tail = ''
    try:
        with open(OUT, encoding='utf-8') as f:
            tail = f.read()
    except Exception:
        pass
    head = tail[:160].replace('\n', ' ')
    print('== %s => HTTP %s | %s' % (name, code, head))

    # 等待流式结束（SSE 已收完才算）
    time.sleep(1)