# Email evidence

This circuit proves that an authorized DKIM signer signed a customer identifier.
The exact Subject contains the identifier as 43 canonical base64url characters.
The registry accepts only nonzero identifiers in the BN254 scalar field.

The issuer registers the RSA key hashes, signing domain hash, and exact signed From field hash for one asset.
The registry assigns each registration a permanent ID and derives its application context.
Old registrations remain available after a new registration.
An email does not name the asset. Registration authorizes that signer binding for the asset, including emails that the signer signed before registration.
The same email can qualify for another asset if that asset authorizes the same signer binding.

## Inputs

All witness arguments are private:

- The canonical signed header bytes.
- The RSA modulus, reduction parameter, and signature.
- The header and DKIM tag positions.
- The application context that the registry supplies.

The circuit returns nine public fields:

| Index | Value |
| --- | --- |
| 0 | The registration context |
| 1 | The Poseidon hash of the RSA modulus |
| 2 | The Poseidon hash of the reduction parameter |
| 3, 4 | The high and low 128 bits of the signing domain SHA256 hash |
| 5, 6 | The high and low 128 bits of the signed From field SHA256 hash |
| 7, 8 | The Subject in two big endian 31-byte chunks, with zero padding on the right |

The registry derives all nine expected values. A caller cannot supply replacement public inputs.
The proof does not expose the email body, recipient, customer email, code, or balance.

## Supported input

- RSA uses an odd 2048-bit modulus and exponent 65537.
- DKIM uses `rsa-sha256` and `relaxed/relaxed` canonicalization.
- The canonical header contains fewer than 1024 bytes.
- Exactly one signed From field and one signed Subject field occur in that header.
- The complete From field contains at most 320 bytes.
- The lowercase ASCII signing domain contains at most 253 bytes, with at most 63 bytes per label.
- The final field is the DKIM signature field, with its signature value empty for verification.

Repeated From and Subject names in `h=` are permitted when they select absent extra fields.
This supports DKIM oversigning without accepting multiple actual signed From or Subject fields.
The From hash includes `from:`, its canonical value, and any display name. It excludes the final CRLF.
A display name change requires another registration.

The circuit checks the DKIM header signature. It does not check the body hash, delivery, recipient, or email date.
The evidence does not establish when the email existed relative to an attestation.

## Build and prepare

Use the separate compiler that `scripts/versions.env` pins as `EMAIL_NARGO_VERSION`.
Keep the core compiler unchanged.

```sh
npm ci --prefix tools/email
npm run build --workspace sdk
ZKPOR_EMAIL_NARGO=/absolute/path/to/email/nargo bash scripts/build_email.sh
node tools/email/witness.mjs prepare /private/customer.eml /private/new-prepared
```

The preparation command creates a private directory. It refuses an existing output directory.
Register its `registration.json` through `register_dkim_key`, with issuer authorization.
Read `get_dkim_key` at the returned key ID and use its `context_hash`:

```sh
node tools/email/witness.mjs witness /private/new-prepared CONTEXT /private/new-witness
cd /private/new-witness
/absolute/path/to/email/nargo execute
bb prove --scheme ultra_honk --oracle_hash keccak \
  -b target/zkpor_email.json -w target/zkpor_email.gz \
  --output_path proof --output_format bytes_and_fields
```

The proof scheme and oracle hash must match `scripts/versions.env` and the generated manifest.
The package requires the pinned Node version and its separate lockfile.
Keep preparation files, witness files, and proof logs private.

Deploy the email verifier with `scripts/deploy_email_verifier.sh`.
Pass both verifier IDs to `scripts/deploy_registry.sh`.
The registry constructor checks both actual verification keys.
Open the normal `open_dispute` entry point with `DisputeEvidence::Email`, the registration ID, identifier, and proof.
The existing answer window, deposit, answer, and resolution rules apply.

## Sources

- [Pinned DKIM verifier](https://github.com/zkemail/zkemail.nr/blob/8264758c6dbd6d5e29a3d58b482c3eb014424efb/lib/src/dkim.nr).
- [Pinned RSA verifier](https://github.com/noir-lang/noir_rsa/blob/v0.7.0/src/rsa.nr).
- [Pinned SHA256 constraints](https://github.com/noir-lang/sha256/blob/v0.1.2/src/sha256.nr).
- [DKIM canonicalization and oversigning, RFC 6376](https://www.rfc-editor.org/rfc/rfc6376.html#section-5.4.2).
