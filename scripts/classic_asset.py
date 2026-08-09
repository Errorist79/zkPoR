#!/usr/bin/env python3
"""Print the serialized classic `Asset` XDR of one asset, as hexadecimal.

The registry derives the canonical asset contract address from these bytes and
reads the issuer account out of them.

usage: classic_asset.py <code> <issuer strkey>
"""
import base64
import sys

# XDR discriminants. The asset type and the public key type of an account
# identifier both serialize as four big-endian bytes.
ASSET_TYPE_ALPHANUM4 = 1
ASSET_TYPE_ALPHANUM12 = 2
PUBLIC_KEY_TYPE_ED25519 = 0
DISCRIMINANT_BYTES = 4
CODE4_BYTES = 4
CODE12_BYTES = 12
KEY_BYTES = 32
# A strkey holds a version byte, the payload, and a two-byte checksum.
STRKEY_VERSION_ACCOUNT = 6 << 3
STRKEY_CHECKSUM_BYTES = 2


def account_key(strkey):
    raw = base64.b32decode(strkey + "=" * (-len(strkey) % 8))
    if raw[0] != STRKEY_VERSION_ACCOUNT:
        sys.exit(f"{strkey} is not an account address")
    key = raw[1:-STRKEY_CHECKSUM_BYTES]
    if len(key) != KEY_BYTES:
        sys.exit(f"{strkey} does not carry a {KEY_BYTES} byte key")
    return key


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip().splitlines()[-1])
    code, issuer = sys.argv[1], sys.argv[2]
    if len(code) <= CODE4_BYTES:
        asset_type, width = ASSET_TYPE_ALPHANUM4, CODE4_BYTES
    elif len(code) <= CODE12_BYTES:
        asset_type, width = ASSET_TYPE_ALPHANUM12, CODE12_BYTES
    else:
        sys.exit(f"the code {code} is longer than {CODE12_BYTES} characters")

    serialized = asset_type.to_bytes(DISCRIMINANT_BYTES, "big")
    serialized += code.encode("ascii").ljust(width, b"\x00")
    serialized += PUBLIC_KEY_TYPE_ED25519.to_bytes(DISCRIMINANT_BYTES, "big")
    serialized += account_key(issuer)
    print(serialized.hex())


if __name__ == "__main__":
    main()
