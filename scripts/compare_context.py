#!/usr/bin/env python3
"""Compare a context file with the entry that the registry holds.

The registry derives the context hash from its own state, so a proof of a
context that differs anywhere does not verify. This reports each difference
and stops with a non-zero status. It stops the same way when it cannot read
either side, so a caller that checks the status never reads silence as
agreement.

The entry arrives as JSON on the input.

usage: compare_context.py <context.toml>
"""
import json
import re
import sys


def context_values(path):
    """The authority and the reserve addresses of a context file."""
    text = open(path).read()

    def value(key):
        match = re.search(rf'^{key}\s*=\s*"([^"]*)"', text, re.MULTILINE)
        return match.group(1) if match else None

    reserves = re.search(r"^reserves\s*=\s*\[(.*)\]", text, re.MULTILINE)
    return {
        "authority": value("authority"),
        "reserves": re.findall(r'"([^"]+)"', reserves.group(1)) if reserves else [],
    }


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[-1])
    try:
        context = context_values(sys.argv[1])
    except OSError as error:
        sys.exit(f"cannot read the context file: {error}")
    try:
        entry = json.load(sys.stdin)
    except ValueError as error:
        sys.exit(f"the registry answered no readable entry: {error}")
    if not isinstance(entry, dict):
        sys.exit(f"the registry answered no entry: {entry}")

    differences = []
    if context["authority"] != entry.get("authority"):
        differences.append(
            f"authority: the context says {context['authority']} "
            f"and the registry holds {entry.get('authority')}"
        )
    # The reserve set hash does not depend on the order, so the comparison
    # does not either.
    if sorted(context["reserves"]) != sorted(entry.get("reserves", [])):
        differences.append(
            f"reserves: the context says {sorted(context['reserves'])} "
            f"and the registry holds {sorted(entry.get('reserves', []))}"
        )
    if differences:
        sys.exit("\n".join(differences))


if __name__ == "__main__":
    main()
