//! semver 2.0 解析与比较（含预发布优先级），版本选择纯函数。
//!
//! 只覆盖内核更新用得到的子集：`1.2.3` / `1.2.3-rc.1`；比较遵循
//! semver：预发布 < 正式版；预发布段逐段比较，数字段按数值、字母段按
//! 字典序，数字段 < 字母段，段数少 < 段数多（`rc` < `rc.6`）。

use std::cmp::Ordering;

/// 解析后的版本号（build 元数据忽略）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// 预发布段，如 `rc.6` 拆为 ["rc", "6"]。
    pub pre: Vec<String>,
}

impl SemVer {
    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

/// 解析 `major.minor.patch[-pre]`；失败返回 None（fail-closed，不猜）。
pub fn parse_semver(s: &str) -> Option<SemVer> {
    let s = s.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let pre = match pre {
        Some(p) if p.is_empty() => return None,
        Some(p) => p.split('.').map(|x| x.to_string()).collect(),
        None => Vec::new(),
    };
    // 预发布段不允许空段（如 `rc..6`）。
    if pre.iter().any(|x| x.is_empty()) {
        return None;
    }
    Some(SemVer { major, minor, patch, pre })
}

/// 预发布单段的比较键：数字段 (0, 数值)，字母段 (1, 原文)。
fn pre_key(id: &str) -> (u8, u64, String) {
    match id.parse::<u64>() {
        Ok(n) => (0, n, String::new()),
        Err(_) => (1, 0, id.to_string()),
    }
}

/// semver 2.0 优先级比较。
pub fn cmp_semver(a: &SemVer, b: &SemVer) -> Ordering {
    let core = a
        .major
        .cmp(&b.major)
        .then_with(|| a.minor.cmp(&b.minor))
        .then_with(|| a.patch.cmp(&b.patch));
    if core != Ordering::Equal {
        return core;
    }
    match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater, // 正式版 > 预发布
        (false, true) => Ordering::Less,
        (false, false) => {
            for (x, y) in a.pre.iter().zip(b.pre.iter()) {
                let ord = pre_key(x).cmp(&pre_key(y));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            a.pre.len().cmp(&b.pre.len()) // 段数少 < 段数多
        }
    }
}

/// 目标版本是否严格高于当前版本（等版本 = 重装路径，不是升级）。
pub fn is_upgrade(current: &str, target: &str) -> bool {
    match (parse_semver(current), parse_semver(target)) {
        (Some(c), Some(t)) => cmp_semver(&t, &c) == Ordering::Greater,
        _ => false, // 任一解析失败 → 不判定为升级（fail-closed）
    }
}

/// 版本列表里挑出最大版本（用于 dist-tags 缺失时的兜底展示）。
pub fn max_version(versions: &[&str]) -> Option<String> {
    versions
        .iter()
        .filter_map(|v| parse_semver(v).map(|s| (s, v)))
        .max_by(|a, b| cmp_semver(&a.0, &b.0))
        .map(|(_, v)| v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basic_and_prerelease() {
        let v = parse_semver("0.1.0").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (0, 1, 0));
        assert!(!v.is_prerelease());

        let v = parse_semver("v0.1.0-rc.6").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (0, 1, 0));
        assert_eq!(v.pre, vec!["rc", "6"]);
        assert!(v.is_prerelease());

        assert!(parse_semver("").is_none());
        assert!(parse_semver("1.2").is_none());
        assert!(parse_semver("1.2.3.4").is_none());
        assert!(parse_semver("a.b.c").is_none());
        assert!(parse_semver("1.2.3-rc..6").is_none());
    }

    #[test]
    fn ordering_core_and_prerelease() {
        let c = |a: &str, b: &str| {
            cmp_semver(&parse_semver(a).unwrap(), &parse_semver(b).unwrap())
        };
        assert_eq!(c("1.0.0", "1.0.0"), Ordering::Equal);
        assert_eq!(c("1.0.1", "1.0.0"), Ordering::Greater);
        assert_eq!(c("1.10.0", "1.9.0"), Ordering::Greater, "数字段按数值比较");
        // 预发布 < 正式版
        assert_eq!(c("1.0.0-rc.1", "1.0.0"), Ordering::Less);
        // rc < rc.6（段数少 < 段数多）
        assert_eq!(c("1.0.0-rc", "1.0.0-rc.6"), Ordering::Less);
        assert_eq!(c("1.0.0-rc.6", "1.0.0-rc.7"), Ordering::Less, "rc.6 < rc.7");
        assert_eq!(c("1.0.0-rc.6", "1.0.0-rc.10"), Ordering::Less, "数值段按数值比较");
        // 数字段 < 字母段
        assert_eq!(c("1.0.0-1", "1.0.0-alpha"), Ordering::Less);
        assert_eq!(c("0.1.0-rc.6", "0.1.0"), Ordering::Less);
        // 跨 major 的预发布序列
        assert_eq!(c("0.1.0-rc.7", "0.1.0-rc.6"), Ordering::Greater);
    }

    #[test]
    fn upgrade_detection() {
        assert!(is_upgrade("0.1.0-rc.6", "0.1.0-rc.7"));
        assert!(is_upgrade("0.1.0-rc.6", "0.1.0"));
        assert!(!is_upgrade("0.1.0-rc.6", "0.1.0-rc.6"), "同版本重装不是升级");
        assert!(!is_upgrade("0.1.0", "0.1.0-rc.7"), "降级到预发布不是升级");
        assert!(!is_upgrade("0.1.0-rc.7", "0.1.0-rc.6"), "降级");
        assert!(!is_upgrade("bad", "0.2.0"), "解析失败 fail-closed");
    }

    #[test]
    fn max_of_list() {
        let list = ["0.1.0-rc.4", "0.1.0-rc.10", "0.1.0", "0.0.9"];
        assert_eq!(max_version(&list).as_deref(), Some("0.1.0"));
        assert_eq!(max_version(&[]), None);
    }
}
