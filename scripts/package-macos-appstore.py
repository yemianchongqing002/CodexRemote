#!/usr/bin/env python3
"""Sign a fresh App Store universal build and produce a Transporter package.

Run build-distribution.cjs macos-appstore --build first. Private keys stay in
Keychain; provisioning profiles and release artifacts stay outside source files.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import struct
import tempfile


def check_quarantine(app, remove=False):
    # Only the staged build is cleaned; downloaded originals remain untouched.
    for item in [app, *app.rglob('*')]:
        if 'com.apple.quarantine' in run('xattr', '-s', item).decode().splitlines():
            if not remove:
                raise ValueError(f'Forbidden quarantine attribute: {item}')
            run('xattr', '-s', '-d', 'com.apple.quarantine', item)


def verify_store_icon(app, info):
    name = info.get('CFBundleIconFile', '')
    if not name:
        raise ValueError('Missing CFBundleIconFile')
    if not name.endswith('.icns'):
        name += '.icns'
    data = (app / 'Contents/Resources' / name).read_bytes()
    if data[:4] != b'icns' or struct.unpack('>I', data[4:8])[0] != len(data):
        raise ValueError('Invalid ICNS container')
    offset = 8
    retina = False
    while offset < len(data):
        kind, size = struct.unpack('>4sI', data[offset:offset + 8])
        if size < 8 or offset + size > len(data):
            raise ValueError('Invalid ICNS entry')
        payload = data[offset + 8:offset + size]
        if kind == b'ic10' and payload[:8] == b'\x89PNG\r\n\x1a\n':
            retina = struct.unpack('>II', payload[16:24]) == (1024, 1024)
        offset += size
    if not retina:
        raise ValueError('App Store icon requires a 1024px PNG ic10 representation (512pt @2x)')


def run(*args):
    return subprocess.check_output([str(a) for a in args], stderr=subprocess.STDOUT)


def verify_legal_marker(binary, expected):
    markers = set(re.findall(rb'CODEX_REMOTE_LEGAL_SHA256:([a-f0-9]{64}):END', binary))
    if markers != {expected.encode('ascii')}:
        raise ValueError('App 内政策缺失或已过期：请重新运行 '
                         'node scripts/build-distribution.cjs macos-appstore --build 后再签名。')


def verify_bundled_legal(app, legal_source):
    expected = hashlib.sha256(legal_source.read_bytes()).hexdigest()
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    executable = app / 'Contents/MacOS' / info['CFBundleExecutable']
    architectures = run('lipo', '-archs', executable).decode().split()
    if set(architectures) != {'arm64', 'x86_64'}:
        raise ValueError('Policy verification requires the universal App Store application')
    # A fresh arm64 build must not hide a stale x86_64 slice (or vice versa).
    with tempfile.TemporaryDirectory(prefix='codex-legal-verify-') as temp:
        for arch in architectures:
            thin = Path(temp) / arch
            run('lipo', executable, '-thin', arch, '-output', thin)
            verify_legal_marker(thin.read_bytes(), expected)
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--installer-identity', required=True)
    args = parser.parse_args()
    # Do not ship a successfully signed but functionally incomplete replacement.
    # Remove this gate only after the sandboxed local Codex integration and
    # encryption classification have been implemented and verified on-device.
    raise SystemExit('当前 1.0.7 仅为一体化服务测试候选版：商店沙盒下的本机 Codex 接入、发送/回复及出口合规尚未完成，不能生成可提交的正式安装包。')
    subprocess.run(["node", str(Path(__file__).resolve().parent / "export-legal.cjs"), "--check"], check=True)
    root = Path(__file__).resolve().parent.parent
    config = json.loads((root / 'client/src-tauri/tauri.conf.json').read_text())
    legal_source = root / 'client/ui/legal.js'
    source = root / '.local/distributions/macos-appstore/target/universal-apple-darwin/release/bundle/macos' / (config['productName'] + '.app')
    legal_digest = verify_bundled_legal(source, legal_source)
    profile = plistlib.loads(run('security', 'cms', '-D', '-i', args.profile))
    team = profile['TeamIdentifier'][0]
    allowed = profile['Entitlements']
    app_id = allowed['com.apple.application-identifier']
    if profile.get('Platform') != ['OSX'] or profile.get('ProvisionedDevices') or profile.get('ProvisionsAllDevices'):
        raise ValueError('A Mac App Store distribution profile is required')
    if profile['ExpirationDate'] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
        raise ValueError('Provisioning profile expired')
    if app_id != profile['ApplicationIdentifierPrefix'][0] + '.' + config['identifier']:
        raise ValueError('Profile does not match the application identifier')
    if allowed.get('com.apple.developer.team-identifier') != team or allowed.get('get-task-allow') or allowed.get('com.apple.security.get-task-allow'):
        raise ValueError('Invalid distribution entitlements')
    identities = run('security', 'find-identity', '-v', '-p', 'basic').decode()
    certs = [hashlib.sha1(c).hexdigest().upper() for c in profile['DeveloperCertificates']]
    matches = [c for c in certs if any(c in line and ('Apple Distribution:' in line or 'Mac Developer Application:' in line) for line in identities.splitlines())]
    if len(matches) != 1:
        raise ValueError('Expected exactly one available application signing identity matching the profile')
    installer = args.installer_identity
    if not any(installer in line and '3rd Party Mac Developer Installer:' in line and f'({team})' in line for line in identities.splitlines()):
        raise ValueError('Installer identity must have a private key and belong to the profile team')
    info = plistlib.loads((source / 'Contents/Info.plist').read_bytes())
    if info['CFBundleIdentifier'] != config['identifier'] or info['CFBundleShortVersionString'] != config['version']:
        raise ValueError('Rebuild: bundle identifier or version is stale')
    if not info.get('LSApplicationCategoryType'):
        raise ValueError('Missing App Store category')
    if not info.get('NSLocalNetworkUsageDescription', '').strip():
        raise ValueError('Missing local network usage description for LAN connections')
    verify_store_icon(source, info)
    executable = Path('Contents/MacOS') / info['CFBundleExecutable']
    if set(run('lipo', '-archs', source / executable).decode().split()) != {'arm64', 'x86_64'}:
        raise ValueError('Expected an arm64 + x86_64 universal application')
    # Allow exactly the bundled helper; all nested code is signed inside-out.
    helper = Path("Contents/MacOS/codex-remote-service")
    if not (source / helper).is_file():
        raise ValueError("Rebuild: bundled local service is missing")
    if set(run("lipo", "-archs", source / helper).decode().split()) != {"arm64", "x86_64"}:
        raise ValueError("Local helper must be universal")
    for item in source.rglob('*'):
        if item.stat().st_mode & 0o6000:
            raise ValueError(f'Unexpected setuid/setgid permission: {item}')
        if item.is_file() and 'Mach-O' in run('file', '-b', item).decode() and item not in {source / executable, source / helper}:
            raise ValueError(f'Nested code requires explicit signing: {item}')
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    output = root / 'dist/macos-appstore' / f'{config["version"]}-universal-signed-{stamp}'
    output.mkdir(parents=True, exist_ok=False)
    app = output / source.name
    shutil.copytree(source, app, symlinks=True)
    shutil.copyfile(args.profile, app / 'Contents/embedded.provisionprofile')
    check_quarantine(app, remove=True)
    check_quarantine(app)
    manifest = plistlib.loads((app / 'Contents/Resources/PrivacyInfo.xcprivacy').read_bytes())
    expected_manifest = plistlib.loads((root / 'client/distributions/PrivacyInfo.xcprivacy').read_bytes())
    if manifest != expected_manifest:
        raise ValueError('Privacy manifest is missing or stale; rebuild the application')
    entitlements = plistlib.loads((root / 'client/distributions/macos-appstore.entitlements').read_bytes())
    entitlements.update({'com.apple.application-identifier': app_id, 'com.apple.developer.team-identifier': team})
    if entitlements.get('com.apple.security.app-sandbox') is not True:
        raise ValueError('Mac App Store requires App Sandbox')
    if entitlements.get('com.apple.security.get-task-allow') or entitlements.get('get-task-allow'):
        raise ValueError('Release application must not allow debugging')
    entitlement_file = output / 'signing-entitlements.plist'
    entitlement_file.write_bytes(plistlib.dumps(entitlements))
    verify_bundled_legal(app, legal_source)
    helper_entitlements = root / 'client/distributions/macos-service.entitlements'
    if plistlib.loads(helper_entitlements.read_bytes()) != {'com.apple.security.app-sandbox': True, 'com.apple.security.inherit': True}:
        raise ValueError('Helper must inherit only the parent sandbox')
    run('codesign', '--force', '--sign', matches[0], '--entitlements', helper_entitlements, app / helper)
    run('codesign', '--verify', '--strict', app / helper)
    actual_helper = subprocess.check_output(['codesign', '-d', '--entitlements', ':-', str(app / helper)], stderr=subprocess.DEVNULL)
    if plistlib.loads(actual_helper) != plistlib.loads(helper_entitlements.read_bytes()):
        raise ValueError('Helper sandbox entitlements do not match')
    print('Signing application:', app, flush=True)
    print(run('codesign', '--force', '--sign', matches[0], '--entitlements', entitlement_file, app).decode(), flush=True)
    print(run('codesign', '--verify', '--deep', '--strict', '--verbose=2', app).decode(), flush=True)
    actual = subprocess.check_output(['codesign', '-d', '--entitlements', ':-', str(app)], stderr=subprocess.DEVNULL)
    if plistlib.loads(actual) != entitlements:
        raise ValueError('Signed entitlements do not match')
    pkg = output / f'CodexRemoteClient-{config["version"]}-macos-universal.pkg'
    print(run('xcrun', 'productbuild', '--sign', installer, '--component', app, '/Applications', pkg).decode(), flush=True)
    print(run('pkgutil', '--check-signature', pkg).decode(), flush=True)
    # Validate the actual archived payload as well as the staging directory.
    with tempfile.TemporaryDirectory(prefix='codex-package-verify-') as temp:
        expanded = Path(temp) / 'expanded'
        run('pkgutil', '--expand-full', pkg, expanded)
        payload = list(expanded.rglob(app.name))
        if len(payload) != 1:
            raise ValueError('Expected exactly one application in the package')
        check_quarantine(payload[0])
        verify_store_icon(payload[0], info)
        verify_bundled_legal(payload[0], legal_source)
        run('codesign', '--verify', '--deep', '--strict', payload[0])
    metadata = {'version': config['version'], 'build': info['CFBundleVersion'], 'team': team, 'bundleId': config['identifier'], 'architectures': ['arm64', 'x86_64'], 'minimumSystemVersion': info.get('LSMinimumSystemVersion'), 'profileUUID': profile['UUID'], 'applicationIdentitySHA1': matches[0], 'installerIdentity': installer, 'sha256': hashlib.sha256(pkg.read_bytes()).hexdigest(), 'uploaded': False}
    metadata['legalSHA256'] = legal_digest
    (output / 'build-info.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print('PACKAGE=' + str(pkg), flush=True)


if __name__ == '__main__':
    main()
