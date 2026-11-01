pub const ADVISORY_DATABASE: &str = "https://github.com/RustSec/advisory-db.git";
pub const LOOPBACK_HOST: &str = "127.0.0.1";
pub const FIXTURE_PORT: u16 = 3100;
pub const FIXTURE_ORIGIN: &str = "http://127.0.0.1:3100";
pub const PRODUCTION_ORIGIN: &str = "https://www.dial.page";
pub const LEAN: &str = "/opt/lean/bin/lean";
pub const LEAN_CHECKER: &str = "/opt/lean/bin/leanchecker";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_origin_names_the_loopback_fixture_address() {
        assert_eq!(
            FIXTURE_ORIGIN,
            format!("http://{LOOPBACK_HOST}:{FIXTURE_PORT}")
        );
    }
}
