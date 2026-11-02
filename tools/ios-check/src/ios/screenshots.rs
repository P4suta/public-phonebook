use super::{
    LIVE_UI_TEST, device, logged, require_current_sources, require_ui_case, source_hashes,
    source_records,
};
use crate::locations::LOOPBACK_HOST;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command};

const SIZE: (u32, u32) = (1206, 2622);
const RGBA_CHANNELS: usize = 4;
const OPAQUE_ALPHA: u8 = 255;
const SCREENS: [(&str, &str); 3] = [
    ("live-public-directory-search", "directory-search.png"),
    ("live-public-directory-contact", "contact-details.png"),
    ("live-public-directory-source", "source-attribution.png"),
];

fn require_origin(origin: &str) -> Result<()> {
    let authority = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix(&format!("http://{LOOPBACK_HOST}:")))
        .context("The screenshot origin must use HTTPS or loopback HTTP")?;
    ensure!(
        !authority.is_empty()
            && authority
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-:".contains(&byte)),
        "The screenshot origin must be a bare origin without a path, query, or credentials"
    );
    Ok(())
}

fn select(manifest: &Value) -> Result<Vec<(String, &'static str)>> {
    let attachments = manifest
        .as_array()
        .context("The attachment manifest is not a list")?
        .iter()
        .flat_map(|test| test["attachments"].as_array().into_iter().flatten())
        .collect::<Vec<_>>();
    let mut selected = Vec::new();
    for (attachment, output) in SCREENS {
        let matches = attachments
            .iter()
            .filter(|value| {
                value["suggestedHumanReadableName"]
                    .as_str()
                    .is_some_and(|name| {
                        name.strip_prefix(attachment)
                            .is_some_and(|rest| rest.starts_with('_') && rest.ends_with(".png"))
                    })
            })
            .collect::<Vec<_>>();
        ensure!(
            matches.len() == 1,
            "The live UI case must attach {attachment} exactly once"
        );
        let file = matches[0]["exportedFileName"]
            .as_str()
            .context("The attachment has no exported file")?;
        ensure!(
            !file.is_empty() && !file.contains('/') && !file.starts_with('.'),
            "Invalid exported attachment name"
        );
        selected.push((file.to_owned(), output));
    }
    Ok(selected)
}

fn opaque_rgb(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info()?;
    let mut buffer = vec![
        0;
        reader
            .output_buffer_size()
            .context("The screenshot is too large to decode")?
    ];
    let info = reader.next_frame(&mut buffer)?;
    ensure!(
        (info.width, info.height) == SIZE,
        "A store screenshot must be {} x {} pixels",
        SIZE.0,
        SIZE.1
    );
    let pixels = &buffer[..info.buffer_size()];
    let rgb = match info.color_type {
        png::ColorType::Rgb => pixels.to_vec(),
        png::ColorType::Rgba => {
            let (rgba, rest) = pixels.as_chunks::<RGBA_CHANNELS>();
            ensure!(
                rest.is_empty() && rgba.iter().all(|[_, _, _, alpha]| *alpha == OPAQUE_ALPHA),
                "A store screenshot contains transparency"
            );
            rgba.iter()
                .flat_map(|[red, green, blue, _]| [*red, *green, *blue])
                .collect()
        }
        _ => anyhow::bail!("A store screenshot must use RGB color"),
    };
    let mut result = Vec::new();
    let mut encoder = png::Encoder::new(&mut result, SIZE.0, SIZE.1);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header()?.write_image_data(&rgb)?;
    Ok(result)
}

pub fn capture(root: &Path, origin: &str) -> Result<()> {
    require_origin(origin)?;
    let sources = source_hashes(root)?;
    let simulator = device(root)?;
    let identifier = simulator.id().to_owned();
    let directory = tempfile::Builder::new()
        .prefix("app-store-screenshots-")
        .tempdir_in(root.join("target/ios"))?
        .keep();
    let result = directory.join("store.xcresult");
    logged(
        root,
        "store-screenshots",
        Command::new("xcodebuild")
            .current_dir(root)
            .args([
                "-quiet",
                "-toolchain",
                "com.apple.dt.toolchain.XcodeDefault",
                "-project",
                "ios/PublicPhonebook.xcodeproj",
                "-scheme",
                "PublicPhonebook",
                "-configuration",
                "ProductionDebug",
                "-destination",
                &format!("platform=iOS Simulator,id={identifier}"),
                "-derivedDataPath",
                "ios/DerivedData",
                "-jobs",
                "2",
                "-parallel-testing-enabled",
                "NO",
                "-collect-test-diagnostics",
                "never",
                &format!("-only-testing:PhonebookUITests/DirectoryUITests/{LIVE_UI_TEST}"),
                &format!("PHONEBOOK_API_ORIGIN={origin}"),
                "CODE_SIGN_IDENTITY=-",
                "CODE_SIGN_STYLE=Manual",
                "CODE_SIGNING_ALLOWED=YES",
                "-resultBundlePath",
            ])
            .arg(&result)
            .arg("test"),
    )?;
    let read_result = |kind| -> Result<Value> {
        let output = logged(
            root,
            &format!("store-screenshots-{kind}"),
            Command::new("xcrun")
                .args(["xcresulttool", "get", "test-results", kind, "--path"])
                .arg(&result),
        )?;
        Ok(serde_json::from_slice(&output.stdout)?)
    };
    require_ui_case(
        &read_result("summary")?,
        &read_result("tests")?,
        LIVE_UI_TEST,
    )?;
    let attachments = directory.join("attachments");
    logged(
        root,
        "store-screenshots-attachments",
        Command::new("xcrun")
            .args(["xcresulttool", "export", "attachments", "--path"])
            .arg(&result)
            .arg("--output-path")
            .arg(&attachments),
    )?;
    let manifest: Value = serde_json::from_slice(&fs::read(attachments.join("manifest.json"))?)?;
    let screens = directory.join("ja");
    fs::create_dir_all(&screens)?;
    let mut files = Vec::new();
    for (exported, output) in select(&manifest)? {
        let bytes = opaque_rgb(&fs::read(attachments.join(exported))?)?;
        fs::write(screens.join(output), &bytes)?;
        files.push(json!({"file":output,"sha256":crate::sha256_hex(&bytes)}));
    }
    require_current_sources(root, &sources)?;
    let revision = super::super::checked(
        Command::new("git")
            .current_dir(root)
            .args(["rev-parse", "HEAD"]),
    )?;
    let status = super::super::checked(
        Command::new("git")
            .current_dir(root)
            .args(["status", "--porcelain"]),
    )?;
    let record = json!({"format":1,"purpose":"App Store screenshot candidate; no upload","locale":"ja_JP","configuration":"ProductionDebug","api_origin":origin,"simulator_runtime":super::RUNTIME,"simulator_device":super::DEVICE_TYPE,"size":[SIZE.0, SIZE.1],"directory":screens,"screenshots":files,"source_revision":String::from_utf8(revision.stdout)?.trim(),"working_tree_dirty":!status.stdout.is_empty(),"source_sha256":source_records(&sources)});
    fs::write(
        directory.join("screenshots.json"),
        serde_json::to_vec_pretty(&record)?,
    )?;
    fs::write(
        root.join("target/ios/app-store-screenshots.json"),
        serde_json::to_vec_pretty(&record)?,
    )?;
    println!(
        "PASS: {} Japanese store screenshots from the production configuration at {}",
        SCREENS.len(),
        screens.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(color: png::ColorType, width: u32, alpha: u8) -> Result<Vec<u8>> {
        let channels = if color == png::ColorType::Rgba { 4 } else { 3 };
        let pixel = [255, 255, 255, alpha];
        let pixels = pixel[..channels].repeat(width as usize * SIZE.1 as usize);
        let mut result = Vec::new();
        let mut encoder = png::Encoder::new(&mut result, width, SIZE.1);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header()?.write_image_data(&pixels)?;
        Ok(result)
    }

    #[test]
    fn screenshots_are_opaque_rgb_at_the_declared_size() -> Result<()> {
        for source in [
            image(png::ColorType::Rgb, SIZE.0, 255)?,
            image(png::ColorType::Rgba, SIZE.0, 255)?,
        ] {
            let reader =
                png::Decoder::new(std::io::Cursor::new(opaque_rgb(&source)?)).read_info()?;
            assert_eq!(
                (
                    reader.info().width,
                    reader.info().height,
                    reader.info().color_type
                ),
                (SIZE.0, SIZE.1, png::ColorType::Rgb)
            );
        }
        assert!(opaque_rgb(&image(png::ColorType::Rgba, SIZE.0, 254)?).is_err());
        assert!(opaque_rgb(&image(png::ColorType::Rgb, SIZE.0 - 1, 255)?).is_err());
        Ok(())
    }

    #[test]
    fn attachments_map_each_declared_screen_exactly_once() -> Result<()> {
        let entry = |name: &str, file: &str| json!({"suggestedHumanReadableName":format!("{name}_0_ID.png"),"exportedFileName":file});
        let complete = json!([{"attachments":[
            entry("live-public-directory-search", "a.png"),
            entry("live-public-directory-contact", "b.png"),
            entry("live-public-directory-source", "c.png"),
            entry("failure", "d.png"),
        ]}]);
        assert_eq!(
            select(&complete)?,
            [
                ("a.png".to_owned(), "directory-search.png"),
                ("b.png".to_owned(), "contact-details.png"),
                ("c.png".to_owned(), "source-attribution.png"),
            ]
        );
        let mut duplicate = complete.clone();
        duplicate[0]["attachments"]
            .as_array_mut()
            .context("attachments")?
            .push(entry("live-public-directory-search", "e.png"));
        assert!(select(&duplicate).is_err());
        let mut missing = complete.clone();
        missing[0]["attachments"]
            .as_array_mut()
            .context("attachments")?
            .remove(2);
        assert!(select(&missing).is_err());
        let traversal = json!([{"attachments":[
            entry("live-public-directory-search", "../a.png"),
            entry("live-public-directory-contact", "b.png"),
            entry("live-public-directory-source", "c.png"),
        ]}]);
        assert!(select(&traversal).is_err());
        Ok(())
    }

    #[test]
    fn origins_are_bare_https_or_loopback_http() {
        for valid in ["https://www.dial.page", "http://127.0.0.1:8787"] {
            assert!(require_origin(valid).is_ok());
        }
        for invalid in [
            "http://www.dial.page",
            "https://www.dial.page/api",
            "https://user@www.dial.page",
            "https://",
            "http://127.0.0.1:8787/?q=1",
        ] {
            assert!(require_origin(invalid).is_err());
        }
    }
}
