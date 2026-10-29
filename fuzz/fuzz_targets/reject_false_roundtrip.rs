#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    assert!(
        data.is_empty(),
        "negative control: nonempty corpus input reached"
    );
});
