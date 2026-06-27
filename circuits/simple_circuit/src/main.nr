// Reference circuit for the known-good verifier check only. Not a PoR circuit.
fn main(x: Field, y: pub Field) {
    assert(x != y);
}

#[test]
fn test_main() {
    main(1, 2);
}
