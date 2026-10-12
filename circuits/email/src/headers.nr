use std::collections::bounded_vec::BoundedVec;
use zkemail::{headers::constrain_header_field, Sequence};

mod tests;

pub global MAX_EMAIL_HEADER_LENGTH: u32 = 1024;
pub global MAX_FROM_LENGTH: u32 = 320;
pub global SUBJECT_LENGTH: u32 = 43;
global MAX_DOMAIN_LENGTH: u32 = 253;
global MAX_DOMAIN_LABEL_LENGTH: u32 = 63;
global MAX_HEADER_NAME_LENGTH: u32 = 64;
global SUBJECT_NAME_LENGTH: u32 = 7;
global FROM_NAME_LENGTH: u32 = 4;
global DKIM_NAME_LENGTH: u32 = 14;
global FROM_TOKEN: Field = 0x66726f6d;
global SUBJECT_TOKEN: Field = 0x7375626a656374;
global CR: u8 = 13;
global LF: u8 = 10;
global SPACE: u8 = 32;
global COLON: u8 = 58;
global SEMICOLON: u8 = 59;
global EQUALS: u8 = 61;

pub struct DkimTags {
    domain: Sequence,
    algorithm: Sequence,
    canonicalization: Sequence,
    signed_headers: Sequence,
    version: Sequence,
    signature: Sequence,
}

fn matches<let N: u32>(header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>, index: u32, value: [u8; N]) -> bool {
    let fits = if index <= header.len() { N <= header.len() - index } else { false };
    let mut equal = fits;
    for offset in 0..N {
        let at = if fits { index + offset } else { 0 };
        equal = equal & (header.get_unchecked(at) == value[offset]);
    }
    equal
}

fn exact<let N: u32>(header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>, sequence: Sequence, value: [u8; N]) {
    assert(sequence.length == N, "The DKIM tag length is invalid");
    assert(matches(header, sequence.index, value), "The DKIM tag value is invalid");
}

fn tag_bounds(header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>, dkim: Sequence, tag: Sequence) {
    assert(tag.index >= dkim.index + DKIM_NAME_LENGTH + 1);
    assert(tag.length >= 2);
    assert(tag.end_index() <= header.len());
    let mut suffix = true;
    for index in 0..MAX_EMAIL_HEADER_LENGTH {
        if (index >= tag.index) & (index < tag.end_index()) {
            let byte = header.get_unchecked(index);
            assert((byte != SEMICOLON) & (byte != CR) & (byte != LF));
        }
        if (index >= tag.end_index()) & (index < header.len()) & suffix {
            let byte = header.get_unchecked(index);
            if byte == SEMICOLON {
                suffix = false;
            } else {
                assert(byte == SPACE, "The DKIM tag has an invalid suffix");
            }
        }
    }
}

fn signed_names(header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>, sequence: Sequence) {
    let mut token: Field = 0;
    let mut length: u32 = 0;
    let mut ended = false;
    let mut from_count: u32 = 0;
    let mut subject_count: u32 = 0;
    for index in 0..MAX_EMAIL_HEADER_LENGTH {
        if (index >= sequence.index + 2) & (index <= sequence.end_index()) {
            let byte = if index == sequence.end_index() { COLON } else { header.get_unchecked(index) };
            if byte == COLON {
                assert(length > 0, "An h tag names an empty header");
                if token == FROM_TOKEN { from_count += 1; }
                if token == SUBJECT_TOKEN { subject_count += 1; }
                token = 0;
                length = 0;
                ended = false;
            } else if byte == SPACE {
                if length > 0 { ended = true; }
            } else {
                assert(!ended, "An h tag splits a header name");
                let lower = if (byte >= 65) & (byte <= 90) { byte + 32 } else { byte };
                assert(((lower >= 97) & (lower <= 122)) | (lower == 45));
                length += 1;
                assert(length <= MAX_HEADER_NAME_LENGTH);
                // Long names need no numeric representation for these two comparisons.
                if length <= SUBJECT_NAME_LENGTH { token = token * 256 + lower as Field; }
                if length > SUBJECT_NAME_LENGTH { token = 0; }
            }
        }
    }
    // Extra h names sign absent fields. Actual signed fields remain unique.
    assert((from_count >= 1) & (subject_count >= 1), "The h tag must name From and Subject");
}

pub fn check_headers(
    header: BoundedVec<u8, MAX_EMAIL_HEADER_LENGTH>,
    subject: Sequence,
    from: Sequence,
    dkim: Sequence,
    tags: DkimTags,
) -> ([u8; SUBJECT_LENGTH], BoundedVec<u8, MAX_DOMAIN_LENGTH>, BoundedVec<u8, MAX_FROM_LENGTH>) {
    assert((header.len() > 0) & (header.len() < MAX_EMAIL_HEADER_LENGTH));
    assert((subject.index == 0) | (subject.index >= 2));
    assert((from.index == 0) | (from.index >= 2));
    assert((dkim.index >= 2) & (dkim.end_index() == header.len()));
    assert(subject.length == SUBJECT_NAME_LENGTH + 1 + SUBJECT_LENGTH);
    assert((from.length > FROM_NAME_LENGTH + 1) & (from.length <= MAX_FROM_LENGTH));
    assert((subject.end_index() < dkim.index) & (from.end_index() < dkim.index));
    constrain_header_field::<MAX_EMAIL_HEADER_LENGTH, SUBJECT_LENGTH, SUBJECT_NAME_LENGTH>(header, subject, comptime { "subject".as_bytes() });
    constrain_header_field::<MAX_EMAIL_HEADER_LENGTH, MAX_FROM_LENGTH, FROM_NAME_LENGTH>(header, from, comptime { "from".as_bytes() });
    constrain_header_field::<MAX_EMAIL_HEADER_LENGTH, MAX_EMAIL_HEADER_LENGTH, DKIM_NAME_LENGTH>(header, dkim, comptime { "dkim-signature".as_bytes() });

    let mut subject_count: u32 = 0;
    let mut from_count: u32 = 0;
    let mut counts: [u32; 6] = [0; 6];
    let selected = [tags.domain, tags.algorithm, tags.canonicalization, tags.signed_headers, tags.version, tags.signature];
    let names: [u8; 6] = [100, 97, 99, 104, 118, 98];
    let mut tag_start = true;
    let mut tag_name = false;
    let mut field_name = true;
    let mut field_name_length: u32 = 0;
    let mut field_name_value: Field = 0;
    let mut field_start: u32 = 0;
    let mut value_start = false;
    let mut previous_space = false;
    for index in 0..MAX_EMAIL_HEADER_LENGTH {
        if index < header.len() {
            let byte = header.get_unchecked(index);
            let next = if index + 1 < header.len() { header.get_unchecked(index + 1) } else { 0 };
            if byte == LF {
                let previous = if index >= 1 { header.get_unchecked(index - 1) } else { 0 };
                assert(previous == CR);
            }
            if byte == CR {
                assert(next == LF);
                assert(!field_name & !previous_space);
            }
            let line_start = if index == 0 { true } else if index >= 2 { (header.get_unchecked(index - 2) == CR) & (header.get_unchecked(index - 1) == LF) } else { false };
            if line_start {
                field_name = true;
                field_name_length = 0;
                field_name_value = 0;
                field_start = index;
                value_start = false;
                previous_space = false;
            }
            if (byte != CR) & (byte != LF) {
                if field_name {
                    if byte == COLON {
                        assert(field_name_length > 0);
                        if field_start < dkim.index {
                            if field_name_value == FROM_TOKEN {
                                from_count += 1;
                                assert(from.index == field_start);
                            }
                            if field_name_value == SUBJECT_TOKEN {
                                subject_count += 1;
                                assert(subject.index == field_start);
                            }
                        }
                        field_name = false;
                        value_start = true;
                    } else {
                        assert(((byte >= 97) & (byte <= 122)) | ((byte >= 48) & (byte <= 57)) | (byte == 45));
                        field_name_length += 1;
                        assert(field_name_length <= MAX_HEADER_NAME_LENGTH);
                        if field_name_length <= SUBJECT_NAME_LENGTH {
                            field_name_value = field_name_value * 256 + byte as Field;
                        } else { field_name_value = 0; }
                    }
                } else {
                    assert(byte != 9, "A relaxed header must not contain a tab");
                    assert(!((byte == SPACE) & (value_start | previous_space)), "A relaxed header has invalid spaces");
                    value_start = false;
                    previous_space = byte == SPACE;
                }
            }
            if index >= dkim.index + DKIM_NAME_LENGTH + 1 {
                if tag_start & (byte != SPACE) {
                    assert((byte >= 97) & (byte <= 122), "A DKIM tag name is invalid");
                    tag_name = true;
                    for kind in 0..6 {
                        if (byte == names[kind]) & (next == EQUALS) {
                            counts[kind] += 1;
                            assert(selected[kind].index == index, "The DKIM tag position is invalid");
                        }
                    }
                    tag_start = false;
                }
                if tag_name {
                    if byte == EQUALS { tag_name = false; }
                    else { assert((byte >= 97) & (byte <= 122), "A DKIM tag name is invalid"); }
                }
                if byte == SEMICOLON { tag_start = true; }
            }
        }
    }
    assert(!tag_name & !previous_space);
    assert((subject_count == 1) & (from_count == 1), "The signed headers repeat From or Subject");
    for kind in 0..6 {
        assert(counts[kind] == 1, "A required DKIM tag is absent or repeated");
        tag_bounds(header, dkim, selected[kind]);
    }
    exact(header, tags.algorithm, comptime { "a=rsa-sha256".as_bytes() });
    exact(header, tags.canonicalization, comptime { "c=relaxed/relaxed".as_bytes() });
    exact(header, tags.version, comptime { "v=1".as_bytes() });
    exact(header, tags.signature, comptime { "b=".as_bytes() });
    signed_names(header, tags.signed_headers);

    assert((tags.domain.length > 2) & (tags.domain.length <= MAX_DOMAIN_LENGTH + 2));
    let mut domain_bytes: [u8; MAX_DOMAIN_LENGTH] = [0; MAX_DOMAIN_LENGTH];
    let mut label_length: u32 = 0;
    let mut last_hyphen = false;
    for offset in 0..MAX_DOMAIN_LENGTH {
        if offset < tags.domain.length - 2 {
            let byte = header.get_unchecked(tags.domain.index + 2 + offset);
            assert(((byte >= 97) & (byte <= 122)) | ((byte >= 48) & (byte <= 57)) | (byte == 45) | (byte == 46), "The DKIM domain is not lowercase ASCII");
            if byte == 46 {
                assert((label_length > 0) & !last_hyphen);
                label_length = 0;
            } else {
                assert((label_length != 0) | (byte != 45));
                label_length += 1;
                assert(label_length <= MAX_DOMAIN_LABEL_LENGTH);
            }
            last_hyphen = byte == 45;
            domain_bytes[offset] = byte;
        }
    }
    assert((label_length > 0) & !last_hyphen);
    let domain = BoundedVec::from_parts(domain_bytes, tags.domain.length - 2);
    let mut from_storage: [u8; MAX_FROM_LENGTH] = [0; MAX_FROM_LENGTH];
    for offset in 0..MAX_FROM_LENGTH {
        if offset < from.length { from_storage[offset] = header.get_unchecked(from.index + offset); }
    }
    let from_bytes = BoundedVec::from_parts(from_storage, from.length);
    let mut subject_bytes = [0; SUBJECT_LENGTH];
    for offset in 0..SUBJECT_LENGTH {
        let byte = header.get_unchecked(subject.index + SUBJECT_NAME_LENGTH + 1 + offset);
        assert(((byte >= 65) & (byte <= 90)) | ((byte >= 97) & (byte <= 122)) | ((byte >= 48) & (byte <= 57)) | (byte == 45) | (byte == 95), "The Subject is not base64url");
        subject_bytes[offset] = byte;
    }
    (subject_bytes, domain, from_bytes)
}
