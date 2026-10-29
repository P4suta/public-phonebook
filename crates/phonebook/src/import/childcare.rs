use super::*;
use phonebook_core::{ChildcareFacility, ChildcareKind, FacilityStatus, admit_childcare};

const INDEX: &str = "https://www.wam.go.jp/kokodesearch/ANN010100E00.do";
const PAGE: &str = "https://www.wam.go.jp/kokodesearch/ANN010104E00.do";
const ZIP: &str = "https://www.wam.go.jp/kokodesearch/ANN010104E06.do";
const TERMS: &str = "https://www.wam.go.jp/content/wamnet/pcpub/jidou/kdmsyspub/public/kd003.html";
const MAX_CHILDCARE_MEMBER_BYTES: usize = 128 * 1024 * 1024;
const MAX_CHILDCARE_EXPANDED_BYTES: usize = 512 * 1024 * 1024;
const RELEASE_DATE_DIGITS: usize = 8;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    release: String,
    data_as_of: String,
    members: usize,
}

fn category(
    kind: &str,
    unlicensed: bool,
    operator: &str,
    status: FacilityStatus,
) -> Result<Option<Category>> {
    let kind = if kind.contains("居宅訪問")
        || kind == "家庭的保育事業者"
        || (unlicensed && matches!(operator.trim(), "個人" | ""))
    {
        ChildcareKind::Individual
    } else {
        ChildcareKind::Facility(if unlicensed {
            ChildcareFacility::Unlicensed
        } else {
            match kind {
                "保育所" => ChildcareFacility::Nursery,
                "施設型給付を受ける幼稚園" | "施設型給付を受けない幼稚園" => {
                    ChildcareFacility::Kindergarten
                }
                "認定こども園－幼保連携型"
                | "認定こども園－幼稚園型"
                | "認定こども園－保育所型"
                | "認定こども園－地方裁量型" => ChildcareFacility::CertifiedChildCenter,
                "小規模保育事業者－A型" | "小規模保育事業者－B型" | "小規模保育事業者－C型" => {
                    ChildcareFacility::SmallScale
                }
                "事業所内保育事業者－小規模A型基準"
                | "事業所内保育事業者－小規模B型基準"
                | "事業所内保育事業者－定員20人以上" => ChildcareFacility::Workplace,
                _ => bail!("Unknown childcare facility type {kind}"),
            }
        })
    };
    Ok(
        admit_childcare(kind, status).map(|facility| match facility {
            ChildcareFacility::Nursery => Category::Nursery,
            ChildcareFacility::Kindergarten => Category::Kindergarten,
            ChildcareFacility::CertifiedChildCenter => Category::CertifiedChildCenter,
            ChildcareFacility::SmallScale => Category::SmallScaleChildcare,
            ChildcareFacility::Workplace => Category::WorkplaceChildcare,
            ChildcareFacility::Unlicensed => Category::UnlicensedChildcare,
        }),
    )
}

fn ingest_csv(bytes: &[u8], source: &mut SourceReport, collection: &mut Collection) -> Result<()> {
    let decoded = text(bytes)?;
    let mut reader = csv::Reader::from_reader(decoded.as_bytes());
    let headers = reader.headers()?;
    let column = |name: &str| -> Result<usize> {
        let matches: Vec<_> = headers
            .iter()
            .enumerate()
            .filter(|(_, value)| *value == name)
            .map(|(index, _)| index)
            .collect();
        ensure!(
            matches.len() == 1,
            "Missing or ambiguous childcare column {name}"
        );
        Ok(matches[0])
    };
    let unlicensed = headers.iter().any(|value| value == "施設・事業所名");
    let name = column(if unlicensed {
        "施設・事業所名"
    } else {
        "施設の名称"
    })?;
    let id = column("事業所番号")?;
    let kind = column("施設類型")?;
    let status = column("営業状況")?;
    let phone = column(if unlicensed {
        "電話番号"
    } else {
        "施設の連絡先 電話番号"
    })?;
    let operator = if unlicensed {
        Some(column("設置者（法人格）")?)
    } else {
        None
    };
    let [
        prefecture_column,
        municipality_column,
        street_column,
        building_column,
    ] = [
        column("施設の所在地 都道府県")?,
        column("施設の所在地 市区町村")?,
        column("施設の所在地 町名・番地")?,
        column("施設の所在地 建物名・部屋番号等")?,
    ];
    for record in reader.records() {
        let row = record?;
        let status = match row[status].trim() {
            "通常営業" => FacilityStatus::Operating,
            "廃止済" | "休止中" | "停止中" => FacilityStatus::Inactive,
            value => bail!("Unknown childcare operating status {value}"),
        };
        let Some(category) = category(
            row[kind].trim(),
            unlicensed,
            operator.map(|index| row[index].trim()).unwrap_or_default(),
            status,
        )?
        else {
            source.rows += 1;
            civic::reject(
                source,
                if status == FacilityStatus::Inactive {
                    "closed_or_suspended"
                } else {
                    "excluded_individual_childcare"
                },
            );
            continue;
        };
        let mut address = [prefecture_column, municipality_column, street_column]
            .iter()
            .map(|index| row[*index].trim())
            .collect::<String>();
        let building = row[building_column].trim();
        if !building.is_empty() {
            address.push(' ');
            address.push_str(building);
        }
        civic::add(
            civic::Entry {
                category,
                name: row[name].trim().into(),
                address,
                telephone: row[phone].trim().into(),
                prefecture: row[prefecture_column].trim().into(),
                website: None,
                record_id: row[id].trim().into(),
            },
            source,
            collection,
            "PDL-1.0",
        )?;
    }
    Ok(())
}

fn form_fields(html: &str, expected: &str) -> Result<Vec<(String, String)>> {
    let document = Html::parse_document(html);
    let mut fields = Vec::new();
    for input in document
        .select(&Selector::parse("form input[type=hidden][name]").expect("constant selector"))
    {
        let name = input.value().attr("name").unwrap_or_default();
        if [
            "_FRAMEID",
            "_TARGETID",
            "_LUID",
            "_TOKEN",
            "_FORMID",
            "_SUBINDEX",
        ]
        .contains(&name)
        {
            ensure!(
                !fields.iter().any(|(key, _)| key == name),
                "Duplicate download form field"
            );
            fields.push((
                name.to_owned(),
                input.value().attr("value").unwrap_or_default().to_owned(),
            ));
        }
    }
    ensure!(
        fields
            .iter()
            .any(|(name, value)| name == "_FORMID" && value == expected)
            && fields
                .iter()
                .any(|(name, value)| name == "_TOKEN" && !value.is_empty()),
        "Unexpected childcare download form"
    );
    Ok(fields)
}

fn download(fetcher: &Fetcher) -> Result<Download> {
    let key = format!("{:x}", Sha256::digest(ZIP.as_bytes()));
    if !fetcher.refresh
        && fetcher.cache.join(format!("{key}.json")).is_file()
        && fetcher.cache.join(format!("{key}.bin")).is_file()
    {
        return fetcher.get(ZIP, false);
    }
    let mut cookies = BTreeMap::new();
    let mut fields = Vec::new();
    let mut output = None;
    for (url, form) in [
        (INDEX, Some("ANN010100")),
        (PAGE, Some("ANN010104")),
        (ZIP, None),
    ] {
        let cookie = cookies
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        let mut request = if url == INDEX {
            fetcher.client.get(url)
        } else {
            fetcher.client.post(url).form(&fields)
        };
        if !cookie.is_empty() {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        let response = request.send()?.error_for_status()?;
        for header in response.headers().get_all(reqwest::header::SET_COOKIE) {
            if let Some((key, value)) = header
                .to_str()?
                .split(';')
                .next()
                .and_then(|value| value.split_once('='))
            {
                cookies.insert(key.to_owned(), value.to_owned());
            }
        }
        let mut bytes = Vec::new();
        response
            .take(u64::try_from(MAX_CHILDCARE_MEMBER_BYTES)? + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= MAX_CHILDCARE_MEMBER_BYTES,
            "Childcare response exceeds bound"
        );
        if let Some(expected) = form {
            fields = form_fields(&text(&bytes)?, expected)?;
        } else {
            ensure!(
                bytes.starts_with(b"PK\x03\x04"),
                "Childcare download is not a ZIP archive"
            );
        }
        output = Some(fetcher.save(url, bytes)?);
    }
    output.context("No childcare download")
}

pub(super) fn import(fetcher: &Fetcher, collection: &mut Collection) -> Result<()> {
    let registry: Registry = toml::from_str(include_str!("../../../../sources/childcare.toml"))?;
    ensure!(
        registry.release.len() == RELEASE_DATE_DIGITS
            && registry.release.bytes().all(|byte| byte.is_ascii_digit())
            && registry.members > 0,
        "Invalid childcare release inventory"
    );
    let license = fetcher.get(TERMS, false)?;
    ensure!(
        text(&license.bytes)?.contains("PDL1.0"),
        "Childcare reuse terms changed"
    );
    let download = download(fetcher)?;
    let index = fetcher.get(INDEX, false)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(&download.bytes))?;
    ensure!(
        archive.len() == registry.members,
        "Childcare archive inventory changed"
    );
    let pattern = Regex::new(&format!(
        r"(?:^|/)公表施設情報_認可(?:外)?_[^/]+_({})\.csv$",
        registry.release
    ))?;
    let mut files = BTreeMap::new();
    for number in 0..archive.len() {
        let file = archive.by_index(number)?;
        let name = text(file.name_raw())?;
        ensure!(
            pattern.is_match(&name),
            "Unknown childcare archive member {name}"
        );
        ensure!(
            file.size() <= u64::try_from(MAX_CHILDCARE_MEMBER_BYTES)?,
            "Childcare CSV exceeds member bound"
        );
        ensure!(
            files.insert(name, number).is_none(),
            "Duplicate childcare archive member"
        );
    }
    let mut source = report(
        format!("childcare:{}", registry.release),
        &download,
        registry.data_as_of,
    );
    source.index_url = index.artifact.url;
    source.index_sha256 = index.artifact.sha256;
    source.license_url = license.artifact.url;
    source.license_sha256 = license.artifact.sha256;
    let mut expanded = 0usize;
    let result = (|| -> Result<()> {
        for (name, number) in files {
            let file = archive.by_index(number)?;
            let mut bytes = Vec::new();
            file.take(u64::try_from(MAX_CHILDCARE_MEMBER_BYTES)? + 1)
                .read_to_end(&mut bytes)?;
            expanded += bytes.len();
            ensure!(
                bytes.len() <= MAX_CHILDCARE_MEMBER_BYTES
                    && expanded <= MAX_CHILDCARE_EXPANDED_BYTES,
                "Childcare ZIP expansion exceeds bound"
            );
            ingest_csv(&bytes, &mut source, collection)
                .with_context(|| format!("Read childcare member {name}"))?;
        }
        ensure!(source.accepted > 0, "No callable childcare contacts");
        Ok(())
    })();
    eprintln!(
        "{}: {} accepted, {} missing, {} invalid, {} duplicate",
        source.id, source.accepted, source.missing_phone, source.invalid, source.duplicate
    );
    collection.reports.push(source);
    result
}

pub(super) fn inspect(
    bytes: &[u8],
    collection: &mut Collection,
    source: &mut SourceReport,
) -> Result<()> {
    if !bytes.starts_with(b"PK\x03\x04") {
        return ingest_csv(bytes, source, collection);
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    for number in 0..archive.len() {
        let file = archive.by_index(number)?;
        let mut bytes = Vec::new();
        file.take(u64::try_from(MAX_CHILDCARE_MEMBER_BYTES)? + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= MAX_CHILDCARE_MEMBER_BYTES,
            "Childcare member exceeds bound"
        );
        ingest_csv(&bytes, source, collection)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_forms_require_a_unique_token_and_the_expected_form_identity() {
        let form = "<form><input type='hidden' name='_TOKEN' value='public-session-token'><input type='hidden' name='_FORMID' value='ANN010104'><input type='hidden' name='unexpected' value='excluded'></form>";
        let fields = form_fields(form, "ANN010104").unwrap();
        assert_eq!(fields.len(), 2);
        assert!(form_fields(form, "ANN010100").is_err());
        assert!(form_fields(&form.replace("public-session-token", ""), "ANN010104").is_err());
        assert!(
            form_fields(
                &form.replace(
                    "</form>",
                    "<input type='hidden' name='_TOKEN' value='other'></form>"
                ),
                "ANN010104"
            )
            .is_err()
        );
    }

    const FACILITIES: &str = "施設類型,施設の名称,事業所番号,施設の所在地 都道府県,施設の所在地 市区町村,施設の所在地 町名・番地,施設の所在地 建物名・部屋番号等,施設の連絡先 電話番号,営業状況,法人等の連絡先_電話番号,施設 管理者氏名\n保育所,Sample nursery,1310000000000,東京都,千代田区,1-2,Annex,03-1234-5678,通常営業,03-9999-9999,Excluded manager\n";

    fn collection() -> Collection {
        Collection {
            contacts: BTreeMap::new(),
            prefectures: vec![Prefecture {
                code: "13".into(),
                name: "東京都".into(),
            }],
            municipalities: Vec::new(),
            reports: Vec::new(),
        }
    }

    #[test]
    fn only_operating_facilities_and_their_own_telephone_fields_enter_the_directory() {
        let mut source = SourceReport::default();
        let mut collection = collection();
        for csv in [
            FACILITIES.to_owned(),
            FACILITIES.replace("通常営業", "廃止済"),
            FACILITIES.replace("通常営業", "休止中"),
            FACILITIES.replace("通常営業", "停止中"),
            FACILITIES.replace("保育所", "家庭的保育事業者"),
        ] {
            ingest_csv(csv.as_bytes(), &mut source, &mut collection).unwrap();
        }
        assert_eq!((source.rows, source.accepted, source.invalid), (5, 1, 4));
        let contact = collection.contacts.values().next().unwrap();
        assert_eq!(contact.category, Category::Nursery);
        assert_eq!(contact.phones.len(), 1);
        assert_eq!(contact.phones[0].e164, "+81312345678");
        assert_eq!(contact.address, "東京都千代田区1-2 Annex");
        assert!(
            !serde_json::to_string(contact)
                .unwrap()
                .contains("Excluded manager")
        );
        assert!(
            ingest_csv(
                FACILITIES.replace("通常営業", "Unknown status").as_bytes(),
                &mut source,
                &mut collection
            )
            .is_err()
        );
    }

    #[test]
    fn childcare_requires_unambiguous_contact_fields_but_allows_repeated_unused_notes() {
        let mut source = SourceReport::default();
        assert!(
            ingest_csv(
                FACILITIES
                    .replace("施設の連絡先 電話番号", "Unknown column")
                    .as_bytes(),
                &mut source,
                &mut collection()
            )
            .is_err()
        );
        assert!(
            ingest_csv(
                FACILITIES
                    .replace("法人等の連絡先_電話番号", "施設の連絡先 電話番号")
                    .as_bytes(),
                &mut source,
                &mut collection()
            )
            .is_err()
        );
        ingest_csv(
            FACILITIES
                .replace("法人等の連絡先_電話番号", "備考")
                .replace("施設 管理者氏名", "備考")
                .as_bytes(),
            &mut source,
            &mut collection(),
        )
        .unwrap();
    }

    #[test]
    fn childcare_categories_follow_published_facility_types_and_exclude_individual_carers() {
        for (kind, expected) in [
            ("保育所", Category::Nursery),
            ("施設型給付を受ける幼稚園", Category::Kindergarten),
            ("施設型給付を受けない幼稚園", Category::Kindergarten),
            ("認定こども園－幼保連携型", Category::CertifiedChildCenter),
            ("小規模保育事業者－A型", Category::SmallScaleChildcare),
            (
                "事業所内保育事業者－定員20人以上",
                Category::WorkplaceChildcare,
            ),
        ] {
            assert_eq!(
                category(kind, false, "", FacilityStatus::Operating).unwrap(),
                Some(expected)
            );
        }
        assert_eq!(
            category("事業所内保育", true, "株式会社", FacilityStatus::Operating).unwrap(),
            Some(Category::UnlicensedChildcare)
        );
        for (kind, unlicensed, operator) in [
            ("家庭的保育事業者", false, ""),
            ("居宅訪問型保育事業者", false, ""),
            ("ベビーシッター（居宅訪問型保育）", true, "株式会社"),
            ("その他", true, "個人"),
        ] {
            assert_eq!(
                category(kind, unlicensed, operator, FacilityStatus::Operating).unwrap(),
                None
            );
        }
        assert!(category("Unknown type", false, "", FacilityStatus::Operating).is_err());
    }
}
