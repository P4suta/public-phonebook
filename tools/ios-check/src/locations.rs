pub const ADVISORY_DATABASE: &str = "https://github.com/RustSec/advisory-db.git";
pub const LOOPBACK_HOST: &str = "127.0.0.1";
pub const FIXTURE_PORT: u16 = 3100;
pub const FIXTURE_ORIGIN: &str = "http://127.0.0.1:3100";
pub const PRODUCTION_ORIGIN: &str = "https://www.dial.page";
pub const LEAN: &str = "/opt/lean/bin/lean";
pub const LEAN_CHECKER: &str = "/opt/lean/bin/leanchecker";
pub const APP_STORE_CONNECT_BUILDS: &str = "https://api.appstoreconnect.apple.com/v1/builds";
pub const PROPERTY_LIST_DOCUMENT_TYPE: &str = "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">";
pub const PROVISIONING_PROFILES: &str = "Library/Developer/Xcode/UserData/Provisioning Profiles";
pub const RUNNER_TEMPORARY_DIRECTORY: &str = "RUNNER_TEMP";
pub const SECURITY: &str = "/usr/bin/security";
pub const CODESIGN: &str = "/usr/bin/codesign";
pub const CURL: &str = "/usr/bin/curl";
pub const RANDOM_DEVICE: &str = "/dev/urandom";

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
