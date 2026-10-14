#!/usr/bin/env python3
"""Fetch pinned browser assets; Go builds need no Node/npm or network."""
import hashlib, io, json, pathlib, re, tarfile, urllib.request
root = pathlib.Path(__file__).resolve().parents[1] / 'internal/server/web/vendor'
versions = {'marked':'18.0.12','dompurify':'3.4.15','katex':'0.18.7','mermaid':'11.17.2'}
manifest = {}
for name,version in versions.items():
    url=f'https://registry.npmjs.org/{name}/-/{name}-{version}.tgz'
    data=urllib.request.urlopen(url).read()
    archive=tarfile.open(fileobj=io.BytesIO(data),mode='r:gz')
    paths={'marked':['lib/marked.umd.js'], 'dompurify':['dist/purify.min.js'], 'katex':['dist/katex.min.js','dist/katex.min.css'], 'mermaid':['dist/mermaid.min.js']}[name]
    for member in archive.getmembers():
        relative=member.name.removeprefix('package/')
        include=relative in paths or (name=='katex' and relative.startswith('dist/fonts/') and relative.endswith('.woff2')) or relative in ['LICENSE','LICENSE.txt']
        if not include or not member.isfile(): continue
        target=root/name/relative.removeprefix('dist/').removeprefix('lib/')
        target.parent.mkdir(parents=True,exist_ok=True)
        content = archive.extractfile(member).read()
        if name == 'katex' and target.suffix == '.css':
            content = re.sub(rb',url\(fonts/[^)]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)', b'', content)
        target.write_bytes(content)
    manifest[name]={'version':version,'source':url,'sha256':hashlib.sha256(data).hexdigest()}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest,indent=2))
