use regex::Regex;

pub fn identifiers(src: &str) -> Vec<&str> {
    let re = Regex::new(r"\b[A-Za-z_][A-Za-z0-9_]*\b").unwrap();
    re.find_iter(src).map(|m| m.as_str()).collect()
}

pub fn date_parts(s: &str) -> Option<(u32, u32, u32)> {
    let re = Regex::new(r#"(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})"#).unwrap();
    let c = re.captures(s)?;
    Some((c["y"].parse().ok()?, c["m"].parse().ok()?, c["d"].parse().ok()?))
}
