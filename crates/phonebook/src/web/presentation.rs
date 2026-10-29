use crate::model::Category;

pub(super) fn category_label(category: Category) -> &'static str {
    match category {
        Category::Medical => "病院・診療所",
        Category::Dental => "歯医者",
        Category::Pharmacy => "薬局",
        Category::MunicipalOffice => "市区町村の役所",
        Category::PrefecturalOffice => "都道府県の役所",
        Category::NursingCare => "介護サービス",
        Category::DisabilitySupport => "障害福祉サービス",
        Category::Library => "図書館",
        Category::Museum => "博物館・美術館",
        Category::Archive => "公文書館",
        Category::Nursery => "保育所",
        Category::Kindergarten => "幼稚園",
        Category::CertifiedChildCenter => "認定こども園",
        Category::SmallScaleChildcare => "小規模保育",
        Category::WorkplaceChildcare => "事業所内保育",
        Category::UnlicensedChildcare => "認可外保育施設",
        Category::University => "大学",
        Category::JuniorCollege => "短期大学",
        Category::TechnicalCollege => "高等専門学校",
        Category::ConsumerAffairs => "消費生活相談",
        Category::LabourBureau => "労働局",
        Category::LabourInspection => "労働基準監督署",
        Category::LabourConsultation => "労働相談",
        Category::ChildConsultation => "児童相談所",
        Category::SocialWithdrawalSupport => "ひきこもり支援",
        Category::PensionOffice => "年金事務所",
        Category::PensionConsultation => "年金相談センター",
        Category::TaxOffice => "税務署",
        Category::LegalAffairs => "法務局",
        Category::FireBrigadeOffice => "消防団の事務窓口",
        Category::PoliceConsultation => "警察相談",
        Category::EmploymentOffice => "ハローワーク",
        Category::ParentEmploymentSupport => "子育て中の人の就職支援",
        Category::GraduateEmploymentSupport => "新卒の就職支援",
        Category::YouthEmploymentSupport => "若者の就職支援",
        Category::ForeignEmploymentSupport => "外国人の就職支援",
        Category::LocalEmploymentSupport => "地域の就職相談",
        Category::AgricultureEmploymentSupport => "農林漁業の就職支援",
        Category::RelocationEmploymentSupport => "移住に伴う就職支援",
    }
}

pub(super) fn category_icon(category: Category) -> &'static str {
    match category {
        Category::Library => "library",
        Category::Museum => "museum",
        Category::Archive => "archive",
        _ => "",
    }
}

pub(super) struct Publisher {
    pub name: &'static str,
    pub description: &'static str,
}

pub(super) fn publisher(category: Category) -> Publisher {
    let (name, description) = match category {
        Category::Medical | Category::Dental | Category::Pharmacy => (
            "厚生労働省 地方厚生局",
            "保険医療機関・保険薬局の一覧です。休止中の施設が含まれることがあります。",
        ),
        Category::MunicipalOffice => (
            "japan-municipal-offices",
            "全国の市区町村の役所の公開データです。掲載された番号と確認日を引き継いでいます。",
        ),
        Category::PrefecturalOffice => (
            "内閣府",
            "行政支援の資料に掲載された都道府県の役所の代表番号です。",
        ),
        Category::NursingCare => (
            "厚生労働省",
            "介護サービス情報公表システムの事業所データです。法人本部やFAXの番号は対象外です。",
        ),
        Category::DisabilitySupport => (
            "WAM NET",
            "障害福祉サービスの事業所データです。子ども向けの支援や相談の事業所も含みます。",
        ),
        Category::Library | Category::Museum | Category::Archive => (
            "国立国会図書館",
            "図書館・博物館・公文書館の登録リストです。登録された施設が対象で、すべての施設を網羅する一覧ではありません。",
        ),
        Category::Nursery
        | Category::Kindergarten
        | Category::CertifiedChildCenter
        | Category::SmallScaleChildcare
        | Category::WorkplaceChildcare
        | Category::UnlicensedChildcare => (
            "こども家庭庁・WAM NET",
            "通常営業の保育・幼児教育施設の一覧です。休廃止、訪問型・家庭的保育、個人が設置した認可外施設は対象外です。全国の元データは公開元のダウンロード画面から取得できます。",
        ),
        Category::University | Category::JuniorCollege | Category::TechnicalCollege => (
            "文部科学省",
            "大学・短期大学・高等専門学校の一覧です。学校の代表番号を掲載し、個人や部門の連絡先は対象外です。",
        ),
        Category::ConsumerAffairs => (
            "国民生活センター",
            "消費生活の相談窓口の一覧です。元の数値形式のCSVで省略された電話番号の先頭の0を補っています。",
        ),
        Category::LabourBureau | Category::LabourInspection | Category::LabourConsultation => (
            "厚生労働省",
            "労働局・労働基準監督署・労働相談の窓口と担当部門の番号です。受付内容は公開元で確認してください。",
        ),
        Category::ChildConsultation => ("こども家庭庁", "全国の児童相談所と支所の連絡先です。"),
        Category::SocialWithdrawalSupport => {
            ("厚生労働省", "地域のひきこもり支援の相談窓口の一覧です。")
        }
        Category::PensionOffice => (
            "日本年金機構",
            "年金事務所の主な所在地と職員への連絡先です。同じページの別の相談室を省くことがあります。手続きや予約については公式サイトで確認してください。",
        ),
        Category::PensionConsultation => (
            "日本年金機構",
            "年金相談センターの職員への連絡先です。電話による年金相談を受け付ける番号ではありません。予約や相談内容は公式サイトで確認してください。",
        ),
        Category::TaxOffice => (
            "国税庁",
            "税務署の所在地と連絡先の一覧です。郵送用の業務センターの住所は所在地に含めていません。",
        ),
        Category::LegalAffairs => ("法務省", "法務局と地方法務局の一覧です。"),
        Category::FireBrigadeOffice => (
            "消防庁",
            "消防団の事務を担当する窓口です。緊急通報の番号ではありません。所在地は市区町村までの場合があります。",
        ),
        Category::PoliceConsultation => (
            "警察庁",
            "緊急でない警察相談の窓口です。所在地は都道府県までの表示です。",
        ),
        Category::EmploymentOffice
        | Category::ParentEmploymentSupport
        | Category::GraduateEmploymentSupport
        | Category::YouthEmploymentSupport
        | Category::ForeignEmploymentSupport
        | Category::LocalEmploymentSupport
        | Category::AgricultureEmploymentSupport
        | Category::RelocationEmploymentSupport => (
            "厚生労働省",
            "ハローワークと就職支援の窓口です。利用対象や受付時間は公式サイトで確認してください。",
        ),
    };
    Publisher { name, description }
}

pub(super) fn date_label(value: &str) -> String {
    if value == "Not specified by source" || value.is_empty() {
        "資料に記載なし".into()
    } else if let Some(year) = value.strip_suffix(" academic year") {
        format!("{year}年度")
    } else {
        value.to_owned()
    }
}

pub(super) fn count(value: usize) -> String {
    const DIGITS_PER_GROUP: usize = 3;
    let digits = value.to_string();
    let mut result = String::with_capacity(digits.len() + digits.len() / DIGITS_PER_GROUP);
    for (index, digit) in digits.bytes().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(DIGITS_PER_GROUP) {
            result.push(',');
        }
        result.push(char::from(digit));
    }
    result
}
