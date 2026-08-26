#!/usr/bin/env python3
"""Print the root and the total that a terminal proof carries.

The two values come out of the public input byte string that the prover wrote,
so a caller never states them itself. The position of each element and the
length of the string come from the generated manifest.

usage: public_input_fields.py <public_inputs> <manifest.json>
"""
import json
import sys


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip().splitlines()[-1])
    data = open(sys.argv[1], "rb").read()
    manifest = json.load(open(sys.argv[2]))

    total_bytes = manifest["public_input_bytes"]
    count = manifest["public_input_count"]
    if len(data) != total_bytes:
        sys.exit(f"the string is {len(data)} bytes, and the manifest says {total_bytes}")
    size = total_bytes // count

    def element(name):
        start = manifest["public_input_positions"][name] * size
        return int.from_bytes(data[start:start + size], "big")

    print(element("final_root"), element("L"))


if __name__ == "__main__":
    main()
