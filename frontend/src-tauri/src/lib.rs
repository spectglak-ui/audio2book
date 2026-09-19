use std::fs::OpenOptions;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct BackendProcess(Mutex<Option<Child>>);

fn find_backend_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Version installee : exe place dans ProgramFiles/Audio2Book/
    // Le backend est inclus dans les ressources du bundle a cote de l'exe
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // En production, le backend est copie a cote de l'executable
            candidates.push(dir.join("backend"));
        }
    }

    // 2. Developpement : cwd = frontend/
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("..").join("backend"));
    }

    // 3. Variable d'environnement (override pratique pour dev/test)
    if let Ok(env_dir) = std::env::var("AUDIO2BOOK_BACKEND_DIR") {
        candidates.push(PathBuf::from(env_dir));
    }

    candidates
        .into_iter()
        .find(|path| path.join("app").join("main.py").exists())
}

fn spawn_backend() -> Option<Child> {
    // Si un backend tourne deja (mode resident), ne rien lancer
    if std::net::TcpStream::connect("127.0.0.1:8000").is_ok() {
        println!("[Audio2Book] Backend deja actif, rien a demarrer.");
        return None;
    }

    let backend_dir = find_backend_dir()?;

    #[cfg(target_os = "windows")]
    let python = backend_dir.join(".venv").join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let python = backend_dir.join(".venv").join("bin").join("python");

    if !python.exists() {
        eprintln!("[Audio2Book] Python du venv introuvable : {:?}", python);
        return None;
    }

    println!("[Audio2Book] Demarrage du backend en arriere-plan...");

    let mut cmd = Command::new(&python);
    cmd.current_dir(&backend_dir)
        .args([
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8000",
        ]);

    // Journalisation dans backend.log (pour debugger sans console)
    if let Ok(log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(backend_dir.join("backend.log"))
    {
        if let Ok(log_err) = log.try_clone() {
            cmd.stdout(Stdio::from(log)).stderr(Stdio::from(log_err));
        }
    }

    // Fenetre console invisible sous Windows
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(error) => {
            eprintln!("[Audio2Book] Impossible de demarrer le backend : {}", error);
            None
        }
    }
}

fn stop_backend(state: &BackendProcess) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            println!("[Audio2Book] Backend arrete proprement.");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let child = spawn_backend();
            app.manage(BackendProcess(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erreur au demarrage de Audio2Book")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<BackendProcess>() {
                    stop_backend(&state);
                }
            }
        });
}