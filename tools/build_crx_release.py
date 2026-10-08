#!/usr/bin/env python3
"""Build a consistently-signed CRX3, unpacked ZIP and Pages update.xml.

Requires: Python 3.10+, cryptography, Google Chrome/Chromium.
The same RSA private key MUST be used for every release.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
from urllib.parse import quote
import xml.etree.ElementTree as ET
import zipfile

from cryptography.hazmat.primitives import serialization

REPO = 'Niobium-EXE/Discord-Message-Memory'
PAGES_URL = 'https://niobium-exe.github.io/Discord-Message-Memory/update.xml'
ALLOWED = {'.html', '.js', '.css', '.json', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.woff', '.woff2', '.gif', '.wasm'}
OMIT_DIRS = {'.git', '.github', '.vscode', '.idea', 'docs', 'tools', 'node_modules', 'dist', 'build', '__pycache__', '.venv'}


def extension_id_for_key(private_key):
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    first16 = hashlib.sha256(public_bytes).digest()[:16]
    return ''.join(chr(ord('a') + (b >> shift & 15)) for b in first16 for shift in (4, 0)), base64.b64encode(public_bytes).decode('ascii')


def copy_extension_files(repo_root, target):
    copied = 0
    for src in repo_root.rglob('*'):
        if not src.is_file() or any(part in OMIT_DIRS or part.startswith('.') for part in src.relative_to(repo_root).parts[:-1]):
            continue
        relative = src.relative_to(repo_root)
        if relative.name.startswith('.') or relative.suffix.lower() not in ALLOWED:
            continue
        dst = target / relative
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1
    if not (target / 'manifest.json').is_file():
        raise ValueError('manifest.json was not copied. The extension must be at the repo root.')
    return copied


def clarify_browser_managed_updates(extension):
    """Do not present the old source-ZIP downloader toggle as a CRX update switch.

    A browser-managed update_url in the packed manifest cannot be switched off
    by extension settings; the v1.5 toggle controls *extra ZIP downloads* only.
    """
    for filename in ('popup.html', 'options.html'):
        path = extension / filename
        if not path.exists():
            continue
        html = path.read_text('utf-8')
        html = html.replace('Auto-update from GitHub', 'Extra GitHub ZIP downloads')
        html = html.replace('Off by default. Checks the project repo for newer versions.',
                            'Extra source ZIP downloads are off. Browser-managed packed updates work independently.')
        path.write_text(html, encoding='utf-8')
    for filename in ('popup.js', 'options.js'):
        path = extension / filename
        if not path.exists():
            continue
        source = path.read_text('utf-8')
        source = source.replace('Off by default. Checks the project repo for newer versions.',
                                'Extra ZIP downloads off. Browser-managed packed updates run separately.')
        source = source.replace('Off by default. When enabled, Message Memory checks Niobium-EXE/Discord-Message-Memory every hour and automatically downloads a newer source ZIP. Chromium does not allow an unpacked extension to silently overwrite its own installed code, so applying the downloaded ZIP and reloading the extension is still required.',
                                'Extra source ZIP downloads are off. Packed CRX updates are managed by the browser and do not use this toggle.')
        path.write_text(source, encoding='utf-8')


def zip_extension(directory, output):
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for source in sorted(directory.rglob('*')):
            if source.is_file():
                archive.write(source, str(source.relative_to(directory)))


def write_update_xml(target, appid, version, url):
    ET.register_namespace('', 'http://www.google.com/update2/response')
    ns = '{http://www.google.com/update2/response}'
    root = ET.Element(ns + 'gupdate', {'protocol': '2.0'})
    app = ET.SubElement(root, ns + 'app', {'appid': appid})
    ET.SubElement(app, ns + 'updatecheck', {'codebase': url, 'version': version})
    ET.indent(root, space='  ')
    target.parent.mkdir(parents=True, exist_ok=True)
    ET.ElementTree(root).write(target, encoding='utf-8', xml_declaration=True)


def run(args):
    repo = args.repo.resolve()
    out = args.out.resolve()
    if not repo.is_dir():
        raise SystemExit(f'Extension repo not found: {repo}')
    if not args.key.is_file():
        raise SystemExit('Missing signing key. Set the GitHub Actions CRX_PRIVATE_KEY_B64 secret first.')
    key = serialization.load_pem_private_key(args.key.read_bytes(), password=None)
    extension_id, public_key_b64 = extension_id_for_key(key)
    original_manifest = json.loads((repo / 'manifest.json').read_text('utf-8'))
    # The user's previous unpacked edition may have a different embedded public
    # key. Warn clearly: the first packed edition will then be a *new* extension
    # with separate storage. The release script never overwrites user data.
    previous_public_key = str(original_manifest.get('key', '')).strip()
    if previous_public_key and previous_public_key != public_key_b64:
        print('WARNING: Current source manifest key does not match the CRX signing key.')
        print('WARNING: This packed release has a DIFFERENT extension ID from the current unpacked build.')
        print('WARNING: Export existing Message Memory chats, then import into the newly signed install.')
        print('WARNING: Keep the previous extension until the import has been verified.')
    version = str(original_manifest.get('version', ''))
    if not version or not all(part.isdigit() for part in version.split('.')):
        raise SystemExit('Invalid manifest version (expected e.g. 1.5.1).')
    if args.tag and args.tag.removeprefix('v') != version:
        raise SystemExit(f'Release tag {args.tag} does not match manifest version {version}.')
    filename = f'Discord-Message-Memory-v{version}.crx'
    release_url = f'https://github.com/{REPO}/releases/download/v{quote(version)}/{filename}'
    out.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix='dmm-crx-build-') as temp:
        temp = Path(temp)
        extension = temp / 'extension'
        extension.mkdir()
        copied = copy_extension_files(repo, extension)
        clarify_browser_managed_updates(extension)
        manifest_file = extension / 'manifest.json'
        manifest = json.loads(manifest_file.read_text('utf-8'))
        manifest['update_url'] = args.pages_url
        # The public key is safe to include. It keeps the unpacked ZIP's ID
        # consistent with the signed CRX, but NEVER include the private key.
        manifest['key'] = public_key_b64
        manifest_file.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

        browser = args.browser or next((path for name in ('google-chrome', 'google-chrome-stable', 'chromium', 'chrome') if (path := shutil.which(name))), None)
        if not browser:
            raise SystemExit('Chrome/Chromium missing. Install a browser or pass --browser PATH.')
        # Chromium pack-extension requires PKCS#8 PEM (BEGIN PRIVATE KEY),
        # whereas existing keys are sometimes PKCS#1 (BEGIN RSA PRIVATE KEY).
        # Convert in the temporary build directory without altering the master.
        pack_key = temp / 'pack-key.pk8.pem'
        pack_key.write_bytes(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ))
        pack_key.chmod(0o600)
        cmd = [str(browser), '--no-sandbox', '--headless=new', '--disable-gpu',
               '--disable-dev-shm-usage', '--no-first-run',
               f'--user-data-dir={temp / "browser-profile"}',
               f'--pack-extension={extension}', f'--pack-extension-key={pack_key}']
        completed = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        packed = extension.with_suffix('.crx')
        if not packed.is_file():
            raise SystemExit(f'Browser failed to pack CRX. Exit={completed.returncode}\n{completed.stderr[-2000:]}')
        blob = packed.read_bytes()
        if len(blob) < 20 or blob[:8] != b'Cr24\x03\x00\x00\x00':
            raise SystemExit('Browser did not generate a valid CRX3 header.')
        shutil.copy2(packed, out / filename)
        zip_extension(extension, out / f'Discord-Message-Memory-v{version}-unpacked.zip')

    # Pages is a stable URL; releases hold the actual signed CRX.
    write_update_xml(out / 'pages' / 'update.xml', extension_id, version, release_url)
    (out / 'pages' / '.nojekyll').write_text('', encoding='utf-8')
    (out / 'pages' / 'index.html').write_text(
        f'<!doctype html><meta charset="utf-8"><title>Discord Message Memory Updates</title>'
        f'<h1>Discord Message Memory</h1><p>Current release: {version}</p>', encoding='utf-8')
    (out / 'extension-id.txt').write_text(extension_id + '\n', encoding='ascii')
    print(f'Packed {copied} extension files as CRX3 version {version}')
    print(f'Extension ID: {extension_id}')
    print(f'Packed CRX: {out / filename}')
    print(f'Update XML: {out / "pages" / "update.xml"}')
    print('Note: browser policy or supported self-hosted installation is required for automatic CRX updates.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path('.'))
    parser.add_argument('--key', type=Path, required=True)
    parser.add_argument('--out', type=Path, default=Path('dist'))
    parser.add_argument('--tag', default='')
    parser.add_argument('--browser', default='')
    parser.add_argument('--pages-url', default=PAGES_URL)
    run(parser.parse_args())
