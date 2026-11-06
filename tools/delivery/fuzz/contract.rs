use delivery_core::Version;

pub fn check(input: &[u8]) {
    if let Ok(version) = Version::parse(input) {
        let text = version.to_string();
        assert_eq!(text.as_bytes(), input);
        assert_eq!(Version::parse(text.as_bytes()), Ok(version));
    }
    let mut bytes = [0_u8; 6];
    for (destination, source) in bytes.iter_mut().zip(input) {
        *destination = *source;
    }
    let components = [
        u16::from_le_bytes([bytes[0], bytes[1]]),
        u16::from_le_bytes([bytes[2], bytes[3]]),
        u16::from_le_bytes([bytes[4], bytes[5]]),
    ];
    let text = format!("{}.{}.{}", components[0], components[1], components[2]);
    let parsed = Version::parse(text.as_bytes()).unwrap_or_else(|error| {
        panic!("Generated canonical version failed: {error:?}");
    });
    assert_eq!([parsed.major(), parsed.minor(), parsed.patch()], components);
    assert_eq!(parsed.to_string(), text);
}
