#!/usr/bin/env python3
"""Exercise the real bundled Go service using isolated data and no user sessions."""
import http.client
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
import time
import urllib.parse

root = Path(__file__).resolve().parent.parent
binary = root / 'client/src-tauri/local-service-bundle/codex-remote-service'
with tempfile.TemporaryDirectory(prefix='codex-app-service-') as temp:
    state = Path(temp)
    data = state / 'codex'
    data.mkdir()
    ready = state / 'ready.json'
    args = [str(binary), '--app-managed', '--read-only', '--listen=127.0.0.1:0',
            '--require-token', f'--codex-home={data}', f'--token-file={state / "token"}', f'--ready-file={ready}']
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 15
        while not ready.exists() and time.monotonic() < deadline:
            if proc.poll() is not None:
                raise AssertionError(proc.stderr.read().decode())
            time.sleep(.05)
        address = urllib.parse.urlparse(json.loads(ready.read_text())['address'])
        assert address.hostname == '127.0.0.1' and address.scheme == 'https' and address.port > 0
        # The test pins trust to this freshly created isolated peer, not a production host.
        conn = http.client.HTTPSConnection(address.hostname, address.port, context=ssl._create_unverified_context())
        conn.request('GET', '/api/status')
        response = conn.getresponse()
        assert response.status == 401
        response.read()
        conn.request('POST', '/api/login', json.dumps({'token': (state / 'token').read_text().strip()}), {'Content-Type': 'application/json'})
        response = conn.getresponse()
        assert response.status == 200
        cookie = response.getheader('Set-Cookie').split(';')[0]
        response.read()
        conn.request('GET', '/api/status', headers={'Cookie': cookie})
        response = conn.getresponse()
        assert response.status == 200
        status = json.loads(response.read())
        assert status['sendingEnabled'] is False
        conn.close()
        proc.stdin.close()
        assert proc.wait(timeout=8) == 0
        assert not ready.exists(), 'stale ready file after orderly exit'
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    for invalid in [['--listen=0.0.0.0:0'], ['--supervise'], ['--require-token=false']]:
        failed = subprocess.run(args + invalid, input=b'', stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        assert failed.returncode != 0
print('PASS: bundled service startup, private random port, authentication, read-only operation, EOF cleanup and unsafe-mode rejection')
