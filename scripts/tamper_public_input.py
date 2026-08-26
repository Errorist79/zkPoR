#!/usr/bin/env python3
"""Write the public input byte string again with one field changed by one bit.

A verifier must reject the result. The caller gives the position of the field,
the total length, and the field count, all of which come from the generated
manifest, so no length and no position is written here.

usage: tamper_public_input.py <source> <target> <index> <total_bytes> <count>
"""
import sys


def main():
    if len(sys.argv) != 6:
        sys.exit(__doc__.strip().splitlines()[-1])
    source, target = sys.argv[1], sys.argv[2]
    index, total, count = (int(value) for value in sys.argv[3:6])

    data = bytearray(open(source, "rb").read())
    if len(data) != total:
        sys.exit(f"the public input string is {len(data)} bytes, and the manifest says {total}")
    size = total // count
    start = index * size
    original = bytes(data[start:start + size])
    data[start:start + size] = (int.from_bytes(original, "big") ^ 1).to_bytes(size, "big")
    if bytes(data[start:start + size]) == original:
        sys.exit("the field did not change")
    open(target, "wb").write(bytes(data))


if __name__ == "__main__":
    main()
