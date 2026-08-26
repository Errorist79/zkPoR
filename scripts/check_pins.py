#!/usr/bin/env python3
"""Compare every pinned dependency in the tracked manifests with versions.env.

Three of the pinned versions were compared by a job and four were not. A drift
in bb, soroban-sdk, soroban-poseidon or either Noir tag failed nothing, so the
numbers agreed only because nobody had changed one.

This reads the git index rather than the directory. A scratch manifest that
somebody left in the tree is not part of this project, and one of them pins
soroban-sdk without the equals sign, so a walk of the directory would either
fail on a file belonging to nobody or teach the next reader to loosen the rule
until it passes. `scripts/ci_targets.sh` reads the index for the same reason.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Which manifests may name which dependency.
#
# The reason for the list, rather than the rule: a crate that starts depending
# on the Soroban library must not be able to do so without somebody reading the
# pinned version and adding a line here. Without the list, a new dependency at
# any version is indistinguishable from a crate that never had one, because
# absence and correctness look the same to a check that only compares what it
# finds.
#
# A manifest that inherits the version from the workspace names no version, and
# is correct whenever the workspace root is correct.
TABLE = {
    "soroban-sdk": {
        "variable": "SOROBAN_SDK_VERSION",
        "manifests": [
            "Cargo.toml",
            "contracts/context/Cargo.toml",
            "contracts/registry/Cargo.toml",
            "contracts/vendor/ultrahonk-soroban-verifier/Cargo.toml",
            "contracts/verifier/Cargo.toml",
            "tools/gate/fund-token/Cargo.toml",
            "tools/gate/reserve-account/Cargo.toml",
            "tools/inclusion-verify/Cargo.toml",
            "tools/package/Cargo.toml",
            "tools/recursion-gen/Cargo.toml",
        ],
    },
    "soroban-poseidon": {
        "variable": "SOROBAN_POSEIDON_VERSION",
        "manifests": [
            "Cargo.toml",
            "contracts/context/Cargo.toml",
            "tools/recursion-gen/Cargo.toml",
        ],
    },
    "bb_proof_verification": {
        "variable": "BB_PROOF_VERIFICATION_VERSION",
        "manifests": ["circuits/recursion/agg/Nargo.toml"],
    },
    "poseidon": {
        "variable": "NOIR_POSEIDON_VERSION",
        "manifests": ["circuits/recursion/common/Nargo.toml"],
    },
}


def pinned_versions() -> dict[str, str]:
    """The versions that scripts/versions.env holds."""
    text = (ROOT / "scripts" / "versions.env").read_text(encoding="utf-8")
    found = {}
    for line in text.splitlines():
        match = re.match(r'^([A-Z_]+)="([^"]*)"', line.strip())
        if match:
            found[match.group(1)] = match.group(2)
    return found


def tracked_manifests() -> list[str]:
    """Every manifest that git tracks, which is every manifest of this project."""
    answer = subprocess.run(
        ["git", "ls-files", "*Cargo.toml", "*Nargo.toml"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if answer.returncode != 0:
        # An exported copy of the sources carries no index, so this check cannot
        # tell a committed manifest from a scratch one and must not guess. It
        # says so rather than falling back to a walk of the directory, which is
        # the fallback that would read somebody's scratch file as a rule.
        raise SystemExit(
            "check_pins needs a clone: it reads the git index to tell a committed "
            "manifest from a scratch one, and this tree has no index"
        )
    return sorted(answer.stdout.split())


def declaration(path: str, name: str) -> str | None:
    """What one manifest says about one dependency, or nothing when it is silent."""
    text = (ROOT / path).read_text(encoding="utf-8")
    match = re.search(r"^\s*%s\s*=\s*(.+)$" % re.escape(name), text, re.M)
    return match.group(1).strip() if match else None


def main() -> int:
    versions = pinned_versions()
    manifests = tracked_manifests()
    failures: list[str] = []

    for name, entry in TABLE.items():
        variable = entry["variable"]
        expected = versions.get(variable)
        if expected is None:
            failures.append(
                f"scripts/versions.env holds no {variable}, which is the pin for {name}"
            )
            continue
        allowed = set(entry["manifests"])
        for path in manifests:
            says = declaration(path, name)
            if says is None:
                if path in allowed:
                    failures.append(
                        f"{path} no longer names {name}. The table in this script says it "
                        f"should. Remove that manifest from the table if the dependency is "
                        f"gone on purpose."
                    )
                continue
            if path not in allowed:
                failures.append(
                    f"{path} names {name} and the table in this script does not list it. "
                    f"scripts/versions.env pins {name} at {expected}. Check that this "
                    f"manifest asks for that version, then add the manifest to the table."
                )
                continue
            if "workspace" in says:
                continue
            if expected not in says:
                failures.append(
                    f"{path} names {name} as {says}, and scripts/versions.env pins "
                    f"{expected}. Change the manifest, or change the pin and every manifest "
                    f"that follows it."
                )
                continue
            if not re.search(r'"=%s"' % re.escape(expected), says) and not re.search(
                r'tag\s*=\s*"%s"' % re.escape(expected), says
            ):
                failures.append(
                    f"{path} names {name} as {says}, which asks for {expected} or later "
                    f"rather than for {expected}. Pin it exactly."
                )

    if failures:
        print("PINS FAIL")
        for line in failures:
            print(f"  {line}")
        return 1
    total = sum(len(entry["manifests"]) for entry in TABLE.values())
    print(f"every pinned dependency agrees with scripts/versions.env, in {total} declarations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
