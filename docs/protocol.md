# zkPoR protocol specification

This document specifies the data formats that the circuits, the registry
contract, and the witness generator share. Three implementations follow it:
Rust, Noir, and TypeScript. Each rule in this document is normative. The words
"must" and "must not" state requirements. This is a specification of the target
protocol; parts of it are not implemented yet.

## 1. Notation and primitives

### 1.1 Field elements

`Fr` is the scalar field of the BN254 curve. The modulus `r` is approximately
2^254. Every committed value in this protocol is an `Fr` element.

An `Fr` element serializes as exactly 32 bytes, big-endian, zero-padded on the
left. A parser must reject a 32-byte value that is greater than or equal to
`r`.

### 1.2 Hash function

`H_n` is the Poseidon2 hash of `n` inputs over `Fr`, with:

- state width 4 and rate 3;
- sponge capacity initialized to `n * 2^64`, where `n` is the input count.

The capacity value depends on the input count. Therefore a hash of 2 inputs
and a hash of 3 inputs can never collide, even on equal input prefixes. This
property separates the hash domains in this protocol. No extra domain tags are
needed for the tree.

An implementation must not substitute another Poseidon variant, another state
width, or another capacity rule. Any such substitution changes every root and
every proof in the system.

Two hashes with the same input count share one hash domain. This protocol
has one such meeting: a tree node of section 5 and a one-address reserve
set hash of section 3.3 both take two inputs. No substitution path exists
between them. The registry computes `reserve_set_hash` from the addresses
itself, so a prover cannot supply a tree node in its place. An equality
would also need a node whose two inputs equal an address limb pair. Node
inputs are hash outputs, the limbs are below 2^129 and 2^128, and no known
method produces such a node.

The inner key tree of section 2.1 and the liabilities tree of section 5
share the two-input domain, so a value from one tree could in principle
appear in the other. This is safe because section 2.1 fixes the position
of each public input, and section 2.2 forbids a consumer to locate a
public input by its value. An edit that relaxes either rule reopens this
question.

A future protocol version must not add a hash at an input count already
in use, unless the new preimage starts with a domain tag. The salt
derivation of section 4.2 follows this rule.

### 1.3 Test vectors

A hand computation of Poseidon2 is not practical. Therefore this document
contains no example hash values. The shared Rust crate is the reference
implementation of every algorithm in this document. It generates the test
vector files. The Noir and TypeScript implementations must reproduce those
vectors exactly, and their test suites must fail on any mismatch. The
vectors cover computed values only. They do not fix the identity of a
reported error, in agreement with section 3.3.

### 1.4 Configuration parameters

Two parameters shape the tree:

- `B`: the number of customer leaves in one batch. `B` is a power of two, at
  least 2.
- `K`: the number of batches that one aggregation folds. `K` is a power of
  two, at least 2.

Both values live in one configuration file, `circuits/recursion/params.toml`.
A generator writes them into the circuit sources. No implementation may
hard-code them elsewhere.

## 2. Aggregator public input vector

### 2.1 Elements and order

The terminal aggregator proof exposes exactly four public inputs, in this
order:

| index | name             | type              | meaning |
|------:|------------------|-------------------|---------|
| 0     | `context_hash`   | `Fr`              | Binds the proof to one registered authority, one asset, one reserve address set, and one snapshot. Section 3 defines it. |
| 1     | `inner_key_hash` | `Fr`              | The Poseidon2 tree hash of the pinned inner verification key: the key's field vector, zero-padded to the next power of two, hashed as the tree of section 5. The aggregator circuit computes it and asserts it against a generated constant. |
| 2     | `final_root`     | `Fr`              | The root of the liabilities tree over all `B*K` leaves. Section 5 defines the tree. |
| 3     | `L`              | `u128` in an `Fr` | The total liabilities. The sum of all `u64` balances in the tree, accumulated in `u128`. |

`context_hash` is a public parameter of the aggregator circuit. The circuit
does not constrain its value. Its purpose is binding: the proof transcript
commits to it, so a proof that carries one `context_hash` cannot verify as a
proof that carries another. The registry recomputes the expected value from
its own state and builds the public input bytes itself, so a prover cannot
substitute a foreign context.

### 2.2 Serialization

The on-chain verifier takes a `public_inputs` byte string. The byte string
must be the concatenation of the four elements above, in index order, each
serialized as 32 bytes big-endian. The total length is exactly 128 bytes.
There is no length prefix, no separator, and no padding.

The four positions are normative. A tool may map this order onto the
vector that a prover toolchain emits. It must establish the mapping from
toolchain metadata or from pairwise distinct probe values. It must fail
when the mapping is not unique, and it must write the result into a
generated artifact. A consumer must read the positions from that artifact.
A consumer must not locate a public input by its value, and it must not
hard-code a position. Two public inputs can hold the same field value, so
a search by value can find the wrong position.

### 2.3 The pairing point accumulator occupies no slot

An UltraHonk recursive proof carries a pairing point accumulator of 16 `Fr`
limbs. That accumulator is part of the proof bytes: it is the first 16 field
elements of the 456-field proof. It is not part of the `public_inputs`
argument. The verifier appends the accumulator after the supplied public
inputs internally when it computes the public input delta, and it completes
the deferred pairing from the proof-side limbs.

An implementation must not place the 16 accumulator limbs into the
`public_inputs` byte string. The verifier requires the supplied element count
to equal the verification key's public input count minus 16. A byte string
with the accumulator included has the wrong length, and the verifier rejects
every proof submitted with it. This failure mode gives no other diagnostic,
which is why this rule is stated here.

## 3. Context hash

### 3.1 Preimage

```
context_hash = H_7([
    CTX_DOMAIN_TAG,
    authority_hi, authority_lo,
    asset_hi,     asset_lo,
    reserve_set_hash,
    snapshot_ledger,
])
```

The preimage has exactly 7 elements, in this order:

1. `CTX_DOMAIN_TAG`
2. `authority_hi`
3. `authority_lo`
4. `asset_hi`
5. `asset_lo`
6. `reserve_set_hash`
7. `snapshot_ledger`

`authority` is the address that the registry records for the asset at
registration: the issuer account of a classic asset, or the authenticated
administrator of a contract token. Section 7 defines the two cases.

`CTX_DOMAIN_TAG` is the `Fr` element whose big-endian byte representation is
the ASCII string `zkpor-context-v1` (16 bytes), left-padded with zero bytes to
32 bytes. This tag versions the preimage layout. Any change to the field list
or the order must change the tag string.

`snapshot_ledger` is a Stellar ledger sequence number, a `u32`, embedded into
`Fr` as its integer value. Section 6 defines its meaning.

The expiry window is not part of the preimage. The window is a policy
constant that the registry enforces. A prover-supplied expiry would let the
authority choose its own validity period, so the protocol excludes it from
the proof.

### 3.2 Address encoding

Stellar defines five address types. The XDR enum `SCAddressType` declares
them with these discriminants: account = 0, contract = 1, muxed account = 2,
claimable balance = 3, liquidity pool = 4 (stellar-xdr 26.0.1,
`src/curr/generated.rs`, lines 11712 to 11743; the five-variant `ScAddress`
enum is at line 11946 of the same file).

This protocol accepts exactly two of these types. An authority address, an
asset address, and every reserve address must be one of:

- tag 0: an account address, with a 32-byte ed25519 public key as the
  payload;
- tag 1: a contract address, with the 32-byte contract id as the payload.

The tag values equal the XDR discriminants of the accepted types. The
registry and the witness generator must reject an address of any other type
at the point of entry. The reason is the shape of the encoding below: it is
defined over a fixed 32-byte payload, and the other types do not have that
shape. A muxed account carries a 32-byte ed25519 key plus a separate `u64`
id (stellar-xdr 26.0.1, `src/curr/generated.rs`, `MuxedEd25519Account` at
line 11862). An encoding that reads only the key would map two different
muxed accounts with the same key onto the same limb pair. That collision
breaks the binding between the proof and the reserve set, so a partial
encoding is forbidden and the type is rejected instead.

The rejection of the other address types is a requirement on every
implementation, in every language. The address types that a language can
represent differ. In soroban-sdk 26.0.1, an `Address` value cannot hold a
rejected type. `Address::from_string` accepts only account (`G...`) and
contract (`C...`) strkeys (`src/address.rs`). The payload conversion
returns no value for any other type (`src/address_payload.rs`). In the
Stellar SDK for JavaScript, the `Address` class parses and holds all five
types (`js-stellar-base`, `src/address.js`). A muxed strkey (`M...`)
parses there normally. An implementation must not drop the rejection
because another implementation cannot trigger it. Every implementation
must have a negative test that submits each rejected address type and
confirms the rejection.

If a future protocol version accepts an additional address type, the
accepted tag list changes. That changes the meaning of the preimage, so the
`CTX_DOMAIN_TAG` string of section 3.1 must change with it.

An accepted address encodes into exactly two `Fr` elements:

```
addr_hi = tag * 2^128 + be_u128(payload[0..16])
addr_lo = be_u128(payload[16..32])
```

`be_u128` reads 16 bytes as a big-endian unsigned integer. Both limbs are
below 2^129, and 2^129 is far below `r`, so the encoding never wraps. The
encoding is injective: two different addresses always produce two different
limb pairs.

An implementation must not compress a 32-byte payload into a single `Fr`
element. `Fr` holds approximately 254 bits, so a single-element encoding must
drop bits. Dropped bits create pairs of distinct addresses with equal
encodings, and such a collision breaks the binding between the proof and the
reserve set. The encoding is injective over the accepted address types
because the tag and every payload bit survive in the limb pair.

### 3.3 Reserve set hash

`reserve_set_hash` commits to the set of authorized reserve addresses:

1. Reject the set if any address is not an accepted type per section 3.2.
2. Sort the addresses in ascending lexicographic order of the sort key. The
   sort key of an address is 33 bytes: the tag as one byte, then the 32-byte
   payload.
3. Reject the set if it contains a duplicate address.
4. Reject the set if it is empty or larger than `MAX_RESERVE_ADDRESSES` (16).
5. Encode each address as `(addr_hi, addr_lo)` per section 3.2.
6. Concatenate the limb pairs in sorted order into one list of `2N` elements.
7. `reserve_set_hash = H_2N(list)`.

The steps define the value and the rejection rules. They do not fix an
execution order. An implementation may evaluate the rejection rules of
steps 1, 3, and 4 in any order. When a set violates more than one rule, the
implementation may report any one of the violated rules. Only the accept or
reject outcome is normative. The identity of the reported error is not.

Two other comparisons produce the same order as the sort key. A comparison
by the tag as an integer, then by the payload bytes, is equivalent, because
both accepted tags fit in one byte. A comparison by the encoded limb pair
`(addr_hi, addr_lo)` as a pair of integers is also equivalent. It is
equivalent because the tag occupies the highest bits of `addr_hi`. An
implementation may sort with any of the three.

The sort makes the value a set hash: the same addresses in any submission
order produce the same hash. The capacity rule of section 1.2 encodes the
element count, so sets of different sizes cannot collide.

## 4. Leaf construction

### 4.1 Salted leaf

```
leaf = H_3([id, balance, salt])
```

- `id` is an opaque customer identifier as an `Fr` element. It must not be
  raw personal data. The authority keeps the mapping from `id` to the customer
  outside this protocol.
- `balance` is the customer liability as a `u64`, embedded into `Fr`. The
  inner circuit must range-check it as `u64`. The sum accumulator must be
  `u128`.
- `salt` is a blinding value as a full `Fr` element.

The salt makes the leaf hash unguessable. A customer who verifies their own
inclusion receives sibling hashes from the tree. Balances have low entropy,
so an unsalted sibling hash would fall to a brute-force search over
plausible `(id, balance)` pairs. The salt term adds approximately 254 bits of
entropy per leaf and closes that search.

### 4.2 Salt derivation

```
salt_i = H_4([SALT_DOMAIN_TAG, master_secret, context_hash, i])
```

- `SALT_DOMAIN_TAG` is the `Fr` element whose big-endian byte representation
  is the ASCII string `zkpor-salt-v1` (13 bytes), left-padded with zero
  bytes to 32 bytes. The tag separates the salt derivation from every other
  hash in this protocol. The input count alone does not separate it,
  because a reserve set of two addresses also hashes four inputs.
- `master_secret` is 32 bytes from a cryptographically secure random source,
  reduced modulo `r`. The authority must keep it confidential and must not put
  it into any circuit witness or any distributed file.
- `context_hash` is the value of section 3.1 for this attestation. It binds
  every salt to one authority, one asset, one reserve address set, and one
  snapshot. Two attestations with different contexts therefore never share
  a salt, even at the same snapshot ledger.
- `i` is the global leaf index of section 5.2, embedded into `Fr`.

The derivation has no circular dependency. The salts build the leaves, and
no input of the context hash depends on a leaf or on the root. Every input
of the context hash is fixed before the derivation starts. A change to the
reserve set or to the snapshot changes the context hash, so it changes
every salt and every leaf. The authority must fix both before it derives
the salts.

The derivation runs outside every circuit. The circuits receive each salt as
a private input and never see the master secret. The derivation does not
change any verification key. The authority stores one secret instead of one
salt per customer.

A leaked salt exposes exactly one leaf. With `salt_i`, a third party can test
candidate `(id, balance)` pairs for leaf `i` only. The salts of all other
leaves stay independent, so the sibling hashes of the leaked leaf reveal
nothing. The other derivation inputs are public, so a leaked `master_secret`
exposes every leaf of every context that used it. The secret must never
leave the authority's environment. The authority may rotate the secret
between snapshots to bound that exposure.

### 4.3 Padding leaves

The tree holds exactly `B*K` leaves. When the customer count is smaller, the
authority fills the remaining positions with padding leaves:

- `id = 0`;
- `balance = 0`;
- `salt` derived by the rule of section 4.2 for the padding position.

A padding leaf adds zero to `L`. Because its salt is real, a padding leaf is
indistinguishable from a customer leaf, so the tree does not reveal the true
customer count. The authority must not issue an inclusion package for a padding
leaf.

The tree capacity bounds the customer count. A count equal to `B*K` needs
no padding leaf. A count below `B*K` fills every remaining position with a
padding leaf. A generator must reject a count above `B*K`. It must not
truncate the list, because a silent truncation removes liabilities from
`L`.

## 5. Tree and authentication path

### 5.1 One uniform tree

The liabilities tree is one full binary Poseidon2 tree over all `B*K`
leaves. Internal nodes use the two-input hash:

```
parent = H_2([left, right])
```

The batch structure does not change the hash structure. Each inner circuit
computes the root of its `B`-leaf subtree, and the aggregator folds the `K`
subtree roots with the same `H_2`. The result equals the root of the single
tree over all `B*K` leaves. A verifier of an authentication path therefore
never needs to know where a batch boundary is.

### 5.2 Global leaf index

The leaf of batch `k` at batch-local position `j` has the global index:

```
g = k * B + j        with 0 <= g < B*K
```

### 5.3 Depth

```
D = log2(B) + log2(K) = log2(B*K)
```

An authentication path has exactly `D` sibling hashes.

### 5.4 Path format and direction rule

An authentication path for leaf `g` is the ordered list
`siblings[0..D]`, from the leaf level up to the level below the root. The
direction at each level derives from the index. No separate direction bits
exist, so no direction bit can disagree with the index.

Verification algorithm:

```
node = H_3([id, balance, salt])
for d in 0..D:
    if bit d of g == 0:            # bit 0 is the least significant bit
        node = H_2([node, siblings[d]])
    else:
        node = H_2([siblings[d], node])
if node == final_root: accept
else: reject
```

Bit `d` of `g` states the position of the current node at level `d`: 0 means
the node is the left input, 1 means the node is the right input. Sibling
hashes serialize as 32-byte big-endian `Fr` per section 1.1.

## 6. Snapshot and expiry

### 6.1 Meaning of the snapshot

`snapshot_ledger` is the ledger sequence number at which the authority
declares the liability set frozen. It is the authority's claim. No component
of this protocol can verify that the frozen set matches the real obligations
of the authority at that ledger, and no component can verify the claimed time of the
freeze. The window of section 6.2 bounds the claim: the chain assigns the
execution ledger `e`, so the declared snapshot can differ from `e` by at
most 720 ledgers. The customer inclusion check makes an omitted liability
detectable to the omitted customer; it does not prove the set is complete.

### 6.2 The expiry window

```
ATTESTATION_MAX_AGE_LEDGERS = 720
```

On the Stellar test network, the measured average close interval over 60
consecutive ledgers is 5 seconds. 720 ledgers is therefore approximately one
hour. The window must cover proof generation plus submission with margin,
and it must keep the declared snapshot close to the verifiable reading. One
hour satisfies both at the current proving cost.

The registry must enforce, at the ledger `e` where the attestation
transaction executes:

```
snapshot_ledger <= e <= snapshot_ledger + ATTESTATION_MAX_AGE_LEDGERS
```

The registry must reject an attestation outside this range. After
acceptance, an attestation older than the same window counts as stale: the
inclusion claim under its root still holds, but the solvency claim has
lapsed until a fresher attestation replaces it.

### 6.3 The two reserve readings

The registry produces two different reserve numbers, and they must never
share a name, a field, or a headline:

- `reserve_sum`, with `attested_ledger`: the sum of the registered reserve
  balances that the registry read inside the attestation transaction, at
  ledger `e`. This value is part of the attestation record. Interfaces
  present it as "reserves at attestation (ledger e)".
- `observe_reserves`: a separate read-only function that returns the current
  sum and the ledger of the reading. No attestation covers this value.
  Interfaces present it as an observation and must state that the
  attestation does not cover it.

### 6.4 What an accepted attestation proves

An accepted attestation proves the following. The proof verified under the
pinned verification keys. The proof binds the liabilities root, the total
`L`, the registered authority, the asset, the reserve set, and the snapshot
ledger `s`. At the ledger `e` where the attestation executed, with
`s <= e <= s + 720`, the registered addresses held the recorded
`reserve_sum`, read in the same transaction.

An accepted attestation does not prove the following:

- It does not prove that the liability set is complete. An omitted customer
  can detect the omission, and nothing else can.
- It does not prove that the authority held the reserves at any ledger other
  than `e`. The balances are read inside the attestation transaction. A
  Soroban transaction is one atomic invocation tree, so funds can enter a
  reserve address before the reading and leave after the reading, inside
  the same transaction. When a willing capital source exists whose funds
  can move inside that transaction, the cost of presenting borrowed funds
  is the transaction fee plus whatever the source charges. It is not
  interest on a loan over the window. When no such source exists, the
  presenter needs a real loan that spans at least one transaction boundary.
- Liabilities created or removed between `snapshot_ledger` and `e` are
  invisible to the attestation.

The second limit is not specific to this system. It holds for every
point-in-time proof of reserves on every chain with atomic composition,
because the reading is part of a transaction that the authority submits. Two
things raise the cost in practice: the history of repeated attestations,
which a reader should weigh over any single one, and the public balance
history of the registered addresses, which anyone can inspect at ledgers
the authority did not choose.

## 7. Registration and authorization

### 7.1 Asset registration, two tiers

The registry supports two kinds of asset, with different verifiable claims:

1. A classic Stellar asset. Registration supplies the serialized `Asset`
   XDR, the issuer account address, and the asset contract address. The
   registry derives the canonical asset contract address from the
   serialized asset through the host (in soroban-sdk 26.0.1:
   `env.deployer().with_stellar_asset(serialized_asset).deployed_address()`)
   and must reject the registration when the derived address does not equal
   the supplied one. The registry must also reject the registration when
   the issuer account inside the serialized asset does not equal the
   supplied issuer address. The issuer account must authorize the
   registration. The verified claim is: the authenticated account is the
   issuer of this asset, and the registered contract address is that
   asset's canonical asset contract.
2. A contract token. Registration supplies the token contract address. The
   registry calls the token's `admin()` function and requires authorization
   from the returned address. The verified claim is: the address that the
   token contract itself designates as administrator authorized this
   registration. This is weaker than tier 1, and every interface and
   document must use the word "administrator", not "issuer", for tier 2.
   A contract token must expose the `admin()` function of the Stellar
   Asset administrative interface. A token without it cannot be
   registered. The `admin()` value is code that the token author wrote, so
   tier 2 does not prove provenance: the surviving attack is registering a
   lookalike token that the attacker deployed, and the record then names
   the attacker as administrator of the attacker's own contract. Readers
   must identify an asset by its contract address, never by its symbol.

The native asset (XLM) has no registration path, as a deliberate scope
boundary: the native asset has no issuer account, so tier 1 cannot apply,
and its asset contract has no administrator, so the `admin()` call of
tier 2 fails (verified on the test network: the native asset contract
answers `name()` and returns a missing-value error for `admin()`). No party
can authenticate as the authority of the native asset, so the registry must
reject it under both tiers.

An asset registers once; the first registration wins. Later changes require
authorization from the recorded authority (the issuer account for tier 1,
the administrator for tier 2).

### 7.2 Reserve-address authorization

Every reserve address must authorize `register_asset` and every
`set_reserves` call, through `require_auth` with the full argument list of
the invocation. An implementation must not reduce the authorized arguments.
The full-argument form binds each consent to this registry contract, this
function, the exact asset, the exact authority, and the exact reserve list,
on this network, with a single-use nonce and an expiration. A captured
authorization therefore cannot be replayed into a later call, redirected to
another registry, or attached to a different reserve set.

Consequences of the authorization model:

- An account reserve address signs an authorization entry (standard Stellar
  multisig rules apply).
- A contract reserve address passes `require_auth` only when it is the
  invoker of the call or a custom account that implements `__check_auth`.
  A passive token-holding contract is neither, so it cannot be registered
  as a reserve address. This exclusion is deliberate: without it, any rich
  passive contract address could be named a reserve without consent.
- Registering an unwilling third party's address is prevented. Registering
  a willing collaborator's address remains possible, and the collaboration
  is co-signed inside the registration transaction, so it is publicly
  attributable.

The registry records consent only. It holds no funds, moves no funds, and
takes no authority over any balance.

## 8. Verification key binding

The verifier contract stores its verification key once, at deployment, with
no upgrade path. The registry must not trust a verifier address by
configuration alone. The binding is mechanical:

- The aggregator verification key (1,760 bytes) is a committed artifact in
  the repository, regenerated by the build tooling, never edited by hand.
- The registry compiles in the SHA-256 hash of that artifact and the
  expected `inner_key_hash` as generated constants.
- At its own deployment, the registry reads the verifier's stored key
  bytes, computes their SHA-256 hash, and must fail deployment when the
  hash does not equal the compiled-in constant.
- Continuous integration recompiles the aggregator with the pinned
  toolchain, regenerates the key, and fails when the bytes differ from the
  committed artifact.

A circuit change therefore produces a new key, a new verifier contract
address, and a new registry deployment. Nothing is mutable after
deployment, so there is no rotation authority to trust. Clients read the
current contract addresses from a committed deployments file in the
repository.
