use anyhow::{Context, Result, bail, ensure};
use resvg::{tiny_skia, usvg};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

const NAME_LIMIT: usize = 64;
const SVG_BYTE_LIMIT: usize = 262_144;
const IMPORT_BYTE_LIMIT: u64 = 2_097_152;
const MAX_DIMENSION: u32 = 1200;
const UI_ICON_COUNT: usize = 58;
const BRAND_ASSET_COUNT: usize = 16;
const ASSET_COUNT: usize = UI_ICON_COUNT + BRAND_ASSET_COUNT;
const CATEGORY_MAPPING_COUNT: usize = 39;
const ALIAS_COUNT: usize = 16;
const UI_ICON_GRID: u32 = 24;
const APP_ICON_SIZE: u32 = 1024;
const OPAQUE_ALPHA: u8 = 255;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Icon,
    Brand,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportedAsset {
    id: String,
    name: String,
    kind: Kind,
    width: u32,
    height: u32,
    svg: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    format: u8,
    file_key: String,
    review_node: String,
    assets: Vec<ImportedAsset>,
    categories: BTreeMap<String, String>,
    aliases: BTreeMap<String, String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Asset {
    name: String,
    kind: Kind,
    node_id: String,
    width: u32,
    height: u32,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    format: u8,
    file_key: String,
    review_node: String,
    assets: Vec<Asset>,
    categories: BTreeMap<String, String>,
    aliases: BTreeMap<String, String>,
}

fn slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= NAME_LIMIT
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn source_path(kind: Kind, name: &str) -> Result<String> {
    ensure!(slug(name), "Invalid icon name");
    Ok(format!(
        "design/{}/{name}.svg",
        if kind == Kind::Icon { "icons" } else { "brand" }
    ))
}

fn validate_svg(svg: &str, width: u32, height: u32) -> Result<()> {
    ensure!(
        !svg.is_empty() && svg.len() <= SVG_BYTE_LIMIT,
        "Invalid SVG byte budget"
    );
    ensure!(
        (1..=MAX_DIMENSION).contains(&width) && (1..=MAX_DIMENSION).contains(&height),
        "Invalid SVG dimensions"
    );
    let document = roxmltree::Document::parse(svg)?;
    ensure!(
        document.root_element().tag_name().name() == "svg",
        "Missing SVG root"
    );
    for node in document.descendants().filter(roxmltree::Node::is_element) {
        ensure!(
            [
                "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
                "defs", "clipPath", "title", "desc"
            ]
            .contains(&node.tag_name().name()),
            "Unsupported SVG element: {}",
            node.tag_name().name()
        );
        for attribute in node.attributes() {
            let name = attribute.name();
            let value = attribute.value();
            ensure!(
                !name.starts_with("on") && !["href", "style", "filter"].contains(&name),
                "Executable or external SVG content"
            );
            if ["fill", "stroke"].contains(&name) {
                ensure!(
                    [
                        "none", "black", "white", "#000", "#fff", "#000000", "#ffffff"
                    ]
                    .contains(&value.to_ascii_lowercase().as_str()),
                    "Non-monochrome SVG paint"
                );
            }
            if name.ends_with("opacity") {
                ensure!(
                    value.parse::<f64>()? == 1.0,
                    "Authored opacity is not allowed"
                );
            }
            if value.contains("url(") {
                ensure!(
                    name == "clip-path" && value.starts_with("url(#") && value.ends_with(')'),
                    "External SVG reference"
                );
            }
        }
    }
    let tree = usvg::Tree::from_data(svg.as_bytes(), &usvg::Options::default())?;
    ensure!(
        tree.size().width() == width as f32 && tree.size().height() == height as f32,
        "SVG dimensions differ from Figma"
    );
    Ok(())
}

fn output(root: &Path, path: &str, bytes: &[u8], check: bool) -> Result<()> {
    if check && path.starts_with("ios/GeneratedAssets.xcassets/") && path.contains(".imageset/") {
        return Ok(());
    }
    let path = root.join(path);
    if check {
        ensure!(
            fs::read(&path).with_context(|| format!("Missing icon output: {}", path.display()))?
                == bytes,
            "Stale icon output: {}",
            path.display()
        );
    } else {
        ensure!(!path.is_symlink(), "Refusing a symbolic-link icon output");
        fs::create_dir_all(path.parent().context("Icon directory missing")?)?;
        fs::write(path, bytes)?;
    }
    Ok(())
}

fn import(root: &Path, path: &Path) -> Result<()> {
    ensure!(
        fs::metadata(path)?.len() <= IMPORT_BYTE_LIMIT,
        "Import exceeds the byte budget"
    );
    let source: Import = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        source.format == 1 && source.assets.len() == ASSET_COUNT,
        "Incomplete Figma export inventory"
    );
    let mut assets = Vec::new();
    let mut pending = Vec::new();
    for asset in source.assets {
        validate_svg(&asset.svg, asset.width, asset.height)?;
        let path = source_path(asset.kind, &asset.name)?;
        pending.push((path, asset.svg.clone()));
        assets.push(Asset {
            name: asset.name,
            kind: asset.kind,
            node_id: asset.id,
            width: asset.width,
            height: asset.height,
            sha256: format!("{:x}", Sha256::digest(asset.svg.as_bytes())),
        });
    }
    let manifest = Manifest {
        format: source.format,
        file_key: source.file_key,
        review_node: source.review_node,
        assets,
        categories: source.categories,
        aliases: source.aliases,
    };
    validate_manifest(&manifest)?;
    for (path, svg) in pending {
        output(root, &path, svg.as_bytes(), false)?;
    }
    output(
        root,
        "design/icons.json",
        &serde_json::to_vec_pretty(&manifest)?,
        false,
    )
}

fn validate_manifest(manifest: &Manifest) -> Result<()> {
    ensure!(
        manifest.format == 1
            && manifest.file_key == "86k2lR3poqbl2lU6bqQG8V"
            && !manifest.review_node.is_empty(),
        "Unexpected Figma source identity"
    );
    let icons = manifest
        .assets
        .iter()
        .filter(|asset| asset.kind == Kind::Icon)
        .map(|asset| asset.name.as_str())
        .collect::<BTreeSet<_>>();
    let brands = manifest
        .assets
        .iter()
        .filter(|asset| asset.kind == Kind::Brand)
        .map(|asset| asset.name.as_str())
        .collect::<BTreeSet<_>>();
    ensure!(
        icons.len() == UI_ICON_COUNT
            && brands.len() == BRAND_ASSET_COUNT
            && manifest.assets.len() == ASSET_COUNT,
        "Incomplete or duplicate icon inventory"
    );
    ensure!(
        manifest.categories.len() == CATEGORY_MAPPING_COUNT
            && manifest.aliases.len() == ALIAS_COUNT,
        "Incomplete native icon mappings"
    );
    for (name, target) in manifest.categories.iter().chain(&manifest.aliases) {
        ensure!(
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_'),
            "Invalid icon mapping"
        );
        ensure!(
            icons.contains(target.as_str()),
            "Missing mapped icon: {target}"
        );
    }
    for asset in &manifest.assets {
        source_path(asset.kind, &asset.name)?;
    }
    Ok(())
}

fn raster(svg: &[u8], width: u32, height: u32, alpha: bool) -> Result<Vec<u8>> {
    ensure!(
        (1..=MAX_DIMENSION).contains(&width) && (1..=MAX_DIMENSION).contains(&height),
        "Invalid raster dimensions"
    );
    let tree = usvg::Tree::from_data(svg, &usvg::Options::default())?;
    let mut pixels = tiny_skia::Pixmap::new(width, height).context("Allocate icon raster")?;
    let transform = tiny_skia::Transform::from_scale(
        width as f32 / tree.size().width(),
        height as f32 / tree.size().height(),
    );
    resvg::render(&tree, transform, &mut pixels.as_mut());
    let mut bytes = Vec::new();
    for pixel in pixels.pixels() {
        let color = pixel.demultiply();
        ensure!(
            alpha || color.alpha() == OPAQUE_ALPHA,
            "A primary icon contains transparency"
        );
        ensure!(
            color.red() == color.green() && color.green() == color.blue(),
            "A raster contains authored color"
        );
        bytes.extend_from_slice(&[color.red(), color.green(), color.blue()]);
        if alpha {
            bytes.push(color.alpha());
        }
    }
    let mut result = Vec::new();
    let mut encoder = png::Encoder::new(&mut result, width, height);
    encoder.set_color(if alpha {
        png::ColorType::Rgba
    } else {
        png::ColorType::Rgb
    });
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header()?.write_image_data(&bytes)?;
    Ok(result)
}

pub fn generate(root: &Path, check: bool) -> Result<()> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(root.join("design/icons.json"))?)?;
    validate_manifest(&manifest)?;
    let mut sources = BTreeMap::new();
    for asset in &manifest.assets {
        let path = source_path(asset.kind, &asset.name)?;
        let bytes = fs::read(root.join(&path))?;
        ensure!(
            format!("{:x}", Sha256::digest(&bytes)) == asset.sha256,
            "Modified Figma export: {path}"
        );
        validate_svg(std::str::from_utf8(&bytes)?, asset.width, asset.height)?;
        if asset.kind == Kind::Icon {
            ensure!(
                asset.width == UI_ICON_GRID && asset.height == UI_ICON_GRID,
                "A UI icon must use the 24 px grid"
            );
        }
        sources.insert(asset.name.clone(), bytes);
    }
    output(
        root,
        "ios/GeneratedAssets.xcassets/Contents.json",
        &serde_json::to_vec_pretty(&json!({"info":{"version":1,"author":"xcode"}}))?,
        check,
    )?;
    let source = |name: &str| {
        sources
            .get(name)
            .map(Vec::as_slice)
            .with_context(|| format!("Missing source: {name}"))
    };
    for (catalog, environment) in [
        ("AppIcon", ""),
        ("AppIconDevelopment", "development-"),
        ("AppIconVerification", "verification-"),
    ] {
        for appearance in ["default", "dark", "tinted"] {
            output(
                root,
                &format!("ios/GeneratedAssets.xcassets/{catalog}.appiconset/{appearance}.png"),
                &raster(
                    source(&format!("app-icon-{environment}{appearance}"))?,
                    APP_ICON_SIZE,
                    APP_ICON_SIZE,
                    appearance == "dark",
                )?,
                check,
            )?;
        }
        output(
            root,
            &format!("ios/GeneratedAssets.xcassets/{catalog}.appiconset/Contents.json"),
            &serde_json::to_vec_pretty(&json!({"images":[
        {"filename":"default.png","idiom":"universal","platform":"ios","size":"1024x1024"},
        {"filename":"dark.png","idiom":"universal","platform":"ios","size":"1024x1024","appearances":[{"appearance":"luminosity","value":"dark"}]},
        {"filename":"tinted.png","idiom":"universal","platform":"ios","size":"1024x1024","appearances":[{"appearance":"luminosity","value":"tinted"}]}],"info":{"author":"xcode","version":1}}))?,
            check,
        )?;
    }
    for (name, target) in manifest
        .assets
        .iter()
        .filter(|a| a.kind == Kind::Icon)
        .map(|a| (&a.name, &a.name))
        .chain(manifest.aliases.iter())
    {
        let filename = format!("{target}.svg");
        let directory = format!("ios/GeneratedAssets.xcassets/{name}.imageset");
        let obsolete = root.join(format!("{directory}/{name}.svg"));
        if !check && name != target && obsolete.is_file() {
            fs::remove_file(obsolete)?;
        }
        output(
            root,
            &format!("{directory}/{filename}"),
            source(target)?,
            check,
        )?;
        output(
            root,
            &format!("{directory}/Contents.json"),
            &serde_json::to_vec_pretty(
                &json!({"images":[{"filename":filename,"idiom":"universal"}],"info":{"author":"xcode","version":1},"properties":{"preserves-vector-representation":true,"template-rendering-intent":"template"}}),
            )?,
            check,
        )?;
    }
    let entries = manifest
        .categories
        .iter()
        .map(|(key, value)| format!("    \"{key}\": \"{value}\",\n"))
        .collect::<String>();
    output(root, "ios/Sources/PhonebookKit/IconCatalog.swift", format!("public enum IconCatalog {{\n  public static let categories: [String: String] = [\n{entries}  ]\n}}\n").as_bytes(), check)?;
    println!(
        "PASS: 58 Figma UI icons, 39 category mappings, 16 native aliases, and 9 native app icon appearances"
    );
    Ok(())
}

pub fn run(root: &Path, input: Option<&Path>, check: bool) -> Result<()> {
    if check && input.is_some() {
        bail!("An import cannot be a read-only check");
    }
    if let Some(path) = input {
        import(root, path)?;
    }
    generate(root, check)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svg_boundary_rejects_executable_external_colored_translucent_and_oversized_assets()
    -> Result<()> {
        let valid = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><rect width=\"16\" height=\"16\" fill=\"white\"/></svg>";
        validate_svg(valid, 16, 16)?;
        for invalid in [
            valid.replace("white", "#777"),
            valid.replace("white", "red"),
            valid.replace("fill=", "opacity=\"0.5\" fill="),
            valid.replace("<rect", "<rect onclick=\"bad()\""),
            valid.replace("<rect", "<image href=\"https://example.com/image\""),
            valid.replace("<rect", "<script"),
            valid.replace("fill=", "style=\"color:black\" fill="),
        ] {
            assert!(validate_svg(&invalid, 16, 16).is_err());
        }
        assert!(validate_svg(valid, 4096, 4096).is_err());
        for name in ["", "../private", "file/name", "UPPER", "tooth.svg"] {
            assert!(source_path(Kind::Icon, name).is_err());
        }
        Ok(())
    }

    #[test]
    fn primary_and_dark_png_formats_are_decoded_independently() -> Result<()> {
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><rect width=\"16\" height=\"16\" fill=\"white\"/></svg>";
        for (size, alpha, color_type) in [
            (16, false, png::ColorType::Rgb),
            (48, false, png::ColorType::Rgb),
            (32, true, png::ColorType::Rgba),
        ] {
            let encoded = raster(svg, size, size, alpha)?;
            let reader = png::Decoder::new(std::io::Cursor::new(encoded)).read_info()?;
            assert_eq!(reader.info().width, size);
            assert_eq!(reader.info().height, size);
            assert_eq!(reader.info().color_type, color_type);
            assert_eq!(reader.info().bit_depth, png::BitDepth::Eight);
        }
        assert!(raster(b"<svg width=\"16\" height=\"16\"/>", 16, 16, false).is_err());
        let source = std::str::from_utf8(svg)?;
        assert!(raster(source.replace("white", "red").as_bytes(), 16, 16, false).is_err());
        let transparent = source.replace("white", "none");
        assert!(raster(transparent.as_bytes(), 16, 16, false).is_err());
        assert!(raster(transparent.as_bytes(), 16, 16, true).is_ok());
        Ok(())
    }
}
