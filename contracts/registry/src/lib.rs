#![no_std]
//! Registry of assets, authorities, and authorized reserve addresses.
//!
//! The registry records consent. It holds no funds, it moves no funds, and it
//! takes no authority over any balance.
//!
//! Two claims are verifiable at registration. For a classic asset, the
//! registry derives the canonical asset contract address from the serialized
//! asset and requires the authorization of the issuer account inside it. For a
//! contract token, the registry asks the token for its administrator and
//! requires the authorization of the address that the token names. The second
//! claim is weaker, so the two tiers stay separate in storage and in every
//! interface.
//!
//! Every reserve address authorizes the call with the full argument list, so a
//! captured consent binds to this contract, this function, this asset, this
//! authority, and this reserve list. No reserve address may be the recorded
//! authority.
//!
//! The address encoding and the reserve set hash come from zkpor-context,
//! which is the one Rust definition of both.
//!
//! Every write extends the entry that it writes, and the contract instance,
//! to the largest time to live that the network allows at that ledger. If an
//! entry reaches the end of its time to live, the network archives it and
//! does not delete it. A later call that touches the entry restores it inside
//! the same transaction, and the caller pays the restore. Until such a call
//! happens, a read of an archived entry answers nothing, so a reader of an
//! asset that no party touched for a long time must restore the entry first.

use soroban_sdk::{
    address_payload::AddressPayload, contract, contracterror, contractevent, contractimpl,
    contracttype, symbol_short, Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec, U256,
};
use zkpor_context::{
    context_hash, fr_in_range, reserve_set_hash, ContextError, ATTESTATION_MAX_AGE_LEDGERS,
};

pub mod params;

/// XDR discriminant of the native asset. The union carries no arm, so the
/// serialized value is the discriminant alone.
const ASSET_TYPE_NATIVE: u32 = 0;
/// XDR discriminant of a classic asset with a four-character code.
pub const ASSET_TYPE_ALPHANUM4: u32 = 1;
/// XDR discriminant of a classic asset with a twelve-character code.
pub const ASSET_TYPE_ALPHANUM12: u32 = 2;
/// The only public key type of an account identifier.
pub const PUBLIC_KEY_TYPE_ED25519: u32 = 0;
/// Byte length of an XDR union discriminant.
const XDR_DISCRIMINANT_BYTES: u32 = 4;
/// Byte length of a four-character asset code.
const ASSET_CODE4_BYTES: u32 = 4;
/// Byte length of a twelve-character asset code.
const ASSET_CODE12_BYTES: u32 = 12;
/// Byte length of an ed25519 public key.
const ED25519_KEY_BYTES: u32 = 32;
/// The serialized native asset.
pub const NATIVE_ASSET_XDR: [u8; XDR_DISCRIMINANT_BYTES as usize] = [0, 0, 0, 0];
/// The function of the Stellar Asset administrative interface that names the
/// administrator of a contract token.
const ADMIN_FN: Symbol = symbol_short!("admin");
/// The function of the verifier contract that returns its stored key.
const VK_BYTES_FN: Symbol = symbol_short!("vk_bytes");
/// The function of the standard token interface that answers the balance of
/// one address.
const BALANCE_FN: Symbol = symbol_short!("balance");
/// The function of the verifier contract that checks one proof. The name is
/// longer than a short symbol, so it is built at the call.
const VERIFY_PROOF_FN: &str = "verify_proof";

/// Why the registry refused, as a number.
///
/// A refusal reaches a caller as this number and as nothing else. The client
/// keeps its own copy of the list, and a test of the client compares the two
/// against this file, so a name that moves to another number fails there.
///
/// Give a new error the next free number. Never give an old number to a new
/// meaning. A client built before the change reports an unknown number
/// honestly, and it reports a reused number as the error the number used to
/// mean, which is worse than an unknown one.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// A reserve address, an authority address, or an asset address is of a
    /// type that this protocol does not accept.
    UnsupportedAddressType = 1,
    /// The reserve set holds no address.
    EmptyReserveSet = 2,
    /// The reserve set holds more addresses than the protocol accepts.
    TooManyReserveAddresses = 3,
    /// The reserve set names one address two times.
    DuplicateReserveAddress = 4,
    /// The verifier at the supplied address holds another key than the one
    /// this build expects.
    VerifierKeyMismatch = 5,
    /// The asset already has an entry. The first registration wins.
    AssetAlreadyRegistered = 6,
    /// The asset has no entry.
    AssetNotRegistered = 7,
    /// The serialized asset does not have the shape of a classic asset with an
    /// issuer account.
    MalformedAsset = 8,
    /// The native asset has no authority that a party can authenticate, so it
    /// has no registration path.
    NativeAssetNotSupported = 9,
    /// The supplied address is not the canonical asset contract of the
    /// serialized asset.
    NotTheCanonicalAssetContract = 10,
    /// The issuer account inside the serialized asset is not the supplied
    /// authority.
    IssuerMismatch = 11,
    /// The token contract answers no administrator.
    AdministratorMissing = 12,
    /// The administrator that the token contract names is not the supplied
    /// authority.
    AdministratorMismatch = 13,
    /// The reserve set names the recorded authority, which can create the
    /// asset, so its balance is not backing.
    AuthorityInReserveSet = 14,
    /// The ledger of the transaction is before the snapshot ledger, or later
    /// than the age window allows.
    SnapshotOutsideWindow = 15,
    /// The verifier did not accept the proof under the public inputs that the
    /// registry built.
    ProofRejected = 16,
    /// A reserve balance did not read. An account without a trustline in the
    /// asset is the common cause.
    ReserveBalanceUnavailable = 17,
    /// The sum of the reserve balances leaves the range of the balance type.
    ReserveSumOverflow = 18,
    /// The registry holds no verifier address. A deployed registry always
    /// holds one, so this reports a corrupted instance.
    VerifierNotSet = 19,
    /// The submitted root is not a field element, so the proof would carry
    /// its reduction while the record kept the submitted value.
    RootOutOfRange = 20,
}

/// The reasons of the shared encoding keep their identity here. A caller reads
/// one reason space, and the registry adds no new meaning to these four.
impl From<ContextError> for Error {
    fn from(error: ContextError) -> Self {
        match error {
            ContextError::UnsupportedAddressType => Error::UnsupportedAddressType,
            ContextError::EmptyReserveSet => Error::EmptyReserveSet,
            ContextError::TooManyReserveAddresses => Error::TooManyReserveAddresses,
            ContextError::DuplicateReserveAddress => Error::DuplicateReserveAddress,
        }
    }
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// The verifier contract that this registry reads proofs through.
    Verifier,
    /// The entry of one asset.
    Asset(Address),
}

/// What the registry verified about the authority at registration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AssetTier {
    /// The authenticated account is the issuer of a classic asset, and the
    /// registered address is that asset's canonical asset contract.
    ClassicIssuer,
    /// The token contract names the authenticated address as its
    /// administrator. This claim does not prove provenance.
    ContractAdministrator,
}

/// What the caller supplies for the tier that it claims.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AssetAuthenticity {
    /// The serialized classic `Asset` XDR of the asset to register.
    Classic(Bytes),
    /// A contract token answers for itself, so this tier supplies nothing.
    Contract,
}

/// The record of one accepted attestation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Attestation {
    /// The root of the liabilities tree.
    pub final_root: U256,
    /// The total liabilities under that root.
    pub total_liabilities: u128,
    /// The ledger at which the authority declares the liability set frozen.
    pub snapshot_ledger: u32,
    /// The sum of the reserve balances that the registry read inside the
    /// attestation transaction.
    pub reserve_sum: i128,
    /// The ledger at which the registry read the reserve balances.
    pub attested_ledger: u32,
}

/// The attestation slot of an entry.
///
/// Do not simplify this type to `Option<Attestation>`. That shape does not
/// compile: soroban-sdk 26.0.1 converts an `Option<T>` only for a `T` whose
/// conversion cannot fail, and the conversion that `contracttype` writes for
/// a struct can fail.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AttestationSlot {
    /// The asset has no attestation.
    Empty,
    /// The last accepted attestation.
    Filled(Attestation),
}

/// The entry of one registered asset.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetEntry {
    /// The issuer account or the administrator, by tier.
    pub authority: Address,
    /// The claim that the registry verified about the authority.
    pub tier: AssetTier,
    /// The reserve addresses, in the order that the caller supplied.
    pub reserves: Vec<Address>,
    /// The commitment to the reserve address set. The order of the submission
    /// does not change it.
    pub reserve_set_hash: U256,
    /// The last accepted attestation, or the empty slot.
    pub attestation: AttestationSlot,
}

/// A reading of the reserve balances that no attestation covers.
///
/// The field names do not repeat the names of the attestation record. A
/// reader must never take this value for a number that a proof and a
/// verifier stand behind.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReserveObservation {
    /// The sum of the reserve balances at the ledger of the reading.
    pub observed_sum: i128,
    /// The ledger of the reading.
    pub observed_ledger: u32,
}

/// The registry accepted one attestation.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestationAccepted {
    /// The asset of the attestation.
    #[topic]
    pub asset: Address,
    /// The ledger at which the authority declares the liability set frozen.
    pub snapshot_ledger: u32,
    /// The ledger at which the registry read the reserve balances.
    pub attested_ledger: u32,
    /// The total liabilities under the attested root.
    pub total_liabilities: u128,
    /// The sum of the reserve balances at the attested ledger.
    pub reserve_sum: i128,
    /// The root of the liabilities tree.
    pub final_root: U256,
}

/// Reads a big-endian `u32` at one offset of a byte string.
fn u32_at(bytes: &Bytes, offset: u32) -> Result<u32, Error> {
    if bytes.len() < offset + XDR_DISCRIMINANT_BYTES {
        return Err(Error::MalformedAsset);
    }
    let mut value = 0u32;
    for index in 0..XDR_DISCRIMINANT_BYTES {
        value = (value << 8) | bytes.get_unchecked(offset + index) as u32;
    }
    Ok(value)
}

/// The issuer account of a serialized classic asset.
///
/// The layout is the asset type, the asset code, the public key type, and the
/// 32-byte ed25519 key. The length must be exact, because trailing bytes mean
/// the caller serialized another value.
fn classic_issuer(env: &Env, serialized_asset: &Bytes) -> Result<Address, Error> {
    let code_bytes = match u32_at(serialized_asset, 0)? {
        ASSET_TYPE_NATIVE => return Err(Error::NativeAssetNotSupported),
        ASSET_TYPE_ALPHANUM4 => ASSET_CODE4_BYTES,
        ASSET_TYPE_ALPHANUM12 => ASSET_CODE12_BYTES,
        _ => return Err(Error::MalformedAsset),
    };
    let key_type_at = XDR_DISCRIMINANT_BYTES + code_bytes;
    let key_at = key_type_at + XDR_DISCRIMINANT_BYTES;
    if serialized_asset.len() != key_at + ED25519_KEY_BYTES {
        return Err(Error::MalformedAsset);
    }
    if u32_at(serialized_asset, key_type_at)? != PUBLIC_KEY_TYPE_ED25519 {
        return Err(Error::MalformedAsset);
    }
    let key: BytesN<{ ED25519_KEY_BYTES as usize }> = serialized_asset
        .slice(key_at..key_at + ED25519_KEY_BYTES)
        .try_into()
        .map_err(|_| Error::MalformedAsset)?;
    Ok(Address::from_payload(
        env,
        AddressPayload::AccountIdPublicKeyEd25519(key),
    ))
}

/// The canonical asset contract address of the native asset.
fn native_asset_contract(env: &Env) -> Address {
    env.deployer()
        .with_stellar_asset(Bytes::from_array(env, &NATIVE_ASSET_XDR))
        .deployed_address()
}

/// The administrator that a contract token names.
///
/// A token without the function of the administrative interface answers
/// nothing, and such a token has no registration path.
fn administrator(env: &Env, asset: &Address) -> Result<Address, Error> {
    env.try_invoke_contract::<Address, Error>(asset, &ADMIN_FN, Vec::new(env))
        .map_err(|_| Error::AdministratorMissing)?
        .map_err(|_| Error::AdministratorMissing)
}

/// Refuses a reserve set that names the recorded authority.
///
/// A reserve balance means backing only when the holder cannot create the
/// asset. The authority can create it under both tiers: the host answers the
/// largest signed 64-bit value for the balance of a classic issuer in its own
/// asset, and the mint function of the standard administrative interface
/// requires the authorization of the administrator. A guard on the balance
/// value would not do this work, because the balance of an administrator
/// reads like any other balance.
fn reject_authority_as_reserve(reserves: &Vec<Address>, authority: &Address) -> Result<(), Error> {
    for reserve in reserves.iter() {
        if reserve == *authority {
            return Err(Error::AuthorityInReserveSet);
        }
    }
    Ok(())
}

/// Builds the public input byte string of the terminal proof.
///
/// The registry writes every element itself, from its own state and from the
/// typed arguments of the call, so no caller can put a foreign context in
/// front of a proof. Each element is 32 bytes big-endian, and the position of
/// each one comes from the generated artifact, because two elements can hold
/// one value and a search by value can find the wrong position.
fn public_inputs(env: &Env, context: &U256, final_root: &U256, total_liabilities: u128) -> Bytes {
    let mut fields: Vec<Bytes> = Vec::new(env);
    for _ in 0..params::PUBLIC_INPUT_COUNT {
        fields.push_back(Bytes::new(env));
    }
    fields.set(params::CONTEXT_HASH_INDEX, context.to_be_bytes());
    fields.set(
        params::INNER_KEY_HASH_INDEX,
        Bytes::from_array(env, &params::INNER_KEY_HASH),
    );
    fields.set(params::FINAL_ROOT_INDEX, final_root.to_be_bytes());
    fields.set(
        params::L_INDEX,
        U256::from_u128(env, total_liabilities).to_be_bytes(),
    );

    let mut inputs = Bytes::new(env);
    for field in fields.iter() {
        inputs.append(&field);
    }
    inputs
}

/// Asks the verifier to check one proof under the public inputs above.
///
/// Every failure reads the same way here. The registry builds the byte string
/// itself, and its deployment bound the key of this verifier, so a refusal
/// that is not a failed proof would mean the artifact and the deployed key
/// disagree, which the constructor already prevents.
fn verify(env: &Env, inputs: &Bytes, proof: &Bytes) -> Result<(), Error> {
    let verifier: Address = env
        .storage()
        .instance()
        .get(&DataKey::Verifier)
        .ok_or(Error::VerifierNotSet)?;
    let mut args: Vec<soroban_sdk::Val> = Vec::new(env);
    args.push_back(inputs.into_val(env));
    args.push_back(proof.into_val(env));
    env.try_invoke_contract::<(), Error>(&verifier, &Symbol::new(env, VERIFY_PROOF_FN), args)
        .map_err(|_| Error::ProofRejected)?
        .map_err(|_| Error::ProofRejected)
}

/// Sums the balances that the reserve addresses hold in the registered asset.
///
/// A read that fails fails the call. The registry must not read a failure as
/// a zero, because a contract address without a balance entry answers a true
/// zero, and the two would then look the same. The sum uses a checked
/// addition, because the reserve set can hold enough large balances to leave
/// the range of the balance type.
fn reserve_sum(env: &Env, asset: &Address, reserves: &Vec<Address>) -> Result<i128, Error> {
    let mut total: i128 = 0;
    for reserve in reserves.iter() {
        let mut args: Vec<soroban_sdk::Val> = Vec::new(env);
        args.push_back(reserve.into_val(env));
        let balance = env
            .try_invoke_contract::<i128, Error>(asset, &BALANCE_FN, args)
            .map_err(|_| Error::ReserveBalanceUnavailable)?
            .map_err(|_| Error::ReserveBalanceUnavailable)?;
        total = total
            .checked_add(balance)
            .ok_or(Error::ReserveSumOverflow)?;
    }
    Ok(total)
}

/// Extends one asset entry to the largest time to live that the network
/// allows at this ledger.
///
/// The target is a network limit that the contract reads at run time, so this
/// file holds no ledger count and no chosen retention. The threshold equals
/// the target, so every write tops the entry up. After the first extension, a
/// top up pays only for the ledgers that passed since the last write, which is
/// the smallest rent that keeps an entry alive without a break. The entry
/// stays readable long after the age window of an attestation ends, and a
/// reader pays for no restore.
fn extend_entry(env: &Env, key: &DataKey) {
    let ttl = env.storage().max_ttl();
    env.storage().persistent().extend_ttl(key, ttl, ttl);
}

/// Extends the contract instance and the contract code.
///
/// All instance data shares the time to live of the contract instance, so the
/// verifier address rides the contract. An archived instance makes the
/// registry uncallable, so every write extends it as well.
fn extend_contract(env: &Env) {
    let ttl = env.storage().max_ttl();
    env.storage().instance().extend_ttl(ttl, ttl);
}

#[contract]
pub struct Registry;

#[contractimpl]
impl Registry {
    /// Binds this registry to one verifier at deployment.
    ///
    /// The verifier stores its key once and has no upgrade path, so the key
    /// that the registry reads here is the key that the address verifies under
    /// for its whole life. A configured address alone proves nothing, so the
    /// deployment fails when the key is another one.
    pub fn __constructor(env: Env, verifier: Address) -> Result<(), Error> {
        let key: Bytes = env.invoke_contract(&verifier, &VK_BYTES_FN, Vec::new(&env));
        if env.crypto().sha256(&key).to_array() != params::AGGREGATOR_KEY_SHA256 {
            return Err(Error::VerifierKeyMismatch);
        }
        env.storage().instance().set(&DataKey::Verifier, &verifier);
        extend_contract(&env);
        Ok(())
    }

    /// Registers one asset, its authority, and its reserve addresses.
    ///
    /// An asset registers one time. A later change of the reserve set needs
    /// the authorization of the recorded authority.
    pub fn register_asset(
        env: Env,
        asset: Address,
        authority: Address,
        authenticity: AssetAuthenticity,
        reserves: Vec<Address>,
    ) -> Result<(), Error> {
        let key = DataKey::Asset(asset.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AssetAlreadyRegistered);
        }

        let tier = match &authenticity {
            AssetAuthenticity::Classic(serialized_asset) => {
                let issuer = classic_issuer(&env, serialized_asset)?;
                let canonical = env
                    .deployer()
                    .with_stellar_asset(serialized_asset.clone())
                    .deployed_address();
                if canonical != asset {
                    return Err(Error::NotTheCanonicalAssetContract);
                }
                if issuer != authority {
                    return Err(Error::IssuerMismatch);
                }
                AssetTier::ClassicIssuer
            }
            AssetAuthenticity::Contract => {
                if asset == native_asset_contract(&env) {
                    return Err(Error::NativeAssetNotSupported);
                }
                if administrator(&env, &asset)? != authority {
                    return Err(Error::AdministratorMismatch);
                }
                AssetTier::ContractAdministrator
            }
        };

        reject_authority_as_reserve(&reserves, &authority)?;
        let hash = reserve_set_hash(&env, &reserves)?;
        authority.require_auth();
        for reserve in reserves.iter() {
            reserve.require_auth();
        }

        env.storage().persistent().set(
            &key,
            &AssetEntry {
                authority,
                tier,
                reserves,
                reserve_set_hash: hash,
                attestation: AttestationSlot::Empty,
            },
        );
        extend_entry(&env, &key);
        extend_contract(&env);
        Ok(())
    }

    /// Replaces the reserve addresses of one registered asset.
    pub fn set_reserves(env: Env, asset: Address, reserves: Vec<Address>) -> Result<(), Error> {
        let key = DataKey::Asset(asset);
        let mut entry: AssetEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::AssetNotRegistered)?;

        reject_authority_as_reserve(&reserves, &entry.authority)?;
        let hash = reserve_set_hash(&env, &reserves)?;
        entry.authority.require_auth();
        for reserve in reserves.iter() {
            reserve.require_auth();
        }

        entry.reserve_set_hash = hash;
        entry.reserves = reserves;
        // A stored attestation binds the reserve set that it was proven
        // against, through the context hash. It says nothing about the new
        // set, so it does not survive the change.
        entry.attestation = AttestationSlot::Empty;
        env.storage().persistent().set(&key, &entry);
        extend_entry(&env, &key);
        extend_contract(&env);
        Ok(())
    }

    /// Records one attestation for a registered asset.
    ///
    /// The caller supplies no public input byte string. The registry derives
    /// the context from its own state and from the submitted snapshot ledger,
    /// and it builds the byte string itself, so a proof of another context
    /// cannot pass here.
    pub fn submit_attestation(
        env: Env,
        asset: Address,
        snapshot_ledger: u32,
        final_root: U256,
        total_liabilities: u128,
        proof: Bytes,
    ) -> Result<(), Error> {
        let key = DataKey::Asset(asset.clone());
        let mut entry: AssetEntry = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::AssetNotRegistered)?;

        // The chain assigns this ledger, so the window bounds how far the
        // declared snapshot can sit from a ledger that anybody can verify.
        // The addition saturates, because a snapshot near the end of the
        // range would otherwise wrap and widen the window.
        let attested_ledger = env.ledger().sequence();
        if attested_ledger < snapshot_ledger
            || attested_ledger > snapshot_ledger.saturating_add(ATTESTATION_MAX_AGE_LEDGERS)
        {
            return Err(Error::SnapshotOutsideWindow);
        }
        // The root arrives from outside, and the other three elements cannot
        // leave the range: the registry computes the context itself, the
        // inner key hash is a compiled-in hash, and the total is a u128.
        if !fr_in_range(&env, &final_root) {
            return Err(Error::RootOutOfRange);
        }
        entry.authority.require_auth();

        let context = context_hash(
            &env,
            &entry.authority,
            &asset,
            &entry.reserve_set_hash,
            snapshot_ledger,
        )?;
        verify(
            &env,
            &public_inputs(&env, &context, &final_root, total_liabilities),
            &proof,
        )?;

        let reserve_sum = reserve_sum(&env, &asset, &entry.reserves)?;
        entry.attestation = AttestationSlot::Filled(Attestation {
            final_root: final_root.clone(),
            total_liabilities,
            snapshot_ledger,
            reserve_sum,
            attested_ledger,
        });
        env.storage().persistent().set(&key, &entry);
        extend_entry(&env, &key);
        extend_contract(&env);

        AttestationAccepted {
            asset,
            snapshot_ledger,
            attested_ledger,
            total_liabilities,
            reserve_sum,
            final_root,
        }
        .publish(&env);
        Ok(())
    }

    /// Reads the reserve balances now.
    ///
    /// No attestation covers this value. It carries the ledger of the
    /// reading, and its field names differ from the names of the attestation
    /// record, so a reader cannot take one for the other. A read that fails
    /// fails this call, by the rule that the attestation path follows, so a
    /// reserve address that cannot hold the asset stays visible.
    pub fn observe_reserves(env: Env, asset: Address) -> Result<ReserveObservation, Error> {
        let entry: AssetEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Asset(asset.clone()))
            .ok_or(Error::AssetNotRegistered)?;
        Ok(ReserveObservation {
            observed_sum: reserve_sum(&env, &asset, &entry.reserves)?,
            observed_ledger: env.ledger().sequence(),
        })
    }

    /// The entry of one asset.
    pub fn entry(env: Env, asset: Address) -> Result<AssetEntry, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Asset(asset))
            .ok_or(Error::AssetNotRegistered)
    }
}
