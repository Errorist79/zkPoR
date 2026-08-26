#!/usr/bin/env python3
"""Build honest and cheat Prover.toml inputs for the aggregator hardening tests.

Adversarial test scaffolding for the soundness gate only -- NOT production.
Reads the bb `--output_format fields` outputs of the pinned inner circuit and the
adversarial circuits, then emits aggregator Prover.toml variants (one honest,
several cheats) plus the adversarial Prover.toml witnesses. Each cheat targets
exactly one of the four hardening constraints so the aggregator's rejection is
attributable.

Field elements are emitted as decimal strings (the generator's format). All
arithmetic is mod the BN254 scalar field.
"""
import json
import os
import re
import sys
from pathlib import Path

P = 21888242871839275222246405745257275088548364400416034343698204186575808495617

# This file lives in tools/gate; the repo root (and circuits/) is two levels up.
GATE = Path(__file__).resolve().parent
REPO = GATE.parent.parent
REC = REPO / "circuits/recursion"
INNER = REC / "inner"
EVIL = GATE / "attacks/inner_evil"
STALE = GATE / "attacks/inner_stale_leaf"
AGG = REC / "agg"


def read_fields(path):
    return [int(x, 16) for x in json.loads(Path(path).read_text())]


def global_u32(name):
    """A generated `pub global` of the aggregator params."""
    m = re.search(rf"pub global {name}: u32 = (\d+);", (AGG / "src/params.nr").read_text())
    return int(m.group(1))


def arr(values):
    return "[" + ", ".join(f'"{v % P}"' for v in values) + "]"


def quoted(values):
    """Decimal strings that are already reduced, as a TOML array."""
    return "[" + ", ".join(f'"{v}"' for v in values) + "]"


def rows(list_of_lists):
    return "[" + ", ".join(arr(v) for v in list_of_lists) + "]"


def toml_list(path, key):
    line = next(l for l in Path(path).read_text().splitlines() if l.strip().startswith(key))
    return re.findall(r'"([0-9]+)"', line)


def honest_proof(k):
    return read_fields(INNER / f"out/batch_{k}/proof_fields.json")


def honest_pub(k):
    return read_fields(INNER / f"out/batch_{k}/public_inputs_fields.json")


def attack_proof(attack, tag):
    return read_fields(attack / f"out/{tag}/proof_fields.json")


def attack_pub(attack, tag):
    return read_fields(attack / f"out/{tag}/public_inputs_fields.json")


def context_hash():
    """The context of the honest run. The gate reads it from the generator
    output and exports it, because the shell truncates Prover.toml before this
    script runs."""
    value = os.environ.get("ZKPOR_CONTEXT_HASH")
    if not value:
        sys.exit("set ZKPOR_CONTEXT_HASH to the context_hash of the honest run")
    return value


def write_agg(vk, proofs, pubs):
    sys.stdout.write(
        f'context_hash = "{context_hash()}"\n'
        f"inner_vk = {arr(vk)}\nproofs = {rows(proofs)}\npub_inputs = {rows(pubs)}\n"
    )


def cmd_evil_prover(batch, kind):
    """An adversarial Prover.toml from pinned-batch data. Both attack circuits
    take the same fields, so one output serves both. `deflate` negates one
    balance, which only the circuit without the range check accepts."""
    ids = toml_list(INNER / f"Prover_{batch}.toml", "ids")
    balances = toml_list(INNER / f"Prover_{batch}.toml", "balances")
    salts = toml_list(INNER / f"Prover_{batch}.toml", "salts")
    if kind == "deflate":
        balances = list(balances)
        balances[0] = str(P - 100)  # -100: passes the no-range-check evil circuit
    sys.stdout.write(
        f'batch_slot = "{batch}"\nids = {quoted(ids)}\n'
        f"balances = {quoted(balances)}\nsalts = {quoted(salts)}\n"
    )


def cmd_agg_prover(kind):
    vk_h = read_fields(INNER / "out/vk_fields.json")
    k = global_u32("NUM_BATCHES_K")
    ph = [honest_proof(i) for i in range(k)]
    ih = [honest_pub(i) for i in range(k)]
    r_idx, t_idx = global_u32("SUBROOT_IDX"), global_u32("SUBTOTAL_IDX")

    if kind == "honest":
        write_agg(vk_h, ph, ih)
    elif kind == "foreignproof":
        # constraint 1: pinned vk kept, evil proof in slot 0 -> verify must fail.
        write_agg(vk_h, [attack_proof(EVIL, "batch_0")] + ph[1:],
                  [attack_pub(EVIL, "batch_0")] + ih[1:])
    elif kind == "deflate":
        # constraint 2: evil negative-balance batch proof -> rejected under pinned vk.
        write_agg(vk_h, [attack_proof(EVIL, "deflate")] + ph[1:],
                  [attack_pub(EVIL, "deflate")] + ih[1:])
    elif kind == "staleleaf":
        # constraint 1 again, with an honest total: the batch uses the old
        # two-input leaf and ignores the salt, so only the pinned key rejects it.
        write_agg(vk_h, [attack_proof(STALE, "batch_0")] + ph[1:],
                  [attack_pub(STALE, "batch_0")] + ih[1:])
    elif kind == "subtotal":
        # constraint 3: subtotal not matching the verified proof output.
        bad = list(ih[0]); bad[t_idx] = (bad[t_idx] - 1) % P
        write_agg(vk_h, ph, [bad] + ih[1:])
    elif kind == "subroot":
        # constraint 3: subroot not matching the verified proof output.
        bad = list(ih[0]); bad[r_idx] = (bad[r_idx] + 1) % P
        write_agg(vk_h, ph, [bad] + ih[1:])
    elif kind == "slot_replay":
        # constraint 4: batch 0's proof+pub replayed into slot 1 (slot stays 0).
        write_agg(vk_h, [ph[0], ph[0]] + ph[2:], [ih[0], ih[0]] + ih[2:])
    else:
        sys.exit(f"unknown agg-prover kind: {kind}")


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: cheats.py <evil-prover B KIND | agg-prover KIND>")
    if sys.argv[1] == "evil-prover":
        cmd_evil_prover(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "agg-prover":
        cmd_agg_prover(sys.argv[2])
    else:
        sys.exit(f"unknown command: {sys.argv[1]}")


if __name__ == "__main__":
    main()
