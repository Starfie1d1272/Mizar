use mizar_exit_owner_regression::{cs2_session::SessionStore, cs2_video::VideoSize, production_exit, startup_log::DesktopLog};
fn main() {
    let root = std::path::PathBuf::from(std::env::args().nth(1).unwrap());
    let log = DesktopLog::new(&root, None).unwrap();
    let store = SessionStore::new(root.join("transaction"));
    let video = root.join("steam/userdata/1/730/local/cfg/cs2_video.txt");
    if std::env::args().nth(2).as_deref() == Some("prepare") {
        std::fs::create_dir_all(video.parent().unwrap()).unwrap();
        std::fs::write(video.parent().unwrap().join("cs2_machine_convars.vcfg"), b"\"config\" {\"convars\" {\"fps_max\" \"0\"}}" ).unwrap();
        std::fs::write(&video, b"\"video.cfg\" { \"setting.defaultres\" \"1280\" \"setting.defaultresheight\" \"960\" \"setting.fullscreen\" \"1\" }").unwrap();
        std::fs::copy(&video, root.join("expected-original.txt")).unwrap();
        store.backup_originals(&video).unwrap();
        store.prepare_backed_up(&video, &root.join("game/bin/win64/cs2.exe"), VideoSize::new(1440, 810).unwrap()).unwrap();
    } else {
        match production_exit::finish_then_restore(|| production_exit::finish_workspace_production(&log), || store.restore().map(|_| ())) {
            Ok(()) => println!("safe-production-finish-and-real-file-restore: PASS"),
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
        assert_eq!(std::fs::read(&video).unwrap(), std::fs::read(root.join("expected-original.txt")).unwrap());
        assert!(store.load().unwrap().is_none());
    }
}
