# TLS stack differential via python as third stack.
import json, urllib.request, urllib.error

headers = json.load(open('replay-headers.json', encoding='utf-8'))
body = open('replay-body.json', 'rb').read()
headers = {k: v for k, v in headers.items() if k not in ('accept-encoding', 'host', 'content-length')}

req = urllib.request.Request('https://opencode.ai/zen/v1/chat/completions', data=body, headers=headers, method='POST')
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        print('python ->', r.status)
        print('  ', r.read()[:100])
except urllib.error.HTTPError as e:
    print('python ->', e.code)
    print('  ', e.read()[:100])
