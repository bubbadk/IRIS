//! Opt-in tests exercise the real updater against signed, disposable loopback fixtures.
//! The application handle is a Tauri test runtime; HTTP, signatures and installation are real.
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri_plugin_updater::UpdaterExt;

struct FixtureServer {
    address: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl FixtureServer {
    fn new(root: &std::path::Path) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut routes = HashMap::new();
        for (name, file) in [
            ("valid", "update.tar.gz"),
            ("tampered", "update.tar.gz"),
            ("legacy", "legacy.tar.gz"),
        ] {
            let mut bytes = std::fs::read(root.join(file)).unwrap();
            if name == "tampered" {
                bytes.push(1);
            }
            let signature = std::fs::read_to_string(root.join(format!("{file}.sig"))).unwrap();
            let manifest = serde_json::json!({
                "version": "999.0.0-local-test",
                "notes": "Isolated integration fixture: verify signed download, replacement and restart.",
                "platforms": {"linux-x86_64": {
                    "url": format!("http://{address}/{name}.tar.gz"), "signature": signature.trim()
                }}
            });
            routes.insert(format!("/{name}.json"), manifest.to_string().into_bytes());
            routes.insert(format!("/{name}.tar.gz"), bytes);
        }
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = std::thread::spawn(move || {
            for incoming in listener.incoming() {
                if thread_stop.load(Ordering::Relaxed) {
                    break;
                }
                let mut stream = incoming.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while request.len() < 16384 && !request.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).unwrap_or(0) == 0 {
                        break;
                    }
                    request.push(byte[0]);
                }
                let request = String::from_utf8_lossy(&request);
                let path = request.split_whitespace().nth(1).unwrap_or("");
                if let Some(body) = routes.get(path) {
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    stream.write_all(header.as_bytes()).unwrap();
                    stream.write_all(body).unwrap();
                } else {
                    stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                }
            }
        });
        Self {
            address,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for FixtureServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = std::net::TcpStream::connect(self.address);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

#[test]
#[ignore = "run scripts/verify-signed-updater.py to create disposable signing fixtures"]
fn signed_updater_installs_and_rejects_invalid_packages() {
    use std::os::unix::fs::PermissionsExt;
    let root = PathBuf::from(
        std::env::var_os("IRIS_UPDATER_TEST_FIXTURES").expect("isolated fixture directory"),
    );
    let key = std::fs::read_to_string(root.join("test-key.pub")).unwrap();
    let server = FixtureServer::new(&root);
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey": key.trim(), "dangerousInsecureTransportProtocol": true
        }),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    for case in ["valid", "tampered", "legacy"] {
        let target = root.join(format!("installed-{case}"));
        let old = b"#!/bin/sh\nexit 73\n";
        std::fs::write(&target, old).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();
        let updater = app
            .updater_builder()
            .executable_path(&target)
            .target("linux-x86_64")
            .endpoints(vec![format!("http://{}/{case}.json", server.address)
                .parse()
                .unwrap()])
            .unwrap()
            .timeout(Duration::from_secs(30))
            .no_proxy()
            .build()
            .unwrap();
        tauri::async_runtime::block_on(async {
            let update = updater.check().await.unwrap().expect("newer test fixture");
            assert_eq!(update.version, "999.0.0-local-test");
            assert!(update.body.as_deref().unwrap().contains("signed download"));
            let mut received = 0;
            let result = update
                .download_and_install(|count, _| received += count, || {})
                .await;
            assert!(received > 0, "real download progress");
            if case == "valid" {
                result.expect("signed installation");
                assert_eq!(
                    std::fs::read(&target).unwrap(),
                    std::fs::read(root.join("expected-iris")).unwrap()
                );
                assert_ne!(
                    std::fs::metadata(&target).unwrap().permissions().mode() & 0o111,
                    0
                );
            } else {
                let error = result.expect_err("invalid fixture must be rejected");
                if case == "legacy" {
                    assert!(matches!(
                        error,
                        tauri_plugin_updater::Error::BinaryNotFoundInArchive
                    ));
                } else {
                    assert!(
                        matches!(error, tauri_plugin_updater::Error::Minisign(_)),
                        "tampering must fail cryptographic verification"
                    );
                }
                assert_eq!(
                    std::fs::read(&target).unwrap(),
                    old,
                    "the old executable must survive failed verification or extraction"
                );
            }
        });
    }
}
