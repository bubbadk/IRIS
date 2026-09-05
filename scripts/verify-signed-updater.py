#!/usr/bin/env python3
"""Sign disposable local fixtures, exercise the real Tauri updater, boot the installed copy.

Linux x86_64 only. Requires pnpm build:binary first. This never changes the
production signing key, configured endpoint, application profile or release assets.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--appimage', type=Path, help='Test a real, locally built AppImage instead of the standalone ELF fixture')
args = parser.parse_args()
binary = args.appimage.resolve() if args.appimage else repo / 'apps/desktop/src-tauri/target/release/iris'
if not binary.is_file():
    raise SystemExit('Build the native binary with pnpm build:binary first.')

def run(command, env=None):
    # Signer output can contain key material. Keep it out of console output/logs.
    result = subprocess.run(command, cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        if 'signer' in command:
            raise RuntimeError('Local fixture signing failed; signer output was withheld.')
        sys.stderr.buffer.write(result.stdout + result.stderr)
        raise RuntimeError(f'Test command failed with exit code {result.returncode}.')
    return result.stdout

if args.appimage:
    with binary.open('rb') as header:
        header.seek(8)
        if header.read(3) != b'AI\x02':
            raise SystemExit('Expected a type-2 AppImage; refusing to relabel an ordinary ELF as one.')

with tempfile.TemporaryDirectory(prefix='iris-signed-updater-') as directory:
    root = Path(directory)
    root.chmod(0o700)
    key = root / 'test-key'
    signer = ['pnpm', '--filter', '@iris/desktop', 'exec', 'tauri', 'signer']
    clean_env = os.environ.copy()
    for name in ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']:
        clean_env.pop(name, None)
    run(signer + ['generate', '--ci', '--password', '', '--write-keys', str(key)], clean_env)
    shutil.copy2(binary, root / 'expected-iris')
    for name, member in [('update.tar.gz', 'iris.AppImage'), ('legacy.tar.gz', 'iris')]:
        with tarfile.open(root / name, 'w:gz', compresslevel=1) as archive:
            # The test fixture contains the real standalone ELF. It exercises Tauri's
            # Linux archive convention; this is not a distributable portable AppImage.
            archive.add(binary, arcname=member)
        run(signer + ['sign', '--private-key-path', str(key), '--password', '', str(root / name)], clean_env)
    env = clean_env | {'IRIS_UPDATER_TEST_FIXTURES': str(root)}
    output = run(['cargo', 'test', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml',
                  'signed_updater_installs_and_rejects_invalid_packages', '--', '--ignored'], env)
    boot_env = clean_env | ({'APPIMAGE_EXTRACT_AND_RUN': '1'} if args.appimage else {})
    boot = run([sys.executable, 'scripts/verify-native-startup.py', str(root / 'installed-valid')], boot_env)
    print(json.dumps({
        'signedDownloadAndInstallation': 'passed',
        'tamperedPackageRejectedWithoutReplacement': 'passed',
        'unsupportedArchiveRestoresOriginal': 'passed',
        'installedBinarySha256': hashlib.sha256((root / 'installed-valid').read_bytes()).hexdigest(),
        'installedBinaryBootAndRestart': json.loads(boot),
        'productionKeyOrReleaseChanged': False,
        'fixtureType': 'real AppImage' if args.appimage else 'standalone ELF in the updater Linux archive convention; not a portable AppImage',
    }, indent=2))
