//! What this token answers, and what it refuses.
//!
//! The cases cover the registry interface, mint authorization, and holder transfers.

use gate_fund_token::{Error, FundToken, FundTokenClient};
use soroban_sdk::{
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    token::TokenClient,
    Address, Env, IntoVal, MuxedAddress,
};

/// One token, with a fresh administrator.
fn token(env: &Env) -> (Address, FundTokenClient<'static>) {
    let admin = Address::generate(env);
    let id = env.register(FundToken, (admin.clone(),));
    (admin, FundTokenClient::new(env, &id))
}

#[test]
fn it_names_the_administrator_that_the_constructor_recorded() {
    let env = Env::default();
    let (admin, token) = token(&env);
    assert_eq!(token.admin(), admin);
}

#[test]
fn a_holder_that_holds_nothing_answers_zero() {
    // The registry adds what it reads for every reserve address, so an address
    // this token never minted to has to answer rather than fail.
    let env = Env::default();
    let (_, token) = token(&env);
    assert_eq!(token.balance(&Address::generate(&env)), 0);
}

#[test]
fn a_mint_gives_the_holder_the_shares() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, token) = token(&env);
    let holder = Address::generate(&env);
    token.mint(&holder, &500);
    assert_eq!(token.balance(&holder), 500);
}

#[test]
fn two_mints_add_up() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, token) = token(&env);
    let holder = Address::generate(&env);
    token.mint(&holder, &500);
    token.mint(&holder, &250);
    assert_eq!(token.balance(&holder), 750);
}

#[test]
fn each_holder_holds_its_own() {
    // The registry reads one balance for each reserve address, so two holders
    // that shared a balance would make a reserve sum that counts one holding
    // more than once.
    let env = Env::default();
    env.mock_all_auths();
    let (_, token) = token(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    token.mint(&first, &500);
    token.mint(&second, &70);
    assert_eq!(token.balance(&first), 500);
    assert_eq!(token.balance(&second), 70);
}

#[test]
fn a_negative_mint_is_refused() {
    // A negative balance would reduce the reserve sum that an attestation rests
    // on, which is the one arithmetic this token must not allow.
    let env = Env::default();
    env.mock_all_auths();
    let (_, token) = token(&env);
    let holder = Address::generate(&env);
    assert_eq!(
        token.try_mint(&holder, &-1),
        Err(Ok(Error::AmountNotPositive))
    );
    assert_eq!(token.balance(&holder), 0);
}

#[test]
fn a_mint_of_nothing_is_refused() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, token) = token(&env);
    let holder = Address::generate(&env);
    assert_eq!(
        token.try_mint(&holder, &0),
        Err(Ok(Error::AmountNotPositive))
    );
}

#[test]
fn a_mint_that_would_leave_the_range_is_refused() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, token) = token(&env);
    let holder = Address::generate(&env);
    token.mint(&holder, &i128::MAX);
    assert_eq!(token.try_mint(&holder, &1), Err(Ok(Error::BalanceOverflow)));
    assert_eq!(token.balance(&holder), i128::MAX);
}

#[test]
fn a_mint_without_the_administrator_is_refused() {
    // A balance that anybody could create would make every balance this token
    // reports meaningless, and the registry reads them as backing.
    let env = Env::default();
    let (_, token) = token(&env);
    let stranger = Address::generate(&env);
    let holder = Address::generate(&env);
    let result = token
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &token.address,
                fn_name: "mint",
                args: (holder.clone(), 500_i128).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_mint(&holder, &500);
    assert!(result.is_err());
    assert_eq!(token.balance(&holder), 0);
}

const TRANSFER_BALANCE: i128 = 500;
const TRANSFER_AMOUNT: i128 = 100;

#[test]
fn the_standard_client_moves_only_the_requested_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, token) = token(&env);
    let holder = Address::generate(&env);
    let recipient = Address::generate(&env);
    token.mint(&holder, &TRANSFER_BALANCE);
    TokenClient::new(&env, &token.address).transfer(
        &holder,
        MuxedAddress::from(&recipient),
        &TRANSFER_AMOUNT,
    );
    assert_eq!(env.events().all().events().len(), 1);
    assert_eq!(token.balance(&holder), TRANSFER_BALANCE - TRANSFER_AMOUNT);
    assert_eq!(token.balance(&recipient), TRANSFER_AMOUNT);
}

#[test]
fn an_administrator_cannot_transfer_a_holders_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, token) = token(&env);
    let holder = Address::generate(&env);
    let recipient = MuxedAddress::from(Address::generate(&env));
    token.mint(&holder, &TRANSFER_BALANCE);
    env.mock_auths(&[]);
    let result = token
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &token.address,
                fn_name: "transfer",
                args: (holder.clone(), recipient.clone(), TRANSFER_AMOUNT).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_transfer(&holder, &recipient, &TRANSFER_AMOUNT);
    assert!(result.is_err());
    assert_eq!(token.balance(&holder), TRANSFER_BALANCE);
    assert_eq!(token.balance(&recipient.address()), 0);
    token
        .mock_auths(&[MockAuth {
            address: &holder,
            invoke: &MockAuthInvoke {
                contract: &token.address,
                fn_name: "transfer",
                args: (holder.clone(), recipient.clone(), TRANSFER_AMOUNT).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .transfer(&holder, &recipient, &TRANSFER_AMOUNT);
    assert_eq!(token.balance(&holder), TRANSFER_BALANCE - TRANSFER_AMOUNT);
}

#[test]
fn negative_excess_and_overflow_transfers_change_neither_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, token) = token(&env);
    let holder = Address::generate(&env);
    let recipient = MuxedAddress::from(Address::generate(&env));
    token.mint(&holder, &TRANSFER_BALANCE);
    assert_eq!(
        token.try_transfer(&holder, &recipient, &-1),
        Err(Ok(Error::AmountNegative))
    );
    assert_eq!(
        token.try_transfer(&holder, &recipient, &(TRANSFER_BALANCE + 1)),
        Err(Ok(Error::InsufficientBalance))
    );
    assert_eq!(token.balance(&holder), TRANSFER_BALANCE);
    assert_eq!(token.balance(&recipient.address()), 0);
    token.mint(&recipient.address(), &i128::MAX);
    assert_eq!(
        token.try_transfer(&holder, &recipient, &TRANSFER_AMOUNT),
        Err(Ok(Error::BalanceOverflow))
    );
    assert_eq!(token.balance(&holder), TRANSFER_BALANCE);
    assert_eq!(token.balance(&recipient.address()), i128::MAX);
}

#[test]
fn self_and_zero_transfers_preserve_balances() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, token) = token(&env);
    let holder = Address::generate(&env);
    let recipient = MuxedAddress::from(Address::generate(&env));
    token.mint(&holder, &i128::MAX);
    token.transfer(&holder, MuxedAddress::from(&holder), &i128::MAX);
    token.transfer(&holder, &recipient, &0);
    assert_eq!(token.balance(&holder), i128::MAX);
    assert_eq!(token.balance(&recipient.address()), 0);
    token.transfer(&holder, &recipient, &i128::MAX);
    assert_eq!(token.balance(&holder), 0);
    assert_eq!(token.balance(&recipient.address()), i128::MAX);
}
