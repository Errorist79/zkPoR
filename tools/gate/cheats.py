#!/usr/bin/env python3
"""Build honest and cheat Prover.toml inputs for the aggregator hardening tests.

Adversarial test scaffolding for the soundness gate only -- NOT production.
Reads the bb `--output_format fields` outputs of the pinned inner circuit and the
adversarial inner_evil circuit, then emits aggregator Prover.toml variants (one
honest, several cheats) plus inner_evil Prover.toml witnesses. Each cheat targets
exactly one of the four hardening constraints so the aggregator's rejection is
attributable.

Field elements are emitted as decimal strings (the generator's format). All
arithmetic is mod the BN254 scalar field.
"""
import json
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
AGG = REC / "agg"


def read_fields(path):
    return [int(x, 16) for x in json.loads(Path(path).read_text())]


def idx(name):
    m = re.search(rf"pub global {name}: u32 = (\d+);", (AGG / "src/params.nr").read_text())
    return int(m.group(1))


def arr(values):
    return "[" + ", ".join(f'"{v % P}"' for v in values) + "]"


def rows(list_of_lists):
    return "[" + ", ".join(arr(v) for v in list_of_lists) + "]"


def toml_list(path, key):
    line = next(l for l in Path(path).read_text().splitlines() if l.strip().startswith(key))
    return re.findall(r'"([0-9]+)"', line)


def honest_proof(k):
    return read_fields(INNER / f"out/batch_{k}/proof_fields.json")


def honest_pub(k):
    return read_fields(INNER / f"out/batch_{k}/public_inputs_fields.json")


def evil_proof(tag):
    return read_fields(EVIL / f"out/{tag}/proof_fields.json")


def evil_pub(tag):
    return read_fields(EVIL / f"out/{tag}/public_inputs_fields.json")


def write_agg(vk, proofs, pubs):
    out = f"inner_vk = {arr(vk)}\nproofs = {rows(proofs)}\npub_inputs = {rows(pubs)}\n"
    sys.stdout.write(out)


def cmd_evil_prover(batch, kind):
    """inner_evil Prover.toml from pinned-batch data; `deflate` negates one balance."""
    ids = toml_list(INNER / f"Prover_{batch}.toml", "ids")
    balances = toml_list(INNER / f"Prover_{batch}.toml", "balances")
    if kind == "deflate":
        balances = list(balances)
        balances[0] = str(P - 100)  # -100: passes the no-range-check evil circuit
    ids_s = "[" + ", ".join(f'"{v}"' for v in ids) + "]"
    bal_s = "[" + ", ".join(f'"{v}"' for v in balances) + "]"
    sys.stdout.write(f'batch_slot = "{batch}"\nids = {ids_s}\nbalances = {bal_s}\n')


def cmd_agg_prover(kind):
    vk_h = read_fields(INNER / "out/vk_fields.json")
    vk_e = read_fields(EVIL / "out/vk_fields.json")
    ph, pe = [honest_proof(0), honest_proof(1)], None
    ih, ie = [honest_pub(0), honest_pub(1)], None
    s_idx, r_idx, t_idx = idx("SLOT_IDX"), idx("SUBROOT_IDX"), idx("SUBTOTAL_IDX")

    if kind == "honest":
        write_agg(vk_h, ph, ih)
    elif kind == "swapvk":
        # constraint 1: foreign vk -> in-circuit vk-hash assert must fail.
        write_agg(vk_e, [evil_proof("batch_0"), evil_proof("batch_1")],
                  [evil_pub("batch_0"), evil_pub("batch_1")])
    elif kind == "foreignproof":
        # constraint 1: pinned vk kept, evil proof in slot 0 -> verify must fail.
        write_agg(vk_h, [evil_proof("batch_0"), ph[1]], [evil_pub("batch_0"), ih[1]])
    elif kind == "deflate":
        # constraint 2: evil negative-balance batch proof -> rejected under pinned vk.
        write_agg(vk_h, [evil_proof("deflate"), ph[1]], [evil_pub("deflate"), ih[1]])
    elif kind == "subtotal":
        # constraint 3: subtotal not matching the verified proof output.
        bad = list(ih[0]); bad[t_idx] = (bad[t_idx] - 1) % P
        write_agg(vk_h, ph, [bad, ih[1]])
    elif kind == "subroot":
        # constraint 3: subroot not matching the verified proof output.
        bad = list(ih[0]); bad[r_idx] = (bad[r_idx] + 1) % P
        write_agg(vk_h, ph, [bad, ih[1]])
    elif kind == "slot_replay":
        # constraint 4: batch 0's proof+pub replayed into slot 1 (slot stays 0).
        write_agg(vk_h, [ph[0], ph[0]], [ih[0], ih[0]])
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
