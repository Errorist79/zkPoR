#!/usr/bin/env python3
"""Set the expiration ledger of every authorization entry of a transaction.

A recorded entry starts with the expiration at zero, and the command line
fills it in only for an entry that it signs itself. An entry of a custom
account carries no signature, so this step fills it in instead. The host reads
the expiration before a signature means anything, and refuses a zero.

The transaction arrives as JSON on the input and leaves as JSON on the output.

usage: set_auth_expiration.py <expiration ledger>
"""
import json
import sys

FIELD = "signature_expiration_ledger"


def fill(node, expiration):
    """Sets the field wherever it appears below this node."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == FIELD:
                node[key] = expiration
            else:
                fill(value, expiration)
    elif isinstance(node, list):
        for value in node:
            fill(value, expiration)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[-1])
    expiration = int(sys.argv[1])
    transaction = json.load(sys.stdin)
    fill(transaction, expiration)
    json.dump(transaction, sys.stdout)


if __name__ == "__main__":
    main()
