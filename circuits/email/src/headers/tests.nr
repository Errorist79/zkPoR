use std::collections::bounded_vec::BoundedVec;
use zkemail::Sequence;
use crate::headers::{check_headers, DkimTags, MAX_EMAIL_HEADER_LENGTH};

struct Case {
    header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>,
    subject: Sequence,
    from: Sequence,
    dkim: Sequence,
    tags: DkimTags,
}

fn append<let N: u32>(header: &mut BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>, value: [u8; N]) -> Sequence {
    let sequence = Sequence { index: header.len(), length: N };
    header.extend_from_array(value);
    sequence
}

fn fixture<let H: u32>(signed_headers: [u8; H], duplicate_subject: bool, duplicate_domain: bool) -> Case {
    let mut header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH> = BoundedVec::new();
    let subject_value = comptime { "subject:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE".as_bytes() };
    let subject = append(&mut header, subject_value);
    header.extend_from_array([13, 10]);
    if duplicate_subject {
        let _ = append(&mut header, subject_value);
        header.extend_from_array([13, 10]);
    }
    let from = append(&mut header, comptime { "from:issuer@example.test".as_bytes() });
    header.extend_from_array([13, 10]);
    let start = header.len();
    header.extend_from_array(comptime { "dkim-signature:".as_bytes() });
    let version = append(&mut header, comptime { "v=1".as_bytes() });
    header.extend_from_array(comptime { "; ".as_bytes() });
    let algorithm = append(&mut header, comptime { "a=rsa-sha256".as_bytes() });
    header.extend_from_array(comptime { "; ".as_bytes() });
    let canonicalization = append(&mut header, comptime { "c=relaxed/relaxed".as_bytes() });
    header.extend_from_array(comptime { "; ".as_bytes() });
    let domain = append(&mut header, comptime { "d=example.test".as_bytes() });
    header.extend_from_array(comptime { "; ".as_bytes() });
    if duplicate_domain { header.extend_from_array(comptime { "d=other.test; ".as_bytes() }); }
    let h_start = header.len();
    header.extend_from_array(comptime { "h=".as_bytes() });
    header.extend_from_array(signed_headers);
    let h = Sequence { index: h_start, length: H + 2 };
    header.extend_from_array(comptime { "; ".as_bytes() });
    let signature = append(&mut header, comptime { "b=".as_bytes() });
    let dkim = Sequence { index: start, length: header.len() - start };
    Case { header, subject, from, dkim, tags: DkimTags { domain, algorithm, canonicalization, signed_headers: h, version, signature } }
}

fn check(case: Case) {
    let _ = check_headers(case.header, case.subject, case.from, case.dkim, case.tags);
}

#[test]
fn accepts_one_actual_field_with_oversigned_names() {
    let case = fixture(comptime { "from:subject:from:subject".as_bytes() }, false, false);
    let (subject, domain, from) = check_headers(case.header, case.subject, case.from, case.dkim, case.tags);
    assert(subject == comptime { "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE".as_bytes() });
    assert(domain == BoundedVec::from_array(comptime { "example.test".as_bytes() }));
    assert(from == BoundedVec::from_array(comptime { "from:issuer@example.test".as_bytes() }));
}

#[test(should_fail)]
fn rejects_a_second_actual_subject() {
    check(fixture(comptime { "from:subject:subject".as_bytes() }, true, false));
}

#[test(should_fail)]
fn rejects_a_repeated_domain_tag() {
    check(fixture(comptime { "from:subject".as_bytes() }, false, true));
}

#[test(should_fail)]
fn rejects_unsigned_subject() {
    check(fixture(comptime { "from".as_bytes() }, false, false));
}

#[test(should_fail)]
fn rejects_unsigned_from() {
    check(fixture(comptime { "subject".as_bytes() }, false, false));
}

#[test(should_fail)]
fn rejects_index_one() {
    let mut case = fixture(comptime { "from:subject".as_bytes() }, false, false);
    case.subject.index = 1;
    check(case);
}

#[test(should_fail)]
fn rejects_a_short_subject() {
    let mut case = fixture(comptime { "from:subject".as_bytes() }, false, false);
    case.subject.length -= 1;
    check(case);
}

#[test(should_fail)]
fn rejects_a_non_base64url_subject() {
    let mut case = fixture(comptime { "from:subject".as_bytes() }, false, false);
    case.header.set(case.subject.index + 8, 43);
    check(case);
}

#[test(should_fail)]
fn rejects_a_different_canonicalization() {
    let mut case = fixture(comptime { "from:subject".as_bytes() }, false, false);
    case.header.set(case.tags.canonicalization.index + 2, 115);
    check(case);
}

#[test(should_fail)]
fn rejects_a_domain_with_an_empty_label() {
    let mut case = fixture(comptime { "from:subject".as_bytes() }, false, false);
    case.header.set(case.tags.domain.index + 2, 46);
    check(case);
}

#[test(should_fail)]
fn rejects_a_nonfinal_dkim_field() {
    let mut case = fixture(comptime { "from:subject".as_bytes() }, false, false);
    case.header.extend_from_array(comptime { "\r\nx-extra:value".as_bytes() });
    check(case);
}

#[test(should_fail)]
fn rejects_a_from_sequence_that_exceeds_its_field() {
    let mut case = fixture(comptime { "from:subject".as_bytes() }, false, false);
    case.from.length += 1;
    check(case);
}
