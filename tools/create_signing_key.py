#!/usr/bin/env python3
"""Create the one permanent CRX signing key. Never put this file in GitHub!"""
from pathlib import Path
import sys
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from build_crx_release import extension_id_for_key

path = Path(sys.argv[1]) if len(sys.argv)>1 else Path('crx-signing-key.pem')
if path.exists():
    raise SystemExit(f'Refusing to overwrite existing signing key: {path}')
path.parent.mkdir(parents=True, exist_ok=True)
key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
bytes_ = key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
)
path.write_bytes(bytes_)
path.chmod(0o600)
app_id, _ = extension_id_for_key(key)
print(f'Created key: {path.resolve()}')
print('Extension ID:', app_id)
print('Back up this key securely. All updates MUST use this exact same key.')
print('Store the base64-encoded contents in the GitHub CRX_PRIVATE_KEY_B64 Actions secret.')
