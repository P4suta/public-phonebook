use anyhow::{Context, Result, bail, ensure};
use resvg::{tiny_skia, usvg};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    fs,
    io::Cursor,
    path::Path,
};

const NAME_LIMIT: usize = 64;
const SVG_BYTE_LIMIT: usize = 262_144;
const IMPORT_BYTE_LIMIT: u64 = 2_097_152;
const MAX_DIMENSION: u32 = 1200;
const UI_ICON_COUNT: usize = 92;
const BRAND_ASSET_COUNT: usize = 16;
const ASSET_COUNT: usize = UI_ICON_COUNT + BRAND_ASSET_COUNT;
const CATEGORY_MAPPING_COUNT: usize = 65;
const ALIAS_COUNT: usize = 16;
const UI_ICON_GRID: u32 = 24;
const APP_ICON_SIZE: u32 = 1024;
const OPAQUE_ALPHA: u8 = 255;
const PAPER_LEVEL: u8 = 255;
const RGB_CHANNELS: usize = 3;

const SVG_NAMESPACE: &str = "http://www.w3.org/2000/svg";
const ICON_LICENSE: &str = "design/licenses/Lucide.txt";
const PUBLIC_DIRECTORY: &str = "public";
const WEB_ICON_DIRECTORY: &str = "public/icons";
const ICON_ID_PREFIX: &str = "icon-";
/// Biome's two-space indent plus its minimum overlap of three characters.
const SHORT_KEY_WIDTH: usize = 5;
const WEB_ICON_LICENSE: &str = "public/icons/LICENSE.txt";
const FAVICON: &str = "public/favicon.ico";
const VECTOR_FAVICON: &str = "public/favicon.svg";
const APPLE_TOUCH_ICON: &str = "public/apple-touch-icon.png";
const MASK_ICON: &str = "public/mask-icon.svg";
const INSTALL_MANIFEST: &str = "public/manifest.webmanifest";
const SOCIAL_PREVIEW: &str = "public/social-preview.png";
const WEB_CATALOG: &str = "src/ui/icon-catalog.ts";

const LIGHT_FAVICON_MASTERS: [&str; 2] = ["favicon-16", "favicon-32"];
const VECTOR_FAVICON_MASTERS: (&str, &str) = ("favicon-32", "favicon-dark-32");
const APP_ICON_MASTER: &str = "app-icon-default";
const MASK_ICON_MASTER: &str = "mark-ink";
const SOCIAL_PREVIEW_MASTER: &str = "social-preview";
const APPLE_TOUCH_ICON_SIZE: u32 = 180;
const INSTALL_ICON_SIZES: [u32; 2] = [192, 512];
/// The iPhone app shows this icon for a category without a Figma master.
const CATEGORY_FALLBACK_ICON: &str = "file";

const SITE_NAME: &str = "Public Phonebook";
const SITE_DESCRIPTION: &str = "施設の電話番号をさがせます。";
const SITE_LANGUAGE: &str = "ja";
const SITE_START: &str = "/";
const SITE_DISPLAY: &str = "standalone";
const PAPER: &str = "#ffffff";
const INK: &str = "#000000";
const VECTOR_FAVICON_STYLE: &str = ".dark{display:none}@media (prefers-color-scheme: dark){.light{display:none}.dark{display:inline}}";

/// The Web App Manifest's maskable safe zone is a centered circle with a radius of 2/5 of the icon width.
const SAFE_ZONE_RADIUS: (u64, u64) = (2, 5);

const ICO_RESERVED: u16 = 0;
const ICO_TYPE: u16 = 1;
const ICO_PALETTE_COLORS: u8 = 0;
const ICO_ENTRY_RESERVED: u8 = 0;
const ICO_PLANES: u16 = 1;
const ICO_BITS_PER_PIXEL: u16 = 32;
const ICO_MAX_DIMENSION: u32 = 256;
const ICO_HEADER_BYTES: usize = 6;
const ICO_ENTRY_BYTES: usize = 16;

/// The pixel format of a raster and whether it may keep the master's transparency.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pixels {
    /// Opaque RGB.
    Opaque,
    /// Opaque RGBA for containers that expect 32-bit images.
    OpaqueWithAlpha,
    /// RGBA that keeps the master's transparency.
    Translucent,
}

/// How a serialized SVG treats the master's black and white paint.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Paint {
    /// Keeps the authored black and white.
    Authored,
    /// Paints black with the surrounding text color and refuses white.
    Foreground,
    /// Drops the paint of a foreground clip path, whose content contributes only its shape.
    Geometry,
}

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
            sha256: crate::sha256_hex(asset.svg.as_bytes()),
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

fn raster(svg: &[u8], width: u32, height: u32, format: Pixels) -> Result<Vec<u8>> {
    ensure!(
        (1..=MAX_DIMENSION).contains(&width) && (1..=MAX_DIMENSION).contains(&height),
        "Invalid raster dimensions"
    );
    let (opaque, alpha) = match format {
        Pixels::Opaque => (true, false),
        Pixels::OpaqueWithAlpha => (true, true),
        Pixels::Translucent => (false, true),
    };
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
            !opaque || color.alpha() == OPAQUE_ALPHA,
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

/// Decodes an encoded raster independently of the renderer that produced it.
fn decode(encoded: &[u8]) -> Result<(png::OutputInfo, Vec<u8>)> {
    let mut reader = png::Decoder::new(Cursor::new(encoded)).read_info()?;
    let mut pixels = vec![0; reader.output_buffer_size().context("Size an icon raster")?];
    let info = reader.next_frame(&mut pixels)?;
    pixels.truncate(info.buffer_size());
    Ok((info, pixels))
}

/// Refuses an opaque square icon with any non-paper pixel that reaches outside the maskable safe circle.
fn require_safe_zone(encoded: &[u8]) -> Result<()> {
    let (info, pixels) = decode(encoded)?;
    ensure!(
        info.color_type == png::ColorType::Rgb
            && info.bit_depth == png::BitDepth::Eight
            && info.width == info.height,
        "A maskable icon must be an opaque square"
    );
    let size = i64::from(info.width);
    let (numerator, denominator) = SAFE_ZONE_RADIUS;
    let radius = i128::from(2 * size) * i128::from(numerator);
    let limit = radius * radius;
    let scale = i128::from(denominator) * i128::from(denominator);
    for (index, pixel) in pixels.as_chunks::<RGB_CHANNELS>().0.iter().enumerate() {
        if *pixel == [PAPER_LEVEL; RGB_CHANNELS] {
            continue;
        }
        let index = i64::try_from(index)?;
        // Doubled coordinates keep the pixel corners and the center on integers.
        let reach =
            |cell: i64| i128::from((2 * cell - size).abs().max((2 * cell + 2 - size).abs()));
        let (x, y) = (reach(index % size), reach(index / size));
        ensure!(
            scale * (x * x + y * y) <= limit,
            "A maskable icon paints outside the central safe circle"
        );
    }
    Ok(())
}

/// Packs 32-bit PNG images into a Windows icon file with one directory entry per image.
fn icon_file(images: &[Vec<u8>]) -> Result<Vec<u8>> {
    ensure!(!images.is_empty(), "A Windows icon needs an image");
    let mut file = Vec::new();
    for field in [ICO_RESERVED, ICO_TYPE, u16::try_from(images.len())?] {
        file.extend_from_slice(&field.to_le_bytes());
    }
    let mut offset = ICO_HEADER_BYTES + ICO_ENTRY_BYTES * images.len();
    for image in images {
        let reader = png::Decoder::new(Cursor::new(image)).read_info()?;
        let info = reader.info();
        ensure!(
            info.color_type == png::ColorType::Rgba && info.bit_depth == png::BitDepth::Eight,
            "A Windows icon image must be 32-bit RGBA"
        );
        let dimension = |value: u32| -> Result<u8> {
            ensure!(
                (1..=ICO_MAX_DIMENSION).contains(&value),
                "A Windows icon image exceeds 256 pixels"
            );
            Ok(u8::try_from(value % ICO_MAX_DIMENSION)?)
        };
        file.extend_from_slice(&[
            dimension(info.width)?,
            dimension(info.height)?,
            ICO_PALETTE_COLORS,
            ICO_ENTRY_RESERVED,
        ]);
        file.extend_from_slice(&ICO_PLANES.to_le_bytes());
        file.extend_from_slice(&ICO_BITS_PER_PIXEL.to_le_bytes());
        file.extend_from_slice(&u32::try_from(image.len())?.to_le_bytes());
        file.extend_from_slice(&u32::try_from(offset)?.to_le_bytes());
        offset += image.len();
    }
    for image in images {
        file.extend_from_slice(image);
    }
    Ok(file)
}

fn escaped(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;")
}

fn paint(name: &str, value: &str, mode: Paint) -> Result<String> {
    if mode == Paint::Authored || !["fill", "stroke"].contains(&name) {
        return Ok(value.to_owned());
    }
    let value = value.to_ascii_lowercase();
    if value == "none" {
        return Ok(value);
    }
    ensure!(
        ["black", "#000", "#000000"].contains(&value.as_str()),
        "A UI icon must paint only with the foreground color"
    );
    Ok("currentColor".to_owned())
}

fn attributes(
    node: roxmltree::Node<'_, '_>,
    skip: &[&str],
    mode: Paint,
    identities: &mut BTreeSet<String>,
    markup: &mut String,
) -> Result<()> {
    for attribute in node.attributes() {
        ensure!(
            attribute.namespace().is_none(),
            "Namespaced SVG attribute: {}",
            attribute.name()
        );
        if skip.contains(&attribute.name())
            || (mode == Paint::Geometry && ["fill", "stroke"].contains(&attribute.name()))
        {
            continue;
        }
        if attribute.name() == "id" {
            ensure!(
                identities.insert(attribute.value().to_owned()),
                "Duplicate SVG identity: {}",
                attribute.value()
            );
        }
        write!(
            markup,
            " {}=\"{}\"",
            attribute.name(),
            escaped(&paint(attribute.name(), attribute.value(), mode)?)
        )?;
    }
    Ok(())
}

/// Serializes a validated master's element without text, titles, or descriptions.
fn element(
    node: roxmltree::Node<'_, '_>,
    mode: Paint,
    identities: &mut BTreeSet<String>,
    markup: &mut String,
) -> Result<()> {
    let name = node.tag_name().name();
    if ["title", "desc"].contains(&name) {
        return Ok(());
    }
    let mode = if name == "clipPath" && mode == Paint::Foreground {
        Paint::Geometry
    } else {
        mode
    };
    write!(markup, "<{name}")?;
    attributes(node, &[], mode, identities, markup)?;
    let children = node
        .children()
        .filter(roxmltree::Node::is_element)
        .collect::<Vec<_>>();
    if children.is_empty() {
        markup.push_str("/>");
        return Ok(());
    }
    markup.push('>');
    for child in children {
        element(child, mode, identities, markup)?;
    }
    write!(markup, "</{name}>")?;
    Ok(())
}

fn view_box(svg: &[u8]) -> Result<String> {
    let document = roxmltree::Document::parse(std::str::from_utf8(svg)?)?;
    Ok(escaped(
        document
            .root_element()
            .attribute("viewBox")
            .context("Missing SVG view box")?,
    ))
}

/// Writes a master's root as `tag` with the extra attributes in `head`, keeping its paint attributes and dropping its size.
fn regroup(
    svg: &[u8],
    tag: &str,
    head: &str,
    mode: Paint,
    identities: &mut BTreeSet<String>,
    markup: &mut String,
) -> Result<()> {
    let document = roxmltree::Document::parse(std::str::from_utf8(svg)?)?;
    let root = document.root_element();
    ensure!(root.tag_name().name() == "svg", "Missing SVG root");
    write!(markup, "<{tag}{head}")?;
    attributes(
        root,
        &["width", "height", "viewBox"],
        mode,
        identities,
        markup,
    )?;
    markup.push('>');
    for child in root.children().filter(roxmltree::Node::is_element) {
        element(child, mode, identities, markup)?;
    }
    write!(markup, "</{tag}>")?;
    Ok(())
}

/// Builds the web sprite's symbols, one per UI icon, painted with the surrounding text color.
fn symbols(masters: &[(&str, &[u8])]) -> Result<Vec<String>> {
    let mut identities = BTreeSet::new();
    let mut symbols = Vec::new();
    for (name, svg) in masters {
        let identity = format!("{ICON_ID_PREFIX}{name}");
        ensure!(
            slug(name) && identities.insert(identity.clone()),
            "Invalid or duplicate sprite symbol: {name}"
        );
        let mut markup = String::new();
        regroup(
            svg,
            "symbol",
            &format!(" id=\"{identity}\" viewBox=\"{}\"", view_box(svg)?),
            Paint::Foreground,
            &mut identities,
            &mut markup,
        )?;
        // The web catalog quotes each symbol in single quotes.
        ensure!(
            !markup.contains(['\'', '\\']),
            "A sprite symbol can't contain a quote or backslash: {name}"
        );
        symbols.push(markup);
    }
    Ok(symbols)
}

/// Combines the light and dark favicon masters into one vector favicon that follows the color scheme.
fn adaptive_favicon(light: &[u8], dark: &[u8]) -> Result<Vec<u8>> {
    let size = |svg: &[u8]| -> Result<(f32, f32)> {
        let tree = usvg::Tree::from_data(svg, &usvg::Options::default())?;
        Ok((tree.size().width(), tree.size().height()))
    };
    let (width, height) = size(light)?;
    let area = view_box(light)?;
    ensure!(
        size(dark)? == (width, height) && view_box(dark)? == area,
        "Favicon masters differ in size"
    );
    let mut identities = BTreeSet::new();
    let mut markup = format!(
        "<svg xmlns=\"{SVG_NAMESPACE}\" width=\"{width}\" height=\"{height}\" viewBox=\"{area}\"><style>{VECTOR_FAVICON_STYLE}</style>"
    );
    for (svg, scheme) in [(light, "light"), (dark, "dark")] {
        regroup(
            svg,
            "g",
            &format!(" class=\"{scheme}\""),
            Paint::Authored,
            &mut identities,
            &mut markup,
        )?;
    }
    markup.push_str("</svg>\n");
    Ok(markup.into_bytes())
}

fn web_path(path: &str) -> Result<&str> {
    path.strip_prefix(PUBLIC_DIRECTORY)
        .filter(|route| route.starts_with('/'))
        .with_context(|| format!("A web output must be public: {path}"))
}

/// Quotes an icon name as an object key only where JavaScript requires it.
fn object_key(name: &str) -> String {
    if name.contains('-') {
        format!("\"{name}\"")
    } else {
        name.to_owned()
    }
}

/// Writes the typed icon names, sprite symbols by name, category mappings, and site icon declarations for the web client.
fn web_catalog(
    manifest: &Manifest,
    symbols: &BTreeMap<&str, String>,
    favicons: &[u32],
    social: (u32, u32),
) -> Result<String> {
    let mut catalog = String::from(
        "// Generated by `just icons` from design/icons.json; edit the Figma masters instead.\nexport const iconNames = [\n",
    );
    let names = manifest
        .assets
        .iter()
        .filter(|asset| asset.kind == Kind::Icon)
        .map(|asset| asset.name.as_str())
        .collect::<BTreeSet<_>>();
    for name in &names {
        writeln!(catalog, "  \"{name}\",")?;
    }
    write!(
        catalog,
        "] as const;\n\nexport type IconName = (typeof iconNames)[number];\n\nexport const iconIdPrefix = \"{ICON_ID_PREFIX}\";\n\nexport const iconSymbols: Readonly<Record<IconName, string>> = {{\n"
    )?;
    ensure!(
        symbols.keys().copied().eq(names.iter().copied()),
        "Every icon needs exactly one sprite symbol"
    );
    for (name, symbol) in symbols {
        let key = object_key(name);
        // Biome keeps a string beside a short key and moves it below a longer one.
        let gap = if key.len() < SHORT_KEY_WIDTH {
            " "
        } else {
            "\n    "
        };
        writeln!(catalog, "  {key}:{gap}'{symbol}',")?;
    }
    catalog.push_str("};\n\nexport const categoryIcons = {\n");
    for (category, icon) in &manifest.categories {
        writeln!(catalog, "  {category}: \"{icon}\",")?;
    }
    ensure!(
        names.contains(CATEGORY_FALLBACK_ICON),
        "Missing category fallback icon"
    );
    let sizes = favicons
        .iter()
        .map(|size| format!("{size}x{size}"))
        .collect::<Vec<_>>()
        .join(" ");
    write!(
        catalog,
        "}} as const satisfies Readonly<Record<string, IconName>>;\n\nexport const categoryFallbackIcon: IconName = \"{CATEGORY_FALLBACK_ICON}\";\n\nexport const siteIcons = {{\n  favicon: {{ href: \"{}\", sizes: \"{sizes}\" }},\n  vectorFavicon: {{ href: \"{}\", type: \"image/svg+xml\" }},\n  appleTouchIcon: {{ href: \"{}\", sizes: \"{APPLE_TOUCH_ICON_SIZE}x{APPLE_TOUCH_ICON_SIZE}\" }},\n  maskIcon: {{ href: \"{}\", color: \"{INK}\" }},\n  manifest: {{ href: \"{}\" }},\n  socialPreview: {{ href: \"{}\", width: {}, height: {} }},\n}} as const;\n",
        web_path(FAVICON)?,
        web_path(VECTOR_FAVICON)?,
        web_path(APPLE_TOUCH_ICON)?,
        web_path(MASK_ICON)?,
        web_path(INSTALL_MANIFEST)?,
        web_path(SOCIAL_PREVIEW)?,
        social.0,
        social.1,
    )?;
    Ok(catalog)
}

#[derive(Default)]
struct Outputs(BTreeMap<String, Vec<u8>>);

impl Outputs {
    fn add(&mut self, path: impl Into<String>, bytes: Vec<u8>) -> Result<()> {
        let path = path.into();
        ensure!(
            self.0.insert(path.clone(), bytes).is_none(),
            "Two web outputs share {path}"
        );
        Ok(())
    }
}

/// Derives every web asset from the validated masters without touching the file system.
fn web_outputs(
    manifest: &Manifest,
    sources: &BTreeMap<String, Vec<u8>>,
    license: &[u8],
) -> Result<BTreeMap<String, Vec<u8>>> {
    let source = |name: &str| {
        sources
            .get(name)
            .map(Vec::as_slice)
            .with_context(|| format!("Missing source: {name}"))
    };
    let brand = |name: &str| {
        manifest
            .assets
            .iter()
            .find(|asset| asset.kind == Kind::Brand && asset.name == name)
            .with_context(|| format!("Missing brand master: {name}"))
    };
    let mut outputs = Outputs::default();
    let icons = manifest
        .assets
        .iter()
        .filter(|asset| asset.kind == Kind::Icon)
        .map(|asset| Ok((asset.name.as_str(), source(&asset.name)?)))
        .collect::<Result<BTreeMap<_, _>>>()?;
    let masters = icons.clone().into_iter().collect::<Vec<_>>();
    let symbols = masters
        .iter()
        .map(|(name, _)| *name)
        .zip(symbols(&masters)?)
        .collect::<BTreeMap<_, _>>();
    for (name, svg) in &icons {
        outputs.add(format!("{WEB_ICON_DIRECTORY}/{name}.svg"), svg.to_vec())?;
    }
    outputs.add(WEB_ICON_LICENSE, license.to_vec())?;

    let mut favicons = Vec::new();
    let mut favicon_sizes = Vec::new();
    for name in LIGHT_FAVICON_MASTERS {
        let asset = brand(name)?;
        ensure!(asset.width == asset.height, "A favicon must be square");
        favicons.push(raster(
            source(name)?,
            asset.width,
            asset.height,
            Pixels::OpaqueWithAlpha,
        )?);
        favicon_sizes.push(asset.width);
    }
    outputs.add(FAVICON, icon_file(&favicons)?)?;
    let (light, dark) = VECTOR_FAVICON_MASTERS;
    outputs.add(
        VECTOR_FAVICON,
        adaptive_favicon(source(light)?, source(dark)?)?,
    )?;

    let app = source(APP_ICON_MASTER)?;
    outputs.add(
        APPLE_TOUCH_ICON,
        raster(
            app,
            APPLE_TOUCH_ICON_SIZE,
            APPLE_TOUCH_ICON_SIZE,
            Pixels::Opaque,
        )?,
    )?;
    let mut install = Vec::new();
    for size in INSTALL_ICON_SIZES {
        for purpose in ["any", "maskable"] {
            let file = if purpose == "any" {
                format!("{PUBLIC_DIRECTORY}/app-icon-{size}.png")
            } else {
                format!("{PUBLIC_DIRECTORY}/app-icon-maskable-{size}.png")
            };
            let image = raster(app, size, size, Pixels::Opaque)?;
            if purpose == "maskable" {
                require_safe_zone(&image)?;
            }
            install.push(json!({
                "src": web_path(&file)?,
                "sizes": format!("{size}x{size}"),
                "type": "image/png",
                "purpose": purpose,
            }));
            outputs.add(file, image)?;
        }
    }
    outputs.add(
        INSTALL_MANIFEST,
        serde_json::to_vec_pretty(&json!({
            "id": SITE_START,
            "name": SITE_NAME,
            "short_name": SITE_NAME,
            "description": SITE_DESCRIPTION,
            "lang": SITE_LANGUAGE,
            "start_url": SITE_START,
            "scope": SITE_START,
            "display": SITE_DISPLAY,
            "background_color": PAPER,
            "theme_color": PAPER,
            "icons": install,
        }))?,
    )?;
    outputs.add(MASK_ICON, source(MASK_ICON_MASTER)?.to_vec())?;
    let social = brand(SOCIAL_PREVIEW_MASTER)?;
    outputs.add(
        SOCIAL_PREVIEW,
        raster(
            source(SOCIAL_PREVIEW_MASTER)?,
            social.width,
            social.height,
            Pixels::Opaque,
        )?,
    )?;
    outputs.add(
        WEB_CATALOG,
        web_catalog(
            manifest,
            &symbols,
            &favicon_sizes,
            (social.width, social.height),
        )?
        .into_bytes(),
    )?;
    Ok(outputs.0)
}

/// Removes or refuses files in the generator-owned web icon directory that no master produces.
fn reconcile(root: &Path, outputs: &BTreeMap<String, Vec<u8>>, check: bool) -> Result<()> {
    for entry in fs::read_dir(root.join(WEB_ICON_DIRECTORY))? {
        let entry = entry?;
        let name = entry.file_name();
        let path = format!(
            "{WEB_ICON_DIRECTORY}/{}",
            name.to_str().context("Non-UTF-8 icon output name")?
        );
        if outputs.contains_key(&path) {
            continue;
        }
        ensure!(!check, "Unexpected icon output: {path}");
        ensure!(
            entry.file_type()?.is_file(),
            "Refusing to remove a non-file icon output: {path}"
        );
        fs::remove_file(entry.path())?;
    }
    Ok(())
}

pub fn generate(root: &Path, check: bool) -> Result<()> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(root.join("design/icons.json"))?)?;
    validate_manifest(&manifest)?;
    let mut sources = BTreeMap::new();
    for asset in &manifest.assets {
        let path = source_path(asset.kind, &asset.name)?;
        let bytes = fs::read(root.join(&path))?;
        ensure!(
            crate::sha256_hex(&bytes) == asset.sha256,
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
                    if appearance == "dark" {
                        Pixels::Translucent
                    } else {
                        Pixels::Opaque
                    },
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
    let web = web_outputs(&manifest, &sources, &fs::read(root.join(ICON_LICENSE))?)?;
    for (path, bytes) in &web {
        output(root, path, bytes, check)?;
    }
    reconcile(root, &web, check)?;
    println!(
        "PASS: {UI_ICON_COUNT} Figma UI icons, {CATEGORY_MAPPING_COUNT} category mappings, {ALIAS_COUNT} native aliases, 9 native app icon appearances, and {} web outputs",
        web.len()
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
        for (size, pixels, color_type) in [
            (16, Pixels::Opaque, png::ColorType::Rgb),
            (48, Pixels::Opaque, png::ColorType::Rgb),
            (32, Pixels::OpaqueWithAlpha, png::ColorType::Rgba),
            (32, Pixels::Translucent, png::ColorType::Rgba),
        ] {
            let encoded = raster(svg, size, size, pixels)?;
            let reader = png::Decoder::new(std::io::Cursor::new(encoded)).read_info()?;
            assert_eq!(reader.info().width, size);
            assert_eq!(reader.info().height, size);
            assert_eq!(reader.info().color_type, color_type);
            assert_eq!(reader.info().bit_depth, png::BitDepth::Eight);
        }
        assert!(raster(b"<svg width=\"16\" height=\"16\"/>", 16, 16, Pixels::Opaque).is_err());
        let source = std::str::from_utf8(svg)?;
        assert!(
            raster(
                source.replace("white", "red").as_bytes(),
                16,
                16,
                Pixels::Opaque
            )
            .is_err()
        );
        let transparent = source.replace("white", "none");
        for pixels in [Pixels::Opaque, Pixels::OpaqueWithAlpha] {
            assert!(raster(transparent.as_bytes(), 16, 16, pixels).is_err());
        }
        let (_, kept) = decode(&raster(
            transparent.as_bytes(),
            16,
            16,
            Pixels::Translucent,
        )?)?;
        assert!(kept.as_chunks::<4>().0.iter().all(|pixel| pixel[3] == 0));
        Ok(())
    }

    const PAPER_SQUARE: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><rect width=\"64\" height=\"64\" fill=\"white\"/>";

    fn repository() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn little_endian(bytes: &[u8], at: usize, width: usize) -> usize {
        bytes[at..at + width]
            .iter()
            .rev()
            .fold(0, |value, byte| value << 8 | usize::from(*byte))
    }

    #[test]
    fn icon_file_directory_describes_each_embedded_png() -> Result<()> {
        let svg = PAPER_SQUARE.replace("64", "16") + "</svg>";
        let images = [16, 32, 48]
            .into_iter()
            .map(|size| raster(svg.as_bytes(), size, size, Pixels::OpaqueWithAlpha))
            .collect::<Result<Vec<_>>>()?;
        let file = icon_file(&images)?;
        assert_eq!(little_endian(&file, 0, 2), 0);
        assert_eq!(little_endian(&file, 2, 2), 1);
        assert_eq!(little_endian(&file, 4, 2), images.len());
        for (index, size) in [16, 32, 48].into_iter().enumerate() {
            let entry = 6 + 16 * index;
            assert_eq!(usize::from(file[entry]), size);
            assert_eq!(usize::from(file[entry + 1]), size);
            assert_eq!(file[entry + 2], 0);
            assert_eq!(file[entry + 3], 0);
            assert_eq!(little_endian(&file, entry + 4, 2), 1);
            assert_eq!(little_endian(&file, entry + 6, 2), 32);
            let length = little_endian(&file, entry + 8, 4);
            let offset = little_endian(&file, entry + 12, 4);
            let (info, pixels) = decode(&file[offset..offset + length])?;
            assert_eq!((info.width, info.height), (size as u32, size as u32));
            assert_eq!(info.color_type, png::ColorType::Rgba);
            assert_eq!(info.bit_depth, png::BitDepth::Eight);
            assert!(
                pixels
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .all(|pixel| pixel[3] == 255)
            );
        }
        let rgb = raster(svg.as_bytes(), 16, 16, Pixels::Opaque)?;
        assert!(icon_file(&[rgb]).is_err());
        assert!(icon_file(&[]).is_err());
        let oversized = PAPER_SQUARE.replace("64", "300") + "</svg>";
        assert!(
            raster(oversized.as_bytes(), 300, 300, Pixels::OpaqueWithAlpha)
                .and_then(|image| icon_file(&[image]))
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn maskable_safe_zone_refuses_foreground_outside_the_central_circle() -> Result<()> {
        let centered = format!(
            "{PAPER_SQUARE}<rect x=\"20\" y=\"20\" width=\"24\" height=\"24\" fill=\"black\"/></svg>"
        );
        require_safe_zone(&raster(centered.as_bytes(), 64, 64, Pixels::Opaque)?)?;
        let square_corners = format!(
            "{PAPER_SQUARE}<rect x=\"12\" y=\"12\" width=\"40\" height=\"40\" fill=\"black\"/></svg>"
        );
        assert!(
            require_safe_zone(&raster(square_corners.as_bytes(), 64, 64, Pixels::Opaque)?).is_err()
        );
        let corner = format!("{PAPER_SQUARE}<rect width=\"1\" height=\"1\" fill=\"black\"/></svg>");
        assert!(require_safe_zone(&raster(corner.as_bytes(), 64, 64, Pixels::Opaque)?).is_err());
        let wide = format!("{PAPER_SQUARE}</svg>").replace("width=\"64\"", "width=\"128\"");
        assert!(require_safe_zone(&raster(wide.as_bytes(), 128, 64, Pixels::Opaque)?).is_err());
        let master = fs::read(repository().join("design/brand/app-icon-default.svg"))?;
        for size in INSTALL_ICON_SIZES {
            require_safe_zone(&raster(&master, size, size, Pixels::Opaque)?)?;
        }
        Ok(())
    }

    #[test]
    fn sprite_symbols_paint_with_the_foreground_color_and_keep_unique_identities() -> Result<()> {
        let master = "<svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<title>Check</title>\n<path d=\"M20 6L9 17L4 12\" stroke=\"black\" stroke-width=\"2\"/>\n<circle cx=\"1\" cy=\"1\" r=\"1\" fill=\"#000\"/>\n</svg>\n";
        let drawn = symbols(&[("check", master.as_bytes()), ("dot", master.as_bytes())])?;
        let body = "<path d=\"M20 6L9 17L4 12\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"1\" cy=\"1\" r=\"1\" fill=\"currentColor\"/></symbol>";
        assert_eq!(
            drawn,
            [
                format!("<symbol id=\"icon-check\" viewBox=\"0 0 24 24\" fill=\"none\">{body}"),
                format!("<symbol id=\"icon-dot\" viewBox=\"0 0 24 24\" fill=\"none\">{body}"),
            ]
        );
        let document = format!("<svg xmlns=\"{SVG_NAMESPACE}\">{}</svg>", drawn.join(""));
        usvg::Tree::from_data(document.as_bytes(), &usvg::Options::default())?;
        let white = master.replace("stroke=\"black\"", "stroke=\"white\"");
        assert!(symbols(&[("check", white.as_bytes())]).is_err());
        let identified = master.replace("<path", "<path id=\"icon-dot\"");
        assert!(symbols(&[("check", identified.as_bytes()), ("dot", master.as_bytes())]).is_err());
        assert!(symbols(&[("check", master.as_bytes()), ("check", master.as_bytes())]).is_err());
        let quoted = master.replace("<path", "<path data-label=\"it's\"");
        assert!(symbols(&[("check", quoted.as_bytes())]).is_err());
        Ok(())
    }

    #[test]
    fn sprite_symbols_keep_clip_geometry_without_its_paint() -> Result<()> {
        let master = "<svg width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<g clip-path=\"url(#clip0_1_2)\">\n<path d=\"M8 6L10 4\" stroke=\"black\" stroke-width=\"2\"/>\n</g>\n<defs>\n<clipPath id=\"clip0_1_2\">\n<rect width=\"24\" height=\"24\" fill=\"white\"/>\n</clipPath>\n</defs>\n</svg>\n";
        assert_eq!(
            symbols(&[("ruler", master.as_bytes())])?,
            [
                "<symbol id=\"icon-ruler\" viewBox=\"0 0 24 24\" fill=\"none\"><g clip-path=\"url(#clip0_1_2)\"><path d=\"M8 6L10 4\" stroke=\"currentColor\" stroke-width=\"2\"/></g><defs><clipPath id=\"clip0_1_2\"><rect width=\"24\" height=\"24\"/></clipPath></defs></symbol>"
            ]
        );
        let painted = master.replace(
            "<path",
            "<rect width=\"2\" height=\"2\" fill=\"white\"/><path",
        );
        assert!(symbols(&[("ruler", painted.as_bytes())]).is_err());
        Ok(())
    }

    #[test]
    fn adaptive_favicon_switches_between_the_light_and_dark_masters() -> Result<()> {
        let light = fs::read(repository().join("design/brand/favicon-32.svg"))?;
        let dark = fs::read(repository().join("design/brand/favicon-dark-32.svg"))?;
        let favicon = adaptive_favicon(&light, &dark)?;
        let text = std::str::from_utf8(&favicon)?;
        assert!(text.starts_with(&format!(
            "<svg xmlns=\"{SVG_NAMESPACE}\" width=\"32\" height=\"32\" viewBox=\"0 0 32 32\"><style>"
        )));
        assert!(text.contains("@media (prefers-color-scheme: dark)"));
        assert_eq!(text.matches("<g class=\"light\" fill=\"none\">").count(), 1);
        assert_eq!(text.matches("<g class=\"dark\" fill=\"none\">").count(), 1);
        let tree = usvg::Tree::from_data(&favicon, &usvg::Options::default())?;
        assert_eq!((tree.size().width(), tree.size().height()), (32.0, 32.0));
        assert!(adaptive_favicon(&light, &light).is_err());
        let small = fs::read(repository().join("design/brand/favicon-dark-16.svg"))?;
        assert!(adaptive_favicon(&light, &small).is_err());
        Ok(())
    }

    #[test]
    fn web_catalog_lists_icon_names_category_mappings_and_site_assets() -> Result<()> {
        let manifest: Manifest =
            serde_json::from_slice(&fs::read(repository().join("design/icons.json"))?)?;
        let mut drawn = manifest
            .assets
            .iter()
            .filter(|asset| asset.kind == Kind::Icon)
            .map(|asset| {
                (
                    asset.name.as_str(),
                    format!("<symbol id=\"icon-{}\"/>", asset.name),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let catalog = web_catalog(&manifest, &drawn, &[16, 32], (1200, 630))?;
        assert!(catalog.starts_with(
            "// Generated by `just icons` from design/icons.json; edit the Figma masters instead.\nexport const iconNames = [\n  \"accessibility\",\n  \"archive\",\n"
        ));
        assert!(catalog.contains(
            "] as const;\n\nexport type IconName = (typeof iconNames)[number];\n\nexport const iconIdPrefix = \"icon-\";\n\nexport const iconSymbols: Readonly<Record<IconName, string>> = {\n  accessibility:\n    '<symbol id=\"icon-accessibility\"/>',\n  archive:\n    '<symbol id=\"icon-archive\"/>',\n  \"arrow-left\":\n    '<symbol id=\"icon-arrow-left\"/>',\n"
        ));
        assert!(catalog.contains(
            "  x: '<symbol id=\"icon-x\"/>',\n};\n\nexport const categoryIcons = {\n  agriculture_employment_support: \"sprout\",\n"
        ));
        assert!(catalog.contains("  brain:\n    '<symbol id=\"icon-brain\"/>',\n"));
        assert!(catalog.contains("  file: '<symbol id=\"icon-file\"/>',\n  \"file-braces\":\n"));
        assert!(catalog.contains(
            "} as const satisfies Readonly<Record<string, IconName>>;\n\nexport const categoryFallbackIcon: IconName = \"file\";\n"
        ));
        assert!(catalog.ends_with(
            "export const siteIcons = {\n  favicon: { href: \"/favicon.ico\", sizes: \"16x16 32x32\" },\n  vectorFavicon: { href: \"/favicon.svg\", type: \"image/svg+xml\" },\n  appleTouchIcon: { href: \"/apple-touch-icon.png\", sizes: \"180x180\" },\n  maskIcon: { href: \"/mask-icon.svg\", color: \"#000000\" },\n  manifest: { href: \"/manifest.webmanifest\" },\n  socialPreview: { href: \"/social-preview.png\", width: 1200, height: 630 },\n} as const;\n"
        ));
        let mappings = catalog
            .split_once("export const categoryIcons = {\n")
            .and_then(|(_, rest)| rest.split_once("} as const"))
            .context("Missing category mappings")?
            .0;
        assert_eq!(mappings.lines().count(), CATEGORY_MAPPING_COUNT);
        drawn.remove("x");
        assert!(web_catalog(&manifest, &drawn, &[16, 32], (1200, 630)).is_err());
        Ok(())
    }

    fn copy_tree(source: &Path, target: &Path) -> Result<()> {
        fs::create_dir_all(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let destination = target.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_tree(&entry.path(), &destination)?;
            } else {
                fs::copy(entry.path(), destination)?;
            }
        }
        Ok(())
    }

    fn refused(root: &Path, expected: &str) {
        let error = generate(root, true).err().map(|error| format!("{error:#}"));
        assert!(
            error
                .as_deref()
                .is_some_and(|message| message.contains(expected)),
            "expected {expected}, got {error:?}"
        );
    }

    #[test]
    fn check_refuses_changed_masters_missing_mappings_and_stale_or_unexpected_outputs() -> Result<()>
    {
        let directory = tempfile::tempdir()?;
        let root = directory.path();
        copy_tree(&repository().join("design"), &root.join("design"))?;
        generate(root, false)?;
        generate(root, true)?;

        let catalog = root.join(WEB_CATALOG);
        let current = fs::read(&catalog)?;
        fs::write(&catalog, [current.as_slice(), b" "].concat())?;
        refused(root, "Stale icon output");
        fs::remove_file(&catalog)?;
        refused(root, "Missing icon output");
        fs::write(&catalog, &current)?;
        let unexpected = root.join(WEB_ICON_DIRECTORY).join("lucide.svg");
        fs::write(&unexpected, &current)?;
        refused(root, "Unexpected icon output");
        generate(root, false)?;
        assert!(!unexpected.exists());
        generate(root, true)?;

        let favicon = root.join(FAVICON);
        let bytes = fs::read(&favicon)?;
        fs::write(&favicon, &bytes[..bytes.len() - 1])?;
        refused(root, "Stale icon output");
        fs::write(&favicon, &bytes)?;

        let master = root.join("design/icons/check.svg");
        let original = fs::read_to_string(&master)?;
        fs::write(&master, original.replace("M20 6", "M21 6"))?;
        refused(root, "Modified Figma export");
        fs::write(&master, &original)?;

        let manifest = root.join("design/icons.json");
        let text = fs::read_to_string(&manifest)?;
        fs::write(
            &manifest,
            text.replace("\"dental\": \"tooth\"", "\"dental\": \"molar\""),
        )?;
        refused(root, "Missing mapped icon");
        fs::write(&manifest, &text)?;
        generate(root, true)
    }
}
