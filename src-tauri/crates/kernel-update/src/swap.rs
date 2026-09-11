//! 目录换名（原子性近似）：staging 换入正式 + 备份轮换 + 回滚。
//!
//! Windows 同卷目录 rename 近似原子；顺序保证「坏内核永远进不了正式
//! 目录」失败时先恢复原状。全部纯文件操作，tempdir 单测覆盖。

use std::fs;
use std::path::{Path, PathBuf};

/// 换名布局参数。
#[derive(Debug, Clone)]
pub struct SwapLayout {
    /// 正式内核目录（`<安装目录>/kernel`）。
    pub kernel_dir: PathBuf,
    /// staging 根（`<安装目录>/kernel-staging`），staging 版本目录为
    /// `<staging_root>/<version>`。
    pub staging_root: PathBuf,
    /// 备份根（`<安装目录>/kernel-backup`），备份版本目录为
    /// `<backup_root>/<version>`。
    pub backup_root: PathBuf,
    /// 保留备份数（1~2）。
    pub keep_backups: u32,
}

/// 预检：安装目录可写、磁盘剩余 ≥ need_bytes、无残留 staging 目录。
/// Err(String) = 拦截原因（直接展示给用户）。
pub fn precheck(layout: &SwapLayout, need_bytes: u64) -> Result<(), String> {
    // 1. 正式内核必须存在（否则无从备份/回滚）。
    if !layout.kernel_dir.is_dir() {
        return Err(format!(
            "内核目录不存在: {}",
            layout.kernel_dir.display()
        ));
    }
    // 2. 可写探测：在安装根下建删探针文件。
    let probe_parent = layout
        .kernel_dir
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let probe = probe_parent.join(".update-probe");
    fs::write(&probe, b"probe")
        .map_err(|e| format!("安装目录不可写（{}）: {e}", probe_parent.display()))?;
    let _ = fs::remove_file(&probe);

    // 3. 磁盘剩余空间。
    let free = free_disk_bytes(&probe_parent).unwrap_or(u64::MAX);
    if free < need_bytes {
        return Err(format!(
            "磁盘剩余 {free} 字节，更新至少需要 {need_bytes} 字节（含备份与缓存）"
        ));
    }

    // 4. 残留 staging（上次失败未清理）→ 尝试删除，删不掉报错。
    if layout.staging_root.exists() {
        fs::remove_dir_all(&layout.staging_root)
            .map_err(|e| format!("残留 staging 目录删除失败（可能被占用）: {e}"))?;
    }
    Ok(())
}

/// 换入 staging（SelfTest 通过后调用）：
/// ① 备份轮换 → ② 正式改名入备份 → ③ staging 改名入正式；
/// ③ 失败则反向恢复（备份换回正式）。
/// `current_version` 用于备份目录命名（读不到时用时间戳）。
pub fn swap_in(layout: &SwapLayout, version: &str, current_version: Option<&str>) -> Result<(), String> {
    rotate_backups(layout)?;

    let backup_name = match current_version {
        Some(v) => sanitize_version_dir(v),
        None => format!("pre-{}", now_tag()),
    };
    let backup_dir = layout.backup_root.join(&backup_name);
    fs::create_dir_all(&layout.backup_root)
        .map_err(|e| format!("create backup root: {e}"))?;

    // ② 正式 → 备份
    fs::rename(&layout.kernel_dir, &backup_dir)
        .map_err(|e| format!("正式内核改名为备份失败（被占用？）: {e}"))?;

    // ③ staging → 正式
    let staging_dir = layout.staging_root.join(sanitize_version_dir(version));
    if let Err(e) = fs::rename(&staging_dir, &layout.kernel_dir) {
        // 反向恢复：备份换回正式，保住现状。
        if let Err(re) = fs::rename(&backup_dir, &layout.kernel_dir) {
            return Err(format!(
                "staging 换入失败: {e}；且恢复备份也失败: {re}（请勿删除 {}，立即反馈）",
                backup_dir.display()
            ));
        }
        return Err(format!("staging 换入失败（已恢复原内核）: {e}"));
    }
    Ok(())
}

/// 一键回滚：当前正式（坏的新版）挪到回收名，备份版本换入。
/// `backup_version` 必须存在于 backup_root。
pub fn rollback_to(layout: &SwapLayout, backup_version: &str) -> Result<(), String> {
    let backup_dir = layout.backup_root.join(sanitize_version_dir(backup_version));
    if !backup_dir.is_dir() {
        return Err(format!("备份不存在: {}", backup_dir.display()));
    }
    let discard = layout
        .backup_root
        .join(format!("discard-{}", now_tag()));
    // ① 坏的正式 → discard
    fs::rename(&layout.kernel_dir, &discard)
        .map_err(|e| format!("当前内核改名失败: {e}"))?;
    // ② 备份 → 正式
    if let Err(e) = fs::rename(&backup_dir, &layout.kernel_dir) {
        // 恢复坏内核，至少维持可启动状态。
        let _ = fs::rename(&discard, &layout.kernel_dir);
        return Err(format!("备份换入失败（已恢复当前内核）: {e}"));
    }
    // ③ 删除 discard（尽力而为；失败只留垃圾不碍事）。
    let _ = fs::remove_dir_all(&discard);
    Ok(())
}

/// 备份轮换：保留最近 keep_backups 份（按目录修改时间），删除更旧的。
pub fn rotate_backups(layout: &SwapLayout) -> Result<Vec<String>, String> {
    if !layout.backup_root.exists() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<(std::time::SystemTime, String, PathBuf)> = fs::read_dir(&layout.backup_root)
        .map_err(|e| format!("read backup root: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let modified = meta.modified().ok()?;
            Some((modified, e.file_name().to_string_lossy().into_owned(), e.path()))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0)); // 新 → 旧
    let mut removed = Vec::new();
    for (idx, (_, name, path)) in entries.into_iter().enumerate() {
        if idx as u32 >= layout.keep_backups.max(1) {
            if fs::remove_dir_all(&path).is_ok() {
                removed.push(name);
            }
        }
    }
    Ok(removed)
}

/// 列出现存备份版本目录名（新 → 旧）。
pub fn list_backups(backup_root: &Path) -> Vec<String> {
    let mut entries: Vec<(std::time::SystemTime, String)> = fs::read_dir(backup_root)
        .map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            Some((modified, e.file_name().to_string_lossy().into_owned()))
        }).collect())
        .unwrap_or_default();
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.into_iter().map(|(_, n)| n).collect()
}

/// 读取正式内核版本（node_modules/@deepseek-ai/dsh/package.json 的 version）。
pub fn read_kernel_version(kernel_dir: &Path) -> Option<String> {
    let pkg = kernel_dir
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let raw = fs::read_to_string(pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("version")?.as_str().map(|s| s.to_string())
}

/// 版本目录名净化：只保留 `[A-Za-z0-9._-]`，其余替换 `_`（防版本字符串
/// 注入路径）。
fn sanitize_version_dir(v: &str) -> String {
    let clean: String = v
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    if clean.is_empty() { "unknown".to_string() } else { clean }
}

fn now_tag() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string()
}

/// Windows 磁盘剩余字节（GetDiskFreeSpaceExW）；失败返回 None。
#[cfg(windows)]
fn free_disk_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut free_total: u64 = 0;
    // SAFETY: 三个指针都是合法可写 u64；wide 以 NUL 结尾。
    let ok = unsafe {
        GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_to_caller, &mut total, &mut free_total)
    };
    if ok != 0 { Some(free_to_caller) } else { None }
}

#[cfg(not(windows))]
fn free_disk_bytes(_path: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "kernel-update-{tag}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn touch_kernel(dir: &Path, version: &str, marker: &str) {
        let pkg = dir
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(
            pkg.join("package.json"),
            format!(r#"{{"name":"@deepseek-ai/dsh","version":"{version}"}}"#),
        )
        .unwrap();
        fs::write(dir.join("marker.txt"), marker).unwrap();
    }

    fn layout(root: &Path) -> SwapLayout {
        SwapLayout {
            kernel_dir: root.join("kernel"),
            staging_root: root.join("kernel-staging"),
            backup_root: root.join("kernel-backup"),
            keep_backups: 1,
        }
    }

    #[test]
    fn read_kernel_version_roundtrip() {
        let root = temp_root("version");
        let k = root.join("kernel");
        touch_kernel(&k, "0.1.0-rc.6", "old");
        assert_eq!(
            read_kernel_version(&k).as_deref(),
            Some("0.1.0-rc.6")
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn precheck_rejects_missing_kernel_and_dirty_staging() {
        let root = temp_root("precheck");
        let lay = layout(&root);
        // 内核不存在 → 拦截。
        assert!(precheck(&lay, 0).is_err());

        // 内核存在 + staging 残留可删 → 通过。
        touch_kernel(&lay.kernel_dir, "0.1.0-rc.6", "x");
        fs::create_dir_all(lay.staging_root.join("junk")).unwrap();
        assert!(precheck(&lay, 0).is_ok(), "staging 残留应被自动清理");
        assert!(!lay.staging_root.exists());

        // 磁盘需求 absurd → 拦截。
        assert!(precheck(&lay, u64::MAX).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn swap_in_moves_backup_and_activates_staging() {
        let root = temp_root("swapin");
        let lay = layout(&root);
        touch_kernel(&lay.kernel_dir, "0.1.0-rc.6", "old");
        fs::create_dir_all(&lay.staging_root).unwrap();
        touch_kernel(&lay.staging_root.join("0.1.0-rc.7"), "0.1.0-rc.7", "new");

        swap_in(&lay, "0.1.0-rc.7", read_kernel_version(&lay.kernel_dir).as_deref()).expect("swap");

        // 正式现在是新版。
        assert_eq!(read_kernel_version(&lay.kernel_dir).as_deref(), Some("0.1.0-rc.7"));
        assert_eq!(fs::read_to_string(lay.kernel_dir.join("marker.txt")).unwrap(), "new");
        // 备份里是旧版。
        let backups = list_backups(&lay.backup_root);
        assert_eq!(backups, vec!["0.1.0-rc.6"]);
        assert_eq!(
            read_kernel_version(&lay.backup_root.join("0.1.0-rc.6")).as_deref(),
            Some("0.1.0-rc.6")
        );

        // 回滚：坏的新版 → discard，旧版回正式。
        rollback_to(&lay, "0.1.0-rc.6").expect("rollback");
        assert_eq!(read_kernel_version(&lay.kernel_dir).as_deref(), Some("0.1.0-rc.6"));
        assert_eq!(fs::read_to_string(lay.kernel_dir.join("marker.txt")).unwrap(), "old");
        assert!(!lay.backup_root.join("0.1.0-rc.6").exists(), "备份换入后应消失");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn swap_failure_restores_previous_kernel() {
        let root = temp_root("swapfail");
        let lay = layout(&root);
        touch_kernel(&lay.kernel_dir, "0.1.0-rc.6", "old");
        // staging 版本目录故意缺失 → ③ 必失败 → 必须恢复旧内核。
        assert!(swap_in(&lay, "0.2.0", Some("0.1.0-rc.6")).is_err());
        assert!(lay.kernel_dir.is_dir(), "内核目录必须被恢复");
        assert_eq!(read_kernel_version(&lay.kernel_dir).as_deref(), Some("0.1.0-rc.6"));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn rotate_keeps_newest_only() {
        let root = temp_root("rotate");
        let lay = layout(&root);
        fs::create_dir_all(&lay.backup_root).unwrap();
        for (i, (name, marker)) in [("0.1.0-rc.4", "oldest"), ("0.1.0-rc.5", "newer"), ("0.1.0-rc.6", "newest")]
            .into_iter()
            .enumerate()
        {
            let d = lay.backup_root.join(name);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("m"), marker).unwrap();
            // 显式拉开修改时间（i=0 最旧），避免同秒 mtime 相同导致排序不稳。
            let t = SystemTime::now() - std::time::Duration::from_secs((3 - i as u64) * 100);
            let file = d.join("m");
            set_mtime(&file, t);
        }
        let removed = rotate_backups(&lay).unwrap();
        assert_eq!(removed.len(), 2, "keep=1 应删除两份旧备份");
        let left = list_backups(&lay.backup_root);
        assert_eq!(left, vec!["0.1.0-rc.6"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    fn set_mtime(path: &Path, t: std::time::SystemTime) {
        let f = fs::OpenOptions::new().write(true).open(path).unwrap();
        filetime_set(&f, t);
    }

    #[cfg(windows)]
    fn filetime_set(file: &fs::File, t: std::time::SystemTime) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::Storage::FileSystem::SetFileTime;
        let secs = t.duration_since(UNIX_EPOCH).unwrap().as_secs();
        let ticks: u64 = secs * 10_000_000; // 100ns ticks since 1601-01-01
        let ft = FILETIME {
            dwLowDateTime: ticks as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        };
        // SAFETY: handle 合法；两个 write time 同值；access time 传 None。
        unsafe {
            SetFileTime(file.as_raw_handle() as _, std::ptr::null(), std::ptr::null(), &ft);
        }
    }
}
