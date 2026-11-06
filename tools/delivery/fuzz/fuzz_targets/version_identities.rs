#![no_main]

#[path = "../contract.rs"]
mod contract;

libfuzzer_sys::fuzz_target!(|input: &[u8]| contract::check(input));
