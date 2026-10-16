# -*- coding: utf-8 -*-
"""H 系列：固定“现场真实身份头”，变化 body，判别第④道 header/body 维度。

头（G6 已验证的组合，无 authorization）:
  user-agent: opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14
  x-opencode-client: cli
  x-opencode-project: 1f9130b43992545b68d65738e3c6ba62841dfe7c
  x-opencode-request: msg_0c9bb24fb001TI7LRun69aGlvG
  x-opencode-session: ses_f364648d7ffeWzlplbBQBlKBQK

H1: 真头 + r2c 类型 body（aicli 核心、无 tools）      -> 控制，预期 200
H2: 真头 + aicli 原样 body（46 tools, reasoning_effort=max）
    -> 200=body 无关；403=body 独立；500=tools 过了、死在 effort
H3: 真头 + aicli 骨架（去 effort、tools 换真实 12）  -> 判别 tools 面
H4: 真头 + aicli 骨架（去 effort、46 tools 原样）    -> 判别 46 自身
H5: 真头 + aicli 骨架（去 effort、无 tools）         -> 判别无 tools 形态
"""
import json
import os
import subprocess
import time

TEMP = os.environ.get('TEMP', r'C:\Users\vince\AppData\Local\Temp')
OUT = os.path.join(TEMP, 'bisect-out-h.json')
PROXY = 'http://127.0.0.1:8791/zen/v1/chat/completions'

AICLI = (r'C:\Users\vince\.aicli\chat-logs\2026\09\22'
         r'\session_20260922230527_c7Bu8vVR\http\001_request_provider_wrapper.json')
REAL_LOG = r'E:\projects\ai\opencode-proxy\proxy.log'

HDRS = [
    '-H', 'content-type: application/json',
    '-H', 'user-agent: opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    '-H', 'x-opencode-client: cli',
    '-H', 'x-opencode-project: 1f9130b43992545b68d65738e3c6ba62841dfe7c',
    '-H', 'x-opencode-request: msg_0c9bb24fb001TI7LRun69aGlvG',
    '-H', 'x-opencode-session: ses_f364648d7ffeWzlplbBQBlKBQK',
]

# r2c 类型 body（aicli 核心 + prompt_cache_key，无 tools）
core = {
    'max_tokens': 8000,
    'messages': [
        {'role': 'system', 'content': 'Environment context:\n<cwd>E:\\projects\\ai\\opencode-proxy</cwd>\n<os>windows</os>'},
        {'role': 'user', 'content': 'pwd'},
    ],
    'model': 'mimo-v2.6-flash-free',
    'stream': True,
    'temperature': 0.7,
    'prompt_cache_key': 'session_20260922230527_c7Bu8vVR',
}

with open(AICLI, encoding='utf-8') as f:
    aicli = json.load(f)['body_json']

with open(REAL_LOG, encoding='utf-8') as f:
    recs = [json.loads(l) for l in f.read().splitlines() if l.strip()]
real = json.loads([r for r in recs if r.get('direction') == 'request'][-1]['body']['preview'])
real_tools = json.loads(json.dumps(real['tools']))

cases = {}
cases['H1'] = json.loads(json.dumps(core))                                    # 无 tools
cases['H2'] = json.loads(json.dumps(aicli))                                   # aicli 原样
h3 = json.loads(json.dumps(aicli)); h3['tools'] = json.loads(json.dumps(real_tools)); cases['H3'] = h3
h4 = json.loads(json.dumps(aicli)); h4.pop('reasoning_effort', None); cases['H4'] = h4
h5 = json.loads(json.dumps(aicli)); h5.pop('reasoning_effort', None); h5.pop('tools', None); cases['H5'] = h5

for name, body in cases.items():
    path = os.path.join(TEMP, name + '.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(body, f, ensure_ascii=False)
    r = subprocess.run(['curl.exe', '-sS', '-m', '90', '-o', OUT, '-w', '%{http_code}',
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
    print('== %s => HTTP %s | %s' % (name, code, head))
    time.sleep(1)