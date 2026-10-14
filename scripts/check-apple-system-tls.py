#!/usr/bin/env python3
"""Audit Rust client dependencies only; this does not classify the bundled Go helper."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
for target in ('aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-apple-ios'):
    tree = subprocess.check_output([
        'cargo', 'tree', '--manifest-path', str(root / 'client/src-tauri/Cargo.toml'),
        '--target', target, '--no-default-features', '--features', 'appstore',
        '-e', 'normal', '--prefix', 'none', '--format', '{p}',
    ], text=True)
    packages = {line.split()[0] for line in tree.splitlines() if line.strip()}
    forbidden = packages & {
        'rustls', 'ring', 'aws-lc-rs', 'aws-lc-sys', 'openssl', 'openssl-sys',
        'ssh2', 'libssh2-sys', 'hyper-rustls', 'tokio-rustls',
    }
    if forbidden:
        raise SystemExit(f'{target}: bundled cryptography found: {sorted(forbidden)}')
    if not {'native-tls', 'security-framework', 'hyper-tls'} <= packages:
        raise SystemExit(f'{target}: expected Apple TLS backend missing')
    print(f'{target}: Rust client uses Apple system TLS (Go helper not covered)')
# rustls-pki-types is a certificate data-format crate, not a TLS/crypto engine.
# Tests intentionally use Rustls/rcgen as a local peer; build-time dependencies
# do not ship in the app. Cargo.lock contains all targets and test dependencies.
