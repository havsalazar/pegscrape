mod logger;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_blec::init())
        .manage(logger::Logger::default())
        .invoke_handler(tauri::generate_handler![
            logger::logger_scan_start,
            logger::logger_scan_stop,
            logger::logger_connect,
            logger::logger_disconnect,
            logger::logger_info,
            logger::logger_list,
            logger::logger_download,
            logger::logger_abort,
            logger::logger_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pegscrape");
}
