use super::*;

const MAX_HTML_TABLE_ROWS: usize = 10000;
const NUMERIC_CONSUMER_PHONE_MIN_DIGITS: usize = 9;
const NUMERIC_CONSUMER_PHONE_MAX_DIGITS: usize = 10;
const LAST_PREFECTURE_CODE: u8 = 47;
const EDUCATION_HEADER_ROWS: usize = 12;
const SCHOOL_ID_LENGTH: usize = 13;
const SCHOOL_PREFECTURE_BAND: std::ops::Range<usize> = 2..4;
const POLICE_CONSULTATION_CONTACTS: usize = 51;
const FIRE_DIRECTORY_BASE: &str = "https://www.fdma.go.jp/relocation/syobodan/welcome/search";
const MAX_REGIONAL_PENSION_OFFICES: usize = 100;

#[derive(Clone, Debug, Default)]
struct Cell {
    text: String,
    href: Option<String>,
}

fn selector(value: &str) -> Selector {
    Selector::parse(value).expect("constant selector")
}

pub(super) fn plain(element: scraper::ElementRef<'_>) -> String {
    let mut output = String::new();
    for node in element.descendants() {
        match node.value() {
            scraper::Node::Text(value) => output.push_str(value),
            scraper::Node::Element(value) if matches!(value.name(), "br" | "p" | "div") => {
                output.push('\n')
            }
            _ => {}
        }
    }
    output
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn table_rows(table: scraper::ElementRef<'_>) -> Result<Vec<Vec<Cell>>> {
    let mut carried: BTreeMap<usize, (usize, Cell)> = BTreeMap::new();
    let mut rows = Vec::new();
    for tr in table.select(&selector("tr")).filter(|row| {
        row.ancestors()
            .filter_map(scraper::ElementRef::wrap)
            .find(|element| element.value().name() == "table")
            .is_some_and(|parent| parent.id() == table.id())
    }) {
        ensure!(
            rows.len() < MAX_HTML_TABLE_ROWS,
            "HTML table exceeds row bound"
        );
        let mut cells: BTreeMap<usize, Cell> = carried
            .iter()
            .map(|(index, (_, cell))| (*index, cell.clone()))
            .collect();
        carried.retain(|_, (remaining, _)| {
            *remaining -= 1;
            *remaining > 0
        });
        let mut cursor = 0;
        for element in tr
            .children()
            .filter_map(scraper::ElementRef::wrap)
            .filter(|element| matches!(element.value().name(), "td" | "th"))
        {
            while cells.contains_key(&cursor) {
                cursor += 1;
            }
            let span = |name: &str| -> Result<usize> {
                Ok(element.value().attr(name).unwrap_or("1").parse::<usize>()?)
            };
            let span = phonebook_core::TableSpan::parse(cursor, span("colspan")?, span("rowspan")?)
                .context("Invalid or excessive HTML table span")?;
            let cell = Cell {
                text: plain(element),
                href: element
                    .select(&selector("a[href]"))
                    .next()
                    .and_then(|anchor| anchor.value().attr("href"))
                    .map(str::to_owned),
            };
            for index in cursor..span.end() {
                ensure!(!cells.contains_key(&index), "Overlapping HTML table spans");
                cells.insert(index, cell.clone());
                if span.remaining_rows() > 0 {
                    carried.insert(index, (span.remaining_rows(), cell.clone()));
                }
            }
            cursor = span.end();
        }
        if let Some(last) = cells.keys().next_back().copied() {
            rows.push(
                (0..=last)
                    .map(|index| cells.remove(&index).unwrap_or_default())
                    .collect(),
            );
        }
    }
    ensure!(carried.is_empty(), "HTML row span extends beyond table");
    Ok(rows)
}

fn consumer_phone(raw: &str) -> Result<String> {
    let raw = raw.trim();
    if phonebook_core::normalize_phone(raw).is_ok() {
        return Ok(raw.to_owned());
    }
    ensure!(
        matches!(
            raw.len(),
            NUMERIC_CONSUMER_PHONE_MIN_DIGITS | NUMERIC_CONSUMER_PHONE_MAX_DIGITS
        ) && raw.bytes().all(|byte| byte.is_ascii_digit())
            && !raw.starts_with('0'),
        "Invalid numeric consumer telephone"
    );
    let restored = format!("0{raw}");
    phonebook_core::normalize_phone(&restored)
        .map_err(|_| anyhow::anyhow!("Invalid restored consumer telephone"))?;
    Ok(restored)
}

pub(super) struct Entry {
    pub category: Category,
    pub name: String,
    pub address: String,
    pub telephone: String,
    pub prefecture: String,
    pub website: Option<String>,
    pub record_id: String,
}

pub(super) fn reject(report: &mut SourceReport, issue: &str) {
    report.invalid += 1;
    *report.issues.entry(issue.into()).or_default() += 1;
}

pub(super) fn add(
    entry: Entry,
    source: &mut SourceReport,
    collection: &mut Collection,
    license: &str,
) -> Result<()> {
    source.rows += 1;
    let numbers = phones(&entry.telephone);
    if entry.telephone.trim().is_empty() {
        source.missing_phone += 1;
        return Ok(());
    }
    if numbers.is_empty() {
        reject(source, "invalid_phone");
        return Ok(());
    }
    let prefecture = collection
        .prefectures
        .iter()
        .find(|prefecture| {
            entry.prefecture == prefecture.name || entry.prefecture == prefecture.code
        })
        .cloned()
        .or_else(|| {
            collection
                .region(
                    &entry.address,
                    &entry.prefecture,
                    &(1..=LAST_PREFECTURE_CODE).collect::<Vec<_>>(),
                )
                .map(|(prefecture, _)| prefecture)
        });
    let Some(prefecture) = prefecture else {
        reject(source, "unknown_prefecture");
        return Ok(());
    };
    if entry.name.trim().is_empty() || entry.address.trim().is_empty() {
        reject(source, "missing_identity_or_address");
        return Ok(());
    }
    if collection
        .prefectures
        .iter()
        .any(|other| entry.address.starts_with(&other.name) && other.code != prefecture.code)
    {
        reject(source, "prefecture_conflict");
        return Ok(());
    }
    let address = if entry.address.starts_with(&prefecture.name) {
        entry.address
    } else {
        format!("{}{}", prefecture.name, entry.address)
    };
    let canonical = |value: &str| {
        store::normalized(value)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let identity = serde_json::to_vec(&(
        entry.category,
        canonical(&entry.name),
        canonical(&address),
        numbers.iter().map(|phone| &phone.e164).collect::<Vec<_>>(),
    ))?;
    let id = format!("{}:{:x}", entry.category.key(), Sha256::digest(identity));
    if collection.contacts.contains_key(&id) {
        source.duplicate += 1;
        return Ok(());
    }
    let municipality_code = collection
        .region(&address, &prefecture.name, &[prefecture.code.parse()?])
        .and_then(|(_, code)| code);
    let official_url = entry.website.as_deref().and_then(store::web_url);
    if entry
        .website
        .as_ref()
        .is_some_and(|value| !value.is_empty())
        && official_url.is_none()
    {
        *source
            .issues
            .entry("unsafe_official_url".into())
            .or_default() += 1;
    }
    collection.add(
        Contact {
            source_record_id: if entry.record_id.is_empty() {
                id.clone()
            } else {
                entry.record_id
            },
            id,
            prefecture_code: prefecture.code,
            prefecture: prefecture.name,
            municipality_code,
            category: entry.category,
            name: entry.name,
            address,
            phones: numbers,
            official_url,
            source_id: source.id.clone(),
            source_url: source.url.clone(),
            license: license.into(),
            license_url: source.license_url.clone(),
            data_as_of: source.data_as_of.clone(),
            retrieved_at: source.retrieved_at.clone(),
            official_phone_observed: false,
            official_phone_source: None,
        },
        source,
    )
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Layout {
    Table,
    Parent,
    Foreign,
    Labour,
    Child,
    Withdrawal,
    Consumer,
    Higher,
    Tax,
    Pension,
    Fire,
    Seed,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Provider {
    id: String,
    layout: Layout,
    category: Category,
    index_url: String,
    license_url: String,
    license: String,
    reuse_marker: String,
    data_as_of: String,
    #[serde(default)]
    download_pattern: Option<String>,
    #[serde(default)]
    downloads: Option<usize>,
    #[serde(default)]
    name_column: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    sha256: Option<String>,
}

fn compact(value: &str) -> String {
    unicode_normalization::UnicodeNormalization::nfkc(value)
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn address(value: &str) -> String {
    let telephone =
        Regex::new(r"(?s)(?:^|\s)電\s*話\s*[:：]?\s*[0-9０-９+＋(（].*$").expect("constant regex");
    let value = telephone.replace(value, "");
    let postal = Regex::new(r"^\s*〒?\s*[0-9０-９]{3}\s*[-‐‑－−ー]\s*[0-9０-９]{4}\s*")
        .expect("constant regex");
    postal
        .replace(&value, "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn matching_prefecture(value: &str, collection: &Collection) -> String {
    let value = compact(value);
    collection
        .prefectures
        .iter()
        .find(|prefecture| {
            value == prefecture.name
                || value
                    == prefecture
                        .name
                        .strip_suffix('県')
                        .or_else(|| prefecture.name.strip_suffix('府'))
                        .or_else(|| prefecture.name.strip_suffix('都'))
                        .unwrap_or(&prefecture.name)
        })
        .map(|prefecture| prefecture.name.clone())
        .unwrap_or_default()
}

fn link(href: Option<&str>, base: &str) -> Option<String> {
    let url = Url::parse(base).ok()?.join(href?).ok()?;
    store::web_url(url.as_str())
}

fn fields(table: scraper::ElementRef<'_>) -> Result<BTreeMap<String, Cell>> {
    let mut output = BTreeMap::new();
    for row in table_rows(table)? {
        if row.len() == 2 {
            ensure!(
                output
                    .insert(compact(&row[0].text), row[1].clone())
                    .is_none(),
                "Duplicate directory field"
            );
        }
    }
    Ok(output)
}

fn tables(
    html: &Html,
    provider: &Provider,
    prefecture: &str,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let mut identified = 0;
    let mut heading_prefecture = prefecture.to_owned();
    for table in html.select(&selector("h2,h3,h4,table")) {
        if table.value().name() != "table" {
            let known = matching_prefecture(&plain(table), collection);
            if !known.is_empty() {
                heading_prefecture = known;
            }
            continue;
        }
        let rows = table_rows(table)?;
        let mut columns = None;
        for row in rows {
            let find = |names: &[&str]| {
                row.iter()
                    .enumerate()
                    .rfind(|(_, cell)| names.contains(&compact(&cell.text).as_str()))
                    .map(|(index, _)| index)
            };
            let name = find(&[
                provider.name_column.as_deref().unwrap_or("名称"),
                "名称",
                "ふるさとハローワーク名",
                "税務署名",
                "局名",
                "コーナー名",
            ]);
            let location = find(&["所在地", "住所", "住所・連絡先"]).or_else(|| {
                row.iter()
                    .position(|cell| compact(&cell.text).starts_with("所在地"))
            });
            let phone = find(&["電話番号", "電話", "TEL", "電話番号(代表)"])
                .or_else(|| find(&["住所・連絡先"]));
            if let (Some(name), Some(location), Some(phone)) = (name, location, phone) {
                columns = Some((
                    name,
                    location,
                    phone,
                    find(&["都道府県", "都道府県名", "管轄区域"]),
                ));
                identified += 1;
                continue;
            }
            let Some((name, location, phone, region)) = columns else {
                continue;
            };
            if row.get(name).is_none_or(|cell| cell.text.is_empty()) {
                continue;
            }
            ensure!(
                row.len() > name.max(location).max(phone),
                "Incomplete contact table row"
            );
            let mut name_text = row[name]
                .text
                .replace('\n', " ")
                .trim_start_matches('★')
                .to_owned();
            if name_text.is_empty() {
                continue;
            }
            if provider.category == Category::TaxOffice && !name_text.ends_with("税務署") {
                name_text.push_str("税務署");
            }
            let row_prefecture = region
                .and_then(|index| row.get(index))
                .map(|cell| matching_prefecture(&cell.text, collection))
                .unwrap_or_default();
            let context = if row_prefecture.is_empty() {
                heading_prefecture.clone()
            } else {
                row_prefecture
            };
            let location_text = if provider.category == Category::TaxOffice {
                row[location]
                    .text
                    .split("令和")
                    .next()
                    .unwrap_or(&row[location].text)
            } else {
                &row[location].text
            };
            add(
                Entry {
                    category: provider.category,
                    name: name_text,
                    address: address(location_text),
                    telephone: row[phone].text.clone(),
                    prefecture: context,
                    website: link(row[name].href.as_deref(), &source.url),
                    record_id: String::new(),
                },
                source,
                collection,
                &provider.license,
            )?;
        }
    }
    ensure!(
        identified > 0,
        "No recognized contact tables for {}",
        provider.id
    );
    Ok(())
}

fn labour(
    html: &Html,
    provider: &Provider,
    prefecture: &str,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let mut category = None;
    let mut bureau = String::new();
    let mut bureau_address = String::new();
    let mut identified = 0;
    for element in html.select(&selector("h2,table")) {
        if element.value().name() == "h2" {
            let title = compact(&plain(element));
            category = if title.contains("労働基準監督署") {
                Some(Category::LabourInspection)
            } else if title.contains("公共職業安定所") {
                Some(Category::EmploymentOffice)
            } else if title.ends_with("労働局") {
                bureau = title;
                Some(Category::LabourBureau)
            } else {
                None
            };
            continue;
        }
        let Some(category) = category else {
            continue;
        };
        let mut columns = None;
        for row in table_rows(element)? {
            let find = |name: &str| row.iter().rposition(|cell| compact(&cell.text) == name);
            if let (Some(name), Some(location), Some(phone)) = (
                find("機関名称")
                    .or_else(|| find("地方機関"))
                    .or_else(|| find("機関名"))
                    .or_else(|| find("名称")),
                find("所在地"),
                find("電話").or_else(|| find("電話番号")),
            ) {
                columns = Some((name, location, phone));
                identified += 1;
                continue;
            }
            let Some((name, location, phone)) = columns else {
                continue;
            };
            ensure!(
                row.len() > name.max(location).max(phone),
                "Incomplete labour directory row"
            );
            let raw_name = row[name]
                .text
                .replace("案内図", "")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if raw_name.is_empty() {
                continue;
            }
            let mut location_text = address(&row[location].text);
            let title = match category {
                Category::LabourBureau => {
                    if raw_name.contains("労働局") {
                        bureau = raw_name.clone();
                        bureau_address = location_text.clone();
                        raw_name
                    } else {
                        if !location_text.contains(['市', '区', '郡']) {
                            location_text = bureau_address.clone();
                        } else {
                            bureau_address = location_text.clone();
                        }
                        format!("{bureau} {raw_name}")
                    }
                }
                Category::LabourInspection => format!("労働基準監督署 {raw_name}"),
                _ if raw_name.contains("ハローワーク") => raw_name,
                _ => format!("ハローワーク {raw_name}"),
            };
            add(
                Entry {
                    category,
                    name: title,
                    address: location_text,
                    telephone: row[phone].text.clone(),
                    prefecture: prefecture.into(),
                    website: link(row[name].href.as_deref(), &source.url),
                    record_id: String::new(),
                },
                source,
                collection,
                &provider.license,
            )?;
        }
    }
    ensure!(identified > 0, "No recognized labour offices");
    Ok(())
}

fn child_guidance(
    html: &Html,
    provider: &Provider,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let mut prefecture = String::new();
    let mut parent = String::new();
    let mut identified = 0;
    let location_label = Regex::new(r"^住\s*所\s*[：:]\s*")?;
    let phone_label = Regex::new(r"^電話番号\s*[：:]\s*")?;
    for element in html.select(&selector("h2, p")) {
        if element.value().name() == "h2" {
            let known = matching_prefecture(&plain(element), collection);
            if !known.is_empty() {
                prefecture = known;
                parent.clear();
            }
            continue;
        }
        if prefecture.is_empty() {
            continue;
        }
        let content = plain(element);
        let lines: Vec<_> = content.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            let Some(marker) = line
                .chars()
                .next()
                .filter(|value| "〇○●◎■".contains(*value))
            else {
                continue;
            };
            let name = line.trim_start_matches(['〇', '○', '●', '◎', '■']).trim();
            let location = lines
                .get(index + 1)
                .filter(|line| location_label.is_match(line))
                .context("Child guidance address missing")?;
            let phone = lines
                .get(index + 2)
                .filter(|line| phone_label.is_match(line))
                .context("Child guidance telephone missing")?;
            let name = if marker == '■' {
                format!("{parent} {name}")
            } else {
                parent = name.into();
                name.into()
            };
            add(
                Entry {
                    category: Category::ChildConsultation,
                    name,
                    address: address(&location_label.replace(location, "")),
                    telephone: phone_label.replace(phone, "").into_owned(),
                    prefecture: prefecture.clone(),
                    website: None,
                    record_id: String::new(),
                },
                source,
                collection,
                &provider.license,
            )?;
            identified += 1;
        }
    }
    ensure!(identified > 0, "No recognized child guidance offices");
    Ok(())
}

fn parents(
    html: &Html,
    provider: &Provider,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let mut identified = 0;
    for region in html.select(&selector(".p-prefecture")) {
        let prefecture = region
            .select(&selector(".p-prefecture__heading"))
            .next()
            .context("Parent employment prefecture heading missing")?;
        let prefecture = matching_prefecture(&plain(prefecture), collection);
        for facility in region.select(&selector(".p-facility")) {
            let name = facility
                .select(&selector(".p-facility__name"))
                .next()
                .context("Parent employment office name missing")?;
            let location = facility
                .select(&selector(".p-facility__address"))
                .next()
                .context("Parent employment office address missing")?;
            let phone = location
                .select(&selector("a[href^='tel:']"))
                .map(plain)
                .collect::<Vec<_>>()
                .join("\n");
            add(
                Entry {
                    category: provider.category,
                    name: plain(name).replace('\n', " "),
                    address: address(&plain(location)),
                    telephone: phone,
                    prefecture: prefecture.clone(),
                    website: name
                        .select(&selector("a[href]"))
                        .next()
                        .and_then(|anchor| link(anchor.value().attr("href"), &source.url)),
                    record_id: String::new(),
                },
                source,
                collection,
                &provider.license,
            )?;
            identified += 1;
        }
    }
    ensure!(identified > 0, "No recognized parent employment offices");
    Ok(())
}

fn withdrawal(
    html: &Html,
    provider: &Provider,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let mut prefecture = String::new();
    let mut identified = 0;
    for element in html.select(&selector("h2,h3,h4,h5,h6,.accordion.prefecture,table")) {
        if element.value().name() != "table" {
            let known = matching_prefecture(&plain(element), collection);
            if !known.is_empty() {
                prefecture = known;
            }
            continue;
        }
        let values = fields(element)?;
        let Some(identity) = values.get("名称/住所").or_else(|| values.get("名称／住所"))
        else {
            continue;
        };
        let Some((name, location)) = identity.text.split_once('\n') else {
            source.rows += 1;
            reject(source, "missing_identity_or_address");
            continue;
        };
        let phone = values
            .get("電話番号")
            .context("Support office telephone missing")?;
        add(
            Entry {
                category: provider.category,
                name: name.into(),
                address: address(location),
                telephone: phone.text.clone(),
                prefecture: prefecture.clone(),
                website: values
                    .get("ホームページ")
                    .and_then(|cell| link(cell.href.as_deref(), &source.url)),
                record_id: String::new(),
            },
            source,
            collection,
            &provider.license,
        )?;
        identified += 1;
    }
    ensure!(identified > 0, "No recognized social withdrawal offices");
    Ok(())
}

fn foreign_offices(
    html: &Html,
    provider: &Provider,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let mut current = None;
    let mut identified = 0;
    for element in html.select(&selector("h3,.m-grid__col1")) {
        if element.value().name() == "h3" {
            let name = plain(element);
            current = name.contains("外国人雇用サービスセンター").then_some(name);
            continue;
        }
        let Some(name) = current.as_ref() else {
            continue;
        };
        let content = plain(element);
        if !content.contains("TEL") || !content.contains('〒') {
            continue;
        }
        let start = content.find('〒').context("Office address missing")?;
        let (location, phone) = content[start..]
            .split_once("TEL")
            .context("Office telephone missing")?;
        add(
            Entry {
                category: provider.category,
                name: name.clone(),
                address: address(location),
                telephone: phone.into(),
                prefecture: String::new(),
                website: element
                    .select(&selector("a[href]"))
                    .next()
                    .and_then(|anchor| link(anchor.value().attr("href"), &source.url)),
                record_id: String::new(),
            },
            source,
            collection,
            &provider.license,
        )?;
        identified += 1;
    }
    ensure!(identified > 0, "No recognized foreign employment offices");
    Ok(())
}

fn pension_office(
    html: &Html,
    provider: &Provider,
    prefecture: &str,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let title = html
        .select(&selector("h1"))
        .map(plain)
        .find(|title| title.contains("年金事務所") || title.contains("年金相談センター"))
        .context("Pension office title missing")?;
    let mut location = None;
    let mut telephone = Vec::new();
    for table in html.select(&selector("table")) {
        if !table
            .select(&selector("th,td"))
            .any(|cell| compact(&plain(cell)) == "所在地")
        {
            continue;
        }
        if location.is_some() {
            *source
                .issues
                .entry("additional_pension_location_not_imported".into())
                .or_default() += 1;
            continue;
        }
        for row in table_rows(table)? {
            if row.len() != 2 {
                continue;
            }
            match compact(&row[0].text).as_str() {
                "所在地" => {
                    ensure!(
                        location.is_none(),
                        "Ambiguous primary pension office location"
                    );
                    location = Some(address(&row[1].text));
                }
                "電話番号" | "電話" | "電話・FAX" | "電話/FAX" => {
                    telephone.push(row[1].text.clone())
                }
                _ => {}
            }
        }
    }
    let mut diagrams = BTreeMap::new();
    for table in html
        .select(&selector("table"))
        .filter(|table| plain(*table).contains("職員にご用の方"))
    {
        for row in table_rows(table)? {
            if row.len() == 2 && compact(&row[0].text).contains("職員にご用の方") {
                telephone.push(row[1].text.clone());
            }
        }
    }
    for image in html.select(&selector("img[alt]")) {
        let alt = image.value().attr("alt").unwrap_or_default();
        if alt.contains("電話番号は") && alt.contains("年金事務所") {
            for number in phones(alt) {
                diagrams.insert(number.e164, number.original);
            }
        }
    }
    ensure!(
        diagrams.len() <= 1,
        "Ambiguous pension office telephone diagrams"
    );
    telephone.extend(diagrams.into_values());
    add(
        Entry {
            category: if title.contains("年金相談センター") {
                Category::PensionConsultation
            } else {
                Category::PensionOffice
            },
            name: title.replace('\n', " "),
            address: location.context("Pension office address missing")?,
            telephone: telephone.join("\n"),
            prefecture: prefecture.into(),
            website: Some(source.url.clone()),
            record_id: source.url.clone(),
        },
        source,
        collection,
        &provider.license,
    )
}

fn fire_brigades(
    html: &Html,
    provider: &Provider,
    prefecture: &str,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let mut municipality = String::new();
    let mut identified = 0;
    for element in html.select(&selector("h3,table")) {
        if element.value().name() == "h3" {
            municipality = plain(element);
            continue;
        }
        let mut columns = None;
        for row in table_rows(element)? {
            let column = |name: &str| row.iter().position(|cell| compact(&cell.text) == name);
            if let (Some(name), Some(department), Some(phone)) = (
                column("消防団名(PDFが開きます)"),
                column("消防団事務所管"),
                column("電話番号"),
            ) {
                columns = Some((name, department, phone));
                identified += 1;
                continue;
            }
            let Some((name, department, phone)) = columns else {
                continue;
            };
            ensure!(
                row.len() > name.max(department).max(phone),
                "Incomplete fire brigade directory row"
            );
            add(
                Entry {
                    category: provider.category,
                    name: format!("{}（{}）", row[name].text, row[department].text),
                    address: if municipality.is_empty() {
                        prefecture.into()
                    } else {
                        municipality.clone()
                    },
                    telephone: row[phone].text.clone(),
                    prefecture: prefecture.into(),
                    website: None,
                    record_id: String::new(),
                },
                source,
                collection,
                &provider.license,
            )?;
        }
    }
    ensure!(identified > 0, "No recognized fire brigade contact tables");
    Ok(())
}

fn ingest_html(
    html: &str,
    provider: &Provider,
    prefecture: &str,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let document = Html::parse_document(html);
    match provider.layout {
        Layout::Table | Layout::Tax => tables(&document, provider, prefecture, source, collection),
        Layout::Labour => labour(&document, provider, prefecture, source, collection),
        Layout::Child => child_guidance(&document, provider, source, collection),
        Layout::Parent => parents(&document, provider, source, collection),
        Layout::Withdrawal => withdrawal(&document, provider, source, collection),
        Layout::Foreign => foreign_offices(&document, provider, source, collection),
        Layout::Pension => pension_office(&document, provider, prefecture, source, collection),
        Layout::Fire => fire_brigades(&document, provider, prefecture, source, collection),
        _ => bail!("Unsupported HTML source layout"),
    }
}

fn consumer(
    bytes: &[u8],
    provider: &Provider,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let decoded = text(bytes)?;
    let mut reader = csv::Reader::from_reader(decoded.as_bytes());
    let headers = reader.headers()?;
    let column = |name: &str| -> Result<usize> {
        let indexes: Vec<_> = headers
            .iter()
            .enumerate()
            .filter(|(_, header)| *header == name)
            .map(|(index, _)| index)
            .collect();
        ensure!(
            indexes.len() == 1,
            "Missing or ambiguous consumer CSV column {name}"
        );
        Ok(indexes[0])
    };
    let name = column("消費生活センター名")?;
    let region = column("都道府県名")?;
    let code = column("都道府県コード（JIS X 0401）")?;
    let id = column("消費生活センターコード")?;
    let street = column("所在地１")?;
    let building = column("所在地２")?;
    let phone = column("相談電話番号")?;
    let website = column("消費生活センターURL")?;
    for record in reader.records() {
        let row = record?;
        let expected = row[code].parse::<u8>()?;
        if !collection.prefectures.iter().any(|prefecture| {
            prefecture.name == row[region] && prefecture.code.parse::<u8>() == Ok(expected)
        }) {
            source.rows += 1;
            reject(source, "prefecture_conflict");
            continue;
        }
        let telephone = if row[phone].trim().is_empty() {
            String::new()
        } else {
            let Ok(value) = consumer_phone(&row[phone]) else {
                source.rows += 1;
                reject(source, "invalid_numeric_phone");
                continue;
            };
            if value != row[phone] {
                *source
                    .issues
                    .entry("restored_domestic_trunk_prefix".into())
                    .or_default() += 1;
            }
            value
        };
        add(
            Entry {
                category: provider.category,
                name: row[name].into(),
                address: format!("{} {}", &row[street], &row[building]).trim().into(),
                telephone,
                prefecture: row[region].into(),
                website: Some(row[website].into()),
                record_id: row[id].into(),
            },
            source,
            collection,
            &provider.license,
        )?;
    }
    Ok(())
}

fn higher(
    bytes: &[u8],
    provider: &Provider,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let mut workbook = calamine::open_workbook_auto_from_rs(Cursor::new(bytes))?;
    let mut identified = 0;
    for sheet in workbook.sheet_names().to_owned() {
        let range = workbook.worksheet_range(&sheet)?;
        let rows: Vec<Vec<String>> = range
            .rows()
            .take(EDUCATION_HEADER_ROWS)
            .map(|row| row.iter().map(ToString::to_string).collect())
            .collect();
        let Some((header, code, phone, location)) =
            rows.iter().enumerate().find_map(|(index, row)| {
                Some((
                    index,
                    row.iter()
                        .position(|value| compact(value) == "学校コード")?,
                    row.iter().position(|value| compact(value) == "電話番号")?,
                    row.iter().position(|value| compact(value) == "所在地")?,
                ))
            })
        else {
            continue;
        };
        let row = rows
            .get(header + 1)
            .context("Institution basic information missing")?;
        let school_code = row.get(code).context("School code missing")?.trim();
        let prefix = match provider.category {
            Category::University => "F1",
            Category::JuniorCollege => "F2",
            Category::TechnicalCollege => "G1",
            _ => bail!("Unsupported education category"),
        };
        ensure!(
            school_code.len() == SCHOOL_ID_LENGTH
                && school_code.starts_with(prefix)
                && school_code.as_bytes()[1..].iter().all(u8::is_ascii_digit),
            "Unexpected school identifier {school_code}"
        );
        let region = school_code
            .get(SCHOOL_PREFECTURE_BAND)
            .context("School prefecture code missing")?;
        let street = row
            .get(location + 1..phone)
            .context("School address band missing")?
            .iter()
            .find(|value| !value.trim().is_empty())
            .context("School street address missing")?
            .trim();
        let title = rows
            .first()
            .and_then(|row| row.first())
            .context("School title missing")?
            .trim();
        let title = title
            .strip_prefix("国立 ")
            .or_else(|| title.strip_prefix("公立 "))
            .or_else(|| title.strip_prefix("私立 "))
            .unwrap_or(title);
        let title = title.split(['（', '(']).next().unwrap_or(title).trim();
        ensure!(!title.is_empty(), "Empty institution title");
        add(
            Entry {
                category: provider.category,
                name: title.into(),
                address: street.into(),
                telephone: row
                    .get(phone)
                    .context("School telephone field missing")?
                    .trim()
                    .into(),
                prefecture: region.into(),
                website: None,
                record_id: school_code.into(),
            },
            source,
            collection,
            &provider.license,
        )?;
        identified += 1;
    }
    ensure!(
        identified > 0,
        "No recognized school basic-information tables"
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    providers: Vec<Provider>,
}

fn police_seed(
    provider: &Provider,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Row {
        prefecture: String,
        name: String,
        phone: String,
    }
    let mut reader = csv::Reader::from_reader(
        include_bytes!("../../../../sources/police-consultation.csv").as_slice(),
    );
    for row in reader.deserialize::<Row>() {
        let row = row?;
        add(
            Entry {
                category: provider.category,
                name: format!("{} 相談窓口", row.name),
                address: row.prefecture.clone(),
                telephone: row.phone,
                prefecture: row.prefecture,
                website: None,
                record_id: row.name,
            },
            source,
            collection,
            &provider.license,
        )?;
    }
    ensure!(
        source.accepted == POLICE_CONSULTATION_CONTACTS
            && source.invalid == 0
            && source.missing_phone == 0,
        "Police consultation seed inventory changed"
    );
    Ok(())
}

fn transcribed_source(
    bytes: &[u8],
    provider: &Provider,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let hash = format!("{:x}", Sha256::digest(bytes));
    ensure!(
        provider.sha256.as_deref() == Some(hash.as_str()),
        "Transcribed source bytes changed for {}",
        provider.id
    );
    police_seed(provider, source, collection)
}

pub(super) fn inspect(
    bytes: &[u8],
    id: &str,
    prefecture: &str,
    source: &mut SourceReport,
    collection: &mut Collection,
) -> Result<()> {
    let registry: Registry = toml::from_str(include_str!("../../../../sources/civic.toml"))?;
    let provider = registry
        .providers
        .into_iter()
        .find(|provider| provider.id == id)
        .context("Unknown civic source profile")?;
    source.id = id.into();
    source.url = provider
        .url
        .clone()
        .unwrap_or_else(|| provider.index_url.clone());
    source.license_url = provider.license_url.clone();
    match provider.layout {
        Layout::Consumer => consumer(bytes, &provider, source, collection),
        Layout::Higher => higher(bytes, &provider, source, collection),
        Layout::Seed => transcribed_source(bytes, &provider, source, collection),
        _ => ingest_html(&text(bytes)?, &provider, prefecture, source, collection),
    }
}

fn public_link(base: &str, href: &str) -> Result<String> {
    let base = Url::parse(base)?;
    let url = base.join(href)?;
    ensure!(
        url.origin() == base.origin()
            && url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none(),
        "Directory download leaves its publisher"
    );
    Ok(url.to_string())
}

fn regional_files(
    provider: &Provider,
    html: &str,
    collection: &Collection,
) -> Result<Vec<(String, String)>> {
    let document = Html::parse_document(html);
    let mut files = BTreeMap::new();
    for anchor in document.select(&selector("a[href]")) {
        let label = compact(&plain(anchor));
        let label = if label
            .as_bytes()
            .get(..2)
            .is_some_and(|bytes| bytes.iter().all(u8::is_ascii_digit))
        {
            &label[2..]
        } else {
            &label
        };
        let known = matching_prefecture(label, collection);
        if known.is_empty() {
            continue;
        }
        let href = anchor.value().attr("href").unwrap_or_default();
        if href.starts_with('#') {
            continue;
        }
        let url = public_link(&provider.index_url, href)?;
        if let Some(previous) = files.insert(known, url.clone()) {
            ensure!(previous == url, "Ambiguous prefecture directory URL");
        }
    }
    ensure!(
        files.len() == PREFECTURE_COUNT,
        "Incomplete prefecture directory inventory for {}: {}",
        provider.id,
        files.len()
    );
    Ok(files.into_iter().collect())
}

fn files(
    provider: &Provider,
    html: &str,
    collection: &Collection,
) -> Result<Vec<(String, String)>> {
    if matches!(
        provider.layout,
        Layout::Tax | Layout::Labour | Layout::Pension
    ) {
        return regional_files(provider, html, collection);
    }
    if provider.layout == Layout::Fire {
        return Ok(collection
            .prefectures
            .iter()
            .map(|prefecture| {
                (
                    prefecture.name.clone(),
                    format!("{FIRE_DIRECTORY_BASE}/{}.html", prefecture.code),
                )
            })
            .collect());
    }
    if let Some(pattern) = &provider.download_pattern {
        let pattern = Regex::new(pattern)?;
        let document = Html::parse_document(html);
        let mut urls = BTreeSet::new();
        for anchor in document.select(&selector("a[href]")) {
            if pattern.is_match(&compact(&plain(anchor))) {
                urls.insert(public_link(
                    &provider.index_url,
                    anchor.value().attr("href").unwrap_or_default(),
                )?);
            }
        }
        ensure!(
            !urls.is_empty() && provider.downloads == Some(urls.len()),
            "Download inventory changed for {}",
            provider.id
        );
        return Ok(urls
            .into_iter()
            .enumerate()
            .map(|(index, url)| (index.to_string(), url))
            .collect());
    }
    Ok(vec![(
        "all".into(),
        provider
            .url
            .clone()
            .unwrap_or_else(|| provider.index_url.clone()),
    )])
}

fn source_report(
    provider: &Provider,
    key: &str,
    download: &Download,
    index: &Download,
    license: &Download,
) -> SourceReport {
    let mut source = report(
        format!("{}:{key}", provider.id),
        download,
        provider.data_as_of.clone(),
    );
    source.index_url = index.artifact.url.clone();
    source.index_sha256 = index.artifact.sha256.clone();
    source.license_url = license.artifact.url.clone();
    source.license_sha256 = license.artifact.sha256.clone();
    source
}

pub(super) fn import(fetcher: &Fetcher, collection: &mut Collection) -> Result<()> {
    import_selected(fetcher, collection, None)
}

pub(super) fn import_selected(
    fetcher: &Fetcher,
    collection: &mut Collection,
    selected: Option<&str>,
) -> Result<()> {
    let registry: Registry = toml::from_str(include_str!("../../../../sources/civic.toml"))?;
    let ids: BTreeSet<_> = registry
        .providers
        .iter()
        .map(|provider| &provider.id)
        .collect();
    ensure!(
        !ids.is_empty() && ids.len() == registry.providers.len(),
        "Empty or duplicate civic source inventory"
    );
    ensure!(
        selected.is_none_or(|id| ids.iter().any(|known| known.as_str() == id)),
        "Unknown civic catalog"
    );
    for provider in registry.providers {
        if selected.is_some_and(|id| id != provider.id) {
            continue;
        }
        let index = fetcher.get(&provider.index_url, true)?;
        let license = fetcher.get(&provider.license_url, false)?;
        ensure!(
            !provider.reuse_marker.is_empty()
                && text(&license.bytes)?.contains(&provider.reuse_marker),
            "Directory reuse statement changed for {}",
            provider.id
        );
        let inventory = files(&provider, &text(&index.bytes)?, collection)?;
        for (key, url) in inventory {
            eprintln!("Fetching civic {}:{key}", provider.id);
            let download = if url == provider.index_url {
                Download {
                    bytes: index.bytes.clone(),
                    artifact: index.artifact.clone(),
                }
            } else {
                fetcher.get(&url, false)?
            };
            if provider.layout == Layout::Pension {
                let document = Html::parse_document(&text(&download.bytes)?);
                let mut offices = BTreeSet::new();
                for anchor in document.select(&selector("table a[href]")) {
                    let name = plain(anchor);
                    if name.contains("年金事務所") || name.contains("年金相談センター")
                    {
                        offices.insert(public_link(
                            &url,
                            anchor.value().attr("href").unwrap_or_default(),
                        )?);
                    }
                }
                ensure!(
                    !offices.is_empty() && offices.len() <= MAX_REGIONAL_PENSION_OFFICES,
                    "Pension office inventory changed for {key}"
                );
                for office in offices {
                    let detail = fetcher.get(&office, false)?;
                    let mut source = source_report(
                        &provider,
                        &format!(
                            "{key}:{}",
                            Url::parse(&office)?
                                .path()
                                .rsplit('/')
                                .next()
                                .unwrap_or_default()
                        ),
                        &detail,
                        &download,
                        &license,
                    );
                    source.artifacts.push(index.artifact.clone());
                    let result = pension_office(
                        &Html::parse_document(&text(&detail.bytes)?),
                        &provider,
                        &key,
                        &mut source,
                        collection,
                    );
                    collection.reports.push(source);
                    result.with_context(|| format!("Import pension office {office}"))?;
                }
                continue;
            }
            let mut source = source_report(&provider, &key, &download, &index, &license);
            let result = match provider.layout {
                Layout::Consumer => consumer(&download.bytes, &provider, &mut source, collection),
                Layout::Higher => higher(&download.bytes, &provider, &mut source, collection),
                Layout::Seed => {
                    transcribed_source(&download.bytes, &provider, &mut source, collection)
                }
                _ => ingest_html(
                    &text(&download.bytes)?,
                    &provider,
                    &matching_prefecture(&key, collection),
                    &mut source,
                    collection,
                ),
            };
            eprintln!(
                "{}: {} accepted, {} missing, {} invalid, {} duplicate",
                source.id, source.accepted, source.missing_phone, source.invalid, source.duplicate
            );
            collection.reports.push(source);
            result.with_context(|| format!("Import civic source {}:{key}", provider.id))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_cleanup_preserves_building_names_that_contain_era_or_telephone_words() {
        assert_eq!(
            address("〒100-0001 東京都千代田区1-2 令和電話局ビル"),
            "東京都千代田区1-2 令和電話局ビル"
        );
        assert_eq!(
            address("〒100-0001 東京都千代田区1-2\n電　話：03-1234-5678"),
            "東京都千代田区1-2"
        );
    }

    fn school_workbook(code: &str) -> Vec<u8> {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let sheet = format!(
            "<worksheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><sheetData><row r='1'><c r='A1' t='inlineStr'><is><t>私立 Sample institution (English)</t></is></c></row><row r='2'><c r='A2' t='inlineStr'><is><t>学校コード</t></is></c><c r='B2' t='inlineStr'><is><t>所在地</t></is></c><c r='D2' t='inlineStr'><is><t>電話番号</t></is></c><c r='E2' t='inlineStr'><is><t>学長</t></is></c></row><row r='3'><c r='A3' t='inlineStr'><is><t>{code}</t></is></c><c r='B3' t='inlineStr'><is><t>100-0001</t></is></c><c r='C3' t='inlineStr'><is><t>東京都千代田区1-2</t></is></c><c r='D3' t='inlineStr'><is><t>03-1234-5678</t></is></c><c r='E3' t='inlineStr'><is><t>Excluded person 03-9999-9999</t></is></c></row></sheetData></worksheet>"
        );
        for (name, contents) in [
            (
                "_rels/.rels",
                "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='xl/workbook.xml'/></Relationships>",
            ),
            (
                "[Content_Types].xml",
                "<Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Override PartName='/xl/workbook.xml' ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'/><Override PartName='/xl/worksheets/sheet1.xml' ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'/></Types>",
            ),
            (
                "xl/workbook.xml",
                "<workbook xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><sheets><sheet name='Institution' sheetId='1' r:id='rId1'/></sheets></workbook>",
            ),
            (
                "xl/_rels/workbook.xml.rels",
                "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet1.xml'/></Relationships>",
            ),
            ("xl/worksheets/sheet1.xml", sheet.as_str()),
        ] {
            archive
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(contents.as_bytes()).unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    #[test]
    fn higher_education_uses_the_declared_school_family_and_excludes_personnel_fields() {
        for (category, code) in [
            (Category::University, "F113310000001"),
            (Category::JuniorCollege, "F213310000001"),
            (Category::TechnicalCollege, "G113310000001"),
        ] {
            let mut collection = collection();
            let mut source = SourceReport::default();
            let provider = provider(Layout::Higher, category);
            higher(
                &school_workbook(code),
                &provider,
                &mut source,
                &mut collection,
            )
            .unwrap();
            assert_eq!(source.accepted, 1);
            let contact = collection.contacts.values().next().unwrap();
            assert_eq!(contact.category, category);
            assert_eq!(contact.name, "Sample institution");
            assert_eq!(contact.source_record_id, code);
            assert_eq!(contact.address, "東京都千代田区1-2");
            assert_eq!(contact.phones.len(), 1);
            assert_eq!(contact.phones[0].e164, "+81312345678");
            assert!(
                !serde_json::to_string(contact)
                    .unwrap()
                    .contains("Excluded person")
            );
            assert!(
                higher(
                    &school_workbook("H113310000001"),
                    &provider,
                    &mut source,
                    &mut collection
                )
                .is_err()
            );
        }
    }

    #[test]
    fn pension_centers_keep_staff_contact_numbers_and_exclude_national_helplines() {
        let html = Html::parse_document(
            "<h1>街角の年金相談センター Sample</h1><table><tr><th>所在地</th><td>東京都千代田区1-2</td></tr><tr><th>電話番号</th><td>お問い合わせ先をご覧ください</td></tr></table><table><tr><th>お問い合わせ内容</th><th>電話番号</th></tr><tr><td>年金の受け取り</td><td>0570-05-1165</td></tr><tr><td>職員にご用の方<br>お電話による年金相談は受け付けておりません。</td><td>電話番号<br>03-1234-5678</td></tr><tr><td>FAX番号</td><td>03-9999-9999</td></tr></table>",
        );
        let mut collection = collection();
        let mut source = SourceReport::default();
        pension_office(
            &html,
            &provider(Layout::Pension, Category::PensionOffice),
            "東京都",
            &mut source,
            &mut collection,
        )
        .unwrap();
        assert_eq!(source.accepted, 1);
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.category, Category::PensionConsultation);
        assert_eq!(contact.phones.len(), 1);
        assert_eq!(contact.phones[0].e164, "+81312345678");
    }

    #[test]
    fn pension_primary_location_never_collects_a_separate_room_phone() {
        let html = Html::parse_document(
            "<h1>Sample 年金事務所</h1><table><tr><th>所在地</th><td>東京都千代田区1-2</td></tr><tr><th>電話番号</th><td>03-1234-5678</td></tr></table><h2>Separate consultation room</h2><table><tr><th>所在地</th><td>東京都千代田区3-4</td></tr><tr><th>電話番号</th><td>03-9999-9999</td></tr></table>",
        );
        let mut collection = collection();
        let mut source = SourceReport::default();
        pension_office(
            &html,
            &provider(Layout::Pension, Category::PensionOffice),
            "東京都",
            &mut source,
            &mut collection,
        )
        .unwrap();
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.address, "東京都千代田区1-2");
        assert_eq!(contact.phones.len(), 1);
        assert_eq!(contact.phones[0].e164, "+81312345678");
        assert_eq!(source.issues["additional_pension_location_not_imported"], 1);
        let ambiguous = Html::parse_document(
            "<h1>Sample 年金事務所</h1><table><tr><th>所在地</th><td>東京都千代田区1-2</td></tr></table><img alt='First年金事務所の電話番号は03-1234-5678です。'><img alt='Second年金事務所の電話番号は03-9999-9999です。'>",
        );
        assert!(
            pension_office(
                &ambiguous,
                &provider(Layout::Pension, Category::PensionOffice),
                "東京都",
                &mut source,
                &mut collection
            )
            .is_err()
        );
    }

    #[test]
    fn transcribed_police_numbers_require_the_exact_published_pdf_and_cover_all_prefectures() {
        let mut provider = provider(Layout::Seed, Category::PoliceConsultation);
        provider.sha256 = Some(format!("{:x}", Sha256::digest(b"published PDF")));
        let mut collection = collection();
        let mut reader = csv::Reader::from_reader(
            include_bytes!("../../../../sources/prefectures.csv").as_slice(),
        );
        collection.prefectures = reader
            .deserialize::<PrefectureSeed>()
            .map(|row| {
                let row = row.unwrap();
                Prefecture {
                    code: row.code,
                    name: row.name.trim_end_matches('庁').into(),
                }
            })
            .collect();
        let mut source = SourceReport::default();
        assert!(
            transcribed_source(b"changed PDF", &provider, &mut source, &mut collection).is_err()
        );
        assert!(collection.contacts.is_empty());
        transcribed_source(b"published PDF", &provider, &mut source, &mut collection).unwrap();
        assert_eq!(
            (
                source.rows,
                source.accepted,
                source.invalid,
                source.missing_phone
            ),
            (51, 51, 0, 0)
        );
        assert_eq!(
            collection
                .contacts
                .values()
                .map(|contact| &contact.prefecture_code)
                .collect::<BTreeSet<_>>()
                .len(),
            47
        );
        assert!(
            collection
                .contacts
                .values()
                .all(|contact| contact.address == contact.prefecture && contact.phones.len() == 1)
        );
    }

    #[test]
    fn labour_sections_preserve_named_departments_and_separate_employment_from_inspection() {
        let html = "<h2>東京都労働局</h2><table><tr><th>地方機関</th><th>所在地</th><th>電話番号</th></tr><tr><td>東京都労働局</td><td>千代田区1-2</td><td>03-1234-5678</td></tr><tr><td>総務部</td><td>同上</td><td>03-2345-6789</td></tr></table><h2>労働基準監督署</h2><table><tr><th>名称</th><th>所在地</th><th>電話</th></tr><tr><td>中央</td><td>千代田区3-4</td><td>03-3456-7890<br>FAX 03-9999-9999</td></tr></table><h2>公共職業安定所</h2><table><tr><th>機関名称</th><th>所在地</th><th>電話</th></tr><tr><td>飯田橋</td><td>千代田区5-6</td><td>03-4567-8901</td></tr></table>";
        let mut collection = collection();
        let mut source = SourceReport::default();
        ingest_html(
            html,
            &provider(Layout::Labour, Category::LabourBureau),
            "東京都",
            &mut source,
            &mut collection,
        )
        .unwrap();
        assert_eq!(source.accepted, 4);
        let department = collection
            .contacts
            .values()
            .find(|contact| contact.name.ends_with("総務部"))
            .unwrap();
        assert_eq!(department.address, "東京都千代田区1-2");
        for (category, number) in [
            (Category::LabourInspection, "+81334567890"),
            (Category::EmploymentOffice, "+81345678901"),
        ] {
            let contact = collection
                .contacts
                .values()
                .find(|contact| contact.category == category)
                .unwrap();
            assert_eq!(contact.phones.len(), 1);
            assert_eq!(contact.phones[0].e164, number);
        }
    }

    #[test]
    fn parent_foreign_and_withdrawal_layouts_keep_their_own_contact_blocks() {
        for (layout, category, html) in [
            (
                Layout::Parent,
                Category::ParentEmploymentSupport,
                "<div class='p-prefecture'><h2 class='p-prefecture__heading'>東京都</h2><div class='p-facility'><h3 class='p-facility__name'>Parent desk</h3><div class='p-facility__address'>〒100-0001 東京都千代田区1-2<br>電話 <a href='tel:0312345678'>03-1234-5678</a></div></div></div><footer>03-9999-9999</footer>",
            ),
            (
                Layout::Foreign,
                Category::ForeignEmploymentSupport,
                "<h3>東京外国人雇用サービスセンター</h3><div class='m-grid__col1'>〒100-0001 東京都千代田区1-2<br>TEL 03-1234-5678<br>FAX 03-9999-9999</div><footer>03-9999-9999</footer>",
            ),
            (
                Layout::Withdrawal,
                Category::SocialWithdrawalSupport,
                "<div class='accordion prefecture'>東京都</div><table><tr><th>名称／住所</th><td><p>Support desk</p><p>〒100-0001 東京都千代田区1-2</p></td></tr><tr><th>電話番号</th><td>03-1234-5678</td></tr><tr><th>ホームページ</th><td><a href='https://desk.example/'>Website</a></td></tr></table>",
            ),
        ] {
            let mut collection = collection();
            let mut source = SourceReport::default();
            ingest_html(
                html,
                &provider(layout, category),
                "",
                &mut source,
                &mut collection,
            )
            .unwrap();
            assert_eq!(source.accepted, 1, "{layout:?}");
            let contact = collection.contacts.values().next().unwrap();
            assert_eq!(contact.category, category);
            assert_eq!(contact.phones.len(), 1);
            assert_eq!(contact.phones[0].e164, "+81312345678");
            assert_eq!(contact.address, "東京都千代田区1-2", "{layout:?}");
        }
    }

    #[test]
    fn consumer_csv_restoration_keeps_source_specific_identity_and_rejects_conflicting_regions() {
        let csv = "消費生活センター名,都道府県名,都道府県コード（JIS X 0401）,消費生活センターコード,所在地１,所在地２,相談電話番号,消費生活センターURL\nSample,東京都,13,13001,千代田区1-2,Annex,312345678,https://desk.example/\nWrong region,東京都,1,13002,千代田区1-2,,312345678,\nMissing phone,東京都,13,13003,千代田区1-2,,,\n";
        let mut collection = collection();
        let mut source = SourceReport::default();
        consumer(
            csv.as_bytes(),
            &provider(Layout::Consumer, Category::ConsumerAffairs),
            &mut source,
            &mut collection,
        )
        .unwrap();
        assert_eq!(
            (
                source.rows,
                source.accepted,
                source.invalid,
                source.missing_phone
            ),
            (3, 1, 1, 1)
        );
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.phones[0].original, "0312345678");
        assert_eq!(contact.source_record_id, "13001");
        assert_eq!(source.issues["restored_domestic_trunk_prefix"], 1);
    }

    #[test]
    fn regional_download_discovery_requires_exact_inventory_and_same_publisher_origin() {
        let mut collection = collection();
        let mut reader = csv::Reader::from_reader(
            include_bytes!("../../../../sources/prefectures.csv").as_slice(),
        );
        collection.prefectures = reader
            .deserialize::<PrefectureSeed>()
            .map(|row| {
                let row = row.unwrap();
                Prefecture {
                    code: row.code,
                    name: row.name.trim_end_matches('庁').into(),
                }
            })
            .collect();
        let provider = provider(Layout::Labour, Category::LabourBureau);
        let html = collection
            .prefectures
            .iter()
            .map(|prefecture| {
                format!(
                    "<a href='/{}.html'>{}</a>",
                    prefecture.code, prefecture.name
                )
            })
            .collect::<String>();
        assert_eq!(
            regional_files(&provider, &html, &collection).unwrap().len(),
            47
        );
        for invalid in [
            html.replace("東京都", "北海道・東北地方"),
            html.replace("/13.html", "https://unrelated.example/13.html"),
            format!("{html}<a href='/other.html'>東京都</a>"),
        ] {
            assert!(regional_files(&provider, &invalid, &collection).is_err());
        }
    }

    fn collection() -> Collection {
        Collection {
            contacts: BTreeMap::new(),
            prefectures: vec![
                Prefecture {
                    code: "13".into(),
                    name: "東京都".into(),
                },
                Prefecture {
                    code: "01".into(),
                    name: "北海道".into(),
                },
            ],
            municipalities: Vec::new(),
            reports: Vec::new(),
        }
    }

    fn provider(layout: Layout, category: Category) -> Provider {
        Provider {
            id: "test".into(),
            layout,
            category,
            index_url: "https://example.com/list".into(),
            license_url: "https://example.com/terms".into(),
            license: "test".into(),
            reuse_marker: "Reuse".into(),
            data_as_of: "2026-10-29".into(),
            download_pattern: None,
            downloads: None,
            name_column: None,
            url: None,
            sha256: None,
        }
    }

    #[test]
    fn pension_office_numbers_come_from_the_office_field_or_its_accessible_diagram() {
        let html = Html::parse_document(
            "<h1>Sample 年金事務所</h1><table><tr><th>所在地</th><td>〒100-0001 東京都千代田区1-2</td></tr><tr><th>電話・FAX</th><td>お問い合わせ先をご覧ください</td></tr></table><table><tr><td>ねんきんダイヤル</td><td>0570-05-1165</td></tr><tr><td>FAX番号</td><td>03-9999-9999</td></tr></table><img alt='Sample年金事務所の電話番号は03-1234-5678です。'><table><tr><td rowspan='2'>受付窓口</td></tr></table>",
        );
        let mut collection = collection();
        let mut source = SourceReport::default();
        pension_office(
            &html,
            &provider(Layout::Pension, Category::PensionOffice),
            "東京都",
            &mut source,
            &mut collection,
        )
        .unwrap();
        assert_eq!(source.accepted, 1);
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.phones.len(), 1);
        assert_eq!(contact.phones[0].e164, "+81312345678");
    }

    #[test]
    fn volunteer_fire_contacts_keep_published_municipal_scope_without_inventing_street_addresses() {
        let html = Html::parse_document(
            "<h3>千代田区</h3><table><tr><th>消防団名(PDFが開きます)</th><th>消防団事務所管</th><th>電話番号</th><th>メールアドレス</th></tr><tr><td>Sample消防団</td><td>防災課</td><td>03-1234-5678</td><td>excluded@example.com</td></tr></table>",
        );
        let mut collection = collection();
        let mut source = SourceReport::default();
        fire_brigades(
            &html,
            &provider(Layout::Fire, Category::FireBrigadeOffice),
            "東京都",
            &mut source,
            &mut collection,
        )
        .unwrap();
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.address, "東京都千代田区");
        assert_eq!(contact.phones.len(), 1);
        assert!(contact.name.contains("防災課"));
        assert!(
            !serde_json::to_string(contact)
                .unwrap()
                .contains("excluded@example.com")
        );
    }

    #[test]
    fn employment_tables_carry_regions_and_keep_only_the_office_phone_column() {
        let html = "<h3>北海道・東北地方</h3><table><tr><th>都道府県</th><th colspan='2'>名称</th><th>所在地</th><th>電話番号</th><th>FAX</th></tr><tr><td rowspan='2'>東京都</td><td>○</td><td><a href='https://office.example/'>First desk</a></td><td>〒100-0001 千代田区1-2</td><td>03-1234-5678</td><td>03-9999-9999</td></tr><tr><td></td><td>Second desk</td><td>千代田区3-4</td><td>03-2345-6789</td><td>03-8888-8888</td></tr></table>";
        let mut source = SourceReport {
            url: "https://example.com/list".into(),
            ..Default::default()
        };
        let mut collection = collection();
        ingest_html(
            html,
            &provider(Layout::Table, Category::GraduateEmploymentSupport),
            "",
            &mut source,
            &mut collection,
        )
        .unwrap();
        assert_eq!(source.accepted, 2);
        assert!(
            collection
                .contacts
                .values()
                .all(|contact| contact.phones.len() == 1 && contact.prefecture_code == "13")
        );
        assert!(
            collection
                .contacts
                .values()
                .any(|contact| contact.official_url.as_deref() == Some("https://office.example/"))
        );
        assert!(
            ingest_html(
                "<table><tr><th>Telephone unknown</th></tr></table>",
                &provider(Layout::Table, Category::GraduateEmploymentSupport),
                "",
                &mut source,
                &mut collection
            )
            .is_err()
        );
    }

    #[test]
    fn tax_offices_keep_the_physical_address_before_postal_processing_instructions() {
        let html = "<table><tr><th>税務署名</th><th>所在地</th><th>電話番号</th><th>署番号</th></tr><tr><td>Test</td><td>〒100-0001 千代田区1-2<br>令和8年7月10日以降、郵送する場合<br>〒999-9999 Processing center</td><td>03-1234-5678</td><td>01101</td></tr></table>";
        let mut collection = collection();
        ingest_html(
            html,
            &provider(Layout::Table, Category::TaxOffice),
            "東京都",
            &mut SourceReport::default(),
            &mut collection,
        )
        .unwrap();
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.name, "Test税務署");
        assert_eq!(contact.address, "東京都千代田区1-2");
    }

    #[test]
    fn child_guidance_branch_paragraphs_never_attach_a_branch_phone_to_the_parent() {
        let html = "<h2>北海道</h2><p>〇Parent center<br>住　所：〒060-0001 札幌市1-2<br>電話番号：011-123-4567<br>■Branch office<br>住　所：〒070-0001 旭川市3-4<br>電話番号：0166-12-3456</p><footer><p>電話番号：03-9999-9999</p></footer>";
        let mut collection = collection();
        let mut source = SourceReport::default();
        ingest_html(
            html,
            &provider(Layout::Child, Category::ChildConsultation),
            "",
            &mut source,
            &mut collection,
        )
        .unwrap();
        assert_eq!(source.accepted, 2);
        let parent = collection
            .contacts
            .values()
            .find(|contact| contact.name == "Parent center")
            .unwrap();
        let branch = collection
            .contacts
            .values()
            .find(|contact| contact.name == "Parent center Branch office")
            .unwrap();
        assert_eq!(parent.phones[0].e164, "+81111234567");
        assert_eq!(branch.phones[0].e164, "+81166123456");
        assert!(
            collection
                .contacts
                .values()
                .all(|contact| contact.phones.len() == 1)
        );
    }

    #[test]
    fn merged_table_cells_preserve_prefecture_and_service_column_alignment() {
        let html = Html::parse_fragment(
            "<table><tr><th>都道府県</th><th colspan='2'>名称</th><th>電話番号</th></tr><tr><td rowspan='2'>東京都</td><td>○</td><td><a href='/first'>First desk</a></td><td>03-1234-5678</td></tr><tr><td></td><td>Second desk</td><td>03-2345-6789</td></tr></table>",
        );
        let selector = Selector::parse("table").unwrap();
        let rows = table_rows(html.select(&selector).next().unwrap()).unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|row| row.len() == 4));
        assert_eq!(rows[0][1].text, "名称");
        assert_eq!(rows[0][2].text, "名称");
        assert_eq!(rows[2][0].text, "東京都");
        assert_eq!(rows[1][2].href.as_deref(), Some("/first"));
        assert_eq!(rows[2][2].text, "Second desk");
    }

    #[test]
    fn consumer_csv_restores_only_its_numeric_domestic_trunk_prefix() {
        for (raw, expected) in [
            ("5075050999", "05075050999"),
            ("117282121", "0117282121"),
            ("03-1234-5678", "03-1234-5678"),
            ("0120123456", "0120123456"),
        ] {
            assert_eq!(consumer_phone(raw).unwrap(), expected);
        }
        for raw in [
            "1234",
            "1.17282121e8",
            "0000000000",
            "not a phone",
            "123456789012",
        ] {
            assert!(consumer_phone(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn excessive_or_overlapping_table_spans_fail_instead_of_misaligning_contacts() {
        let selector = Selector::parse("table").unwrap();
        for html in [
            "<table><tr><td rowspan='999999'>A</td></tr></table>",
            "<table><tr><td colspan='999999'>A</td></tr></table>",
            "<table><tr><td>A</td><td rowspan='2'>B</td></tr><tr><td colspan='2'>C</td></tr></table>",
        ] {
            let document = Html::parse_fragment(html);
            assert!(table_rows(document.select(&selector).next().unwrap()).is_err());
        }
    }
}
