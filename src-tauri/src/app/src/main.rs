//! 二进制入口：只调 tt_desktop_app::run()
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tt_desktop_app::run();
}
