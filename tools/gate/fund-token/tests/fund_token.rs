//! What this token answers, and what it refuses.
//!
//! The cases read the two functions that the registry calls, and the mint that
//! puts a balance there to read. Each refusal names the state it creates rather
//! than the line it expects to reach.

use gate_fund_token::{Error, FundToken, FundTokenClient};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal,
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
