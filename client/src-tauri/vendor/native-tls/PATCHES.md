# Local Apple peer verification extension

Source: crates.io `native-tls` version 0.2.18 (https://crates.io/crates/native-tls/0.2.18), retaining its MIT and Apache-2.0 licenses. This directory contains the upstream manifest, build script, README, licenses and source; upstream tests/examples are not vendored.

Local changes in `src/lib.rs` and `src/imp/security_framework.rs` add the Apple-only `TlsConnectorBuilder::apple_peer_verifier` callback. The application uses it for its existing per-origin TOFU server identity policy. Encryption and handshake authentication remain in Apple's Security.framework (Secure Transport); the application computes its public-key fingerprint through system CommonCrypto.

The callback receives the leaf certificate only after a successful TLS handshake. It must accept before the stream is exposed to HTTP. Callback errors close the stream. Every nonblocking handshake continuation retains the callback. Custom verification replaces CA/hostname validation only on that connector; normal connectors keep system PKI validation. Session tickets are disabled and no session cache peer ID is set, so each new connection checks identity again.

Secure Transport currently negotiates TLS 1.2. Do not enable session resumption or remove the continuation callback without updating the identity/reset tests. When updating upstream, reapply and review the small patch, run the real synchronous/asynchronous TLS tests in `src/trust.rs`, and run `scripts/check-apple-system-tls.py` from the repository root. Rustls and rcgen are test peers only on Apple builds.
