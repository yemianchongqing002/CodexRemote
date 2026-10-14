"""No signing identity or Keychain access: exercise the packaging preflight."""
import hashlib
import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('packager', Path(__file__).with_name('package-macos-appstore.py'))
pkg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pkg)


def marker(data):
    return b'CODEX_REMOTE_LEGAL_SHA256:' + hashlib.sha256(data).hexdigest().encode() + b':END'


class LegalBuildTests(unittest.TestCase):
    def test_policy_edit_without_version_bump_is_rejected(self):
        old = b'version=v1;privacyURL=old'
        changed = b'version=v1;privacyURL=new'
        pkg.verify_legal_marker(marker(old), hashlib.sha256(old).hexdigest())
        with self.assertRaisesRegex(ValueError, '重新运行'):
            pkg.verify_legal_marker(marker(old), hashlib.sha256(changed).hexdigest())

    def test_missing_and_conflicting_markers_are_rejected(self):
        digest = hashlib.sha256(b'new').hexdigest()
        for data in (b'legacy executable', marker(b'old'), marker(b'new') + marker(b'old')):
            with self.subTest(data=data), self.assertRaises(ValueError):
                pkg.verify_legal_marker(data, digest)

    def test_each_architecture_is_verified_not_only_one(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            app = root / 'Client.app'
            (app / 'Contents').mkdir(parents=True)
            (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable': 'client'}))
            source = root / 'legal.js'
            source.write_bytes(b'current policy')
            slices = {'arm64': marker(source.read_bytes()), 'x86_64': marker(b'old policy')}

            def lipo(*args):
                if args[1] == '-archs':
                    return b'arm64 x86_64'
                Path(args[-1]).write_bytes(slices[args[3]])
                return b''

            with patch.object(pkg, 'run', side_effect=lipo):
                with self.assertRaises(ValueError):
                    pkg.verify_bundled_legal(app, source)
                slices['x86_64'] = slices['arm64']
                self.assertEqual(pkg.verify_bundled_legal(app, source), hashlib.sha256(source.read_bytes()).hexdigest())
                # Updating source/receipts alone cannot refresh the executable.
                source.write_bytes(b'updated policy')
                with self.assertRaises(ValueError):
                    pkg.verify_bundled_legal(app, source)


if __name__ == '__main__':
    unittest.main()
