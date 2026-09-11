import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
OUTPUT_DIR = BASE_DIR / "outputs"
TEMP_DIR = BASE_DIR / "temp"
VOICES_DIR = BASE_DIR / "voices" / "xtts"
BOOKS_DIR = BASE_DIR / "books"
SETTINGS_FILE = BASE_DIR / "settings.json"

for directory in (OUTPUT_DIR, TEMP_DIR, VOICES_DIR, BOOKS_DIR):
    directory.mkdir(parents=True, exist_ok=True)

MODEL_NAME = os.getenv("XTTS_MODEL_NAME", "tts_models/multilingual/multi-dataset/xtts_v2")
tts = None
SAMPLE_RATE = 24000
MODEL_LOCK = threading.RLock()

jobs: dict = {}
jobs_lock = threading.Lock()
job_queue: queue.Queue = queue.Queue()
book_job_ids: dict = {}
books_lock = threading.Lock()

def load_settings():
    if SETTINGS_FILE.exists():
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f: return json.load(f)
    return {"theme": "dark", "default_format": "mp3"}

def save_settings(data):
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def load_book(book_id: str):
    path = BOOKS_DIR / f"{book_id}.json"
    if not path.exists(): return None
    with books_lock:
        with open(path, "r", encoding="utf-8") as f: return json.load(f)

def save_book(book: dict):
    with books_lock:
        with open(BOOKS_DIR / f"{book['id']}.json", "w", encoding="utf-8") as f:
            json.dump(book, f, ensure_ascii=False, indent=2)

def book_dir(book_id: str) -> Path: return BOOKS_DIR / book_id

def load_model():
    global tts, SAMPLE_RATE
    import torch
    from TTS.api import TTS as TTSAPI
    torch.backends.cudnn.benchmark = True
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    gpu = torch.cuda.is_available()
    print(f"[Audio2Book] Chargement de XTTS-v2 (gpu={gpu})...")
    try: tts = TTSAPI(MODEL_NAME, gpu=gpu)
    except TypeError: tts = TTSAPI(MODEL_NAME)
    try: SAMPLE_RATE = tts.synthesizer.output_sample_rate
    except Exception: SAMPLE_RATE = 24000
    print("[Audio2Book] Modele charge avec succes.")

def split_text(text: str, max_chars: int = 220):
    sentences = re.split(r"(?<=[.!?…])\s+", text.strip())
    segments, current = [], ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence: continue
        if len(current) + len(sentence) + 1 <= max_chars:
            current = (current + " " + sentence).strip()
        else:
            if current: segments.append(current)
            while len(sentence) > max_chars:
                cut = sentence.rfind(" ", 0, max_chars)
                if cut == -1: cut = max_chars
                segments.append(sentence[:cut].strip())
                sentence = sentence[cut:].strip()
            current = sentence
    if current: segments.append(current)
    return segments

def synthesize_segment(text: str, voice_path: Path, language: str) -> np.ndarray:
    with MODEL_LOCK:
        wav = tts.tts(text=text, speaker_wav=str(voice_path), language=language)
    wav_array = np.asarray(wav, dtype=np.float32)
    if wav_array.ndim == 2: wav_array = wav_array[0]
    return wav_array

def peak_normalize(wav: np.ndarray, target_db: float = -1.0) -> np.ndarray:
    peak = np.max(np.abs(wav))
    if peak < 1e-8: return wav
    gain = (10 ** (target_db / 20)) / peak
    return np.clip(wav * gain, -1.0, 1.0).astype(np.float32)

def build_audio(text, voice_path, language, normalize, progress_callback=None):
    segments = split_text(text)
    total = len(segments)
    wavs = []
    for index, segment in enumerate(segments):
        if progress_callback: progress_callback(index + 1, total)
        t0 = time.perf_counter()
        wav = synthesize_segment(segment, voice_path, language)
        dt = time.perf_counter() - t0
        audio_len = max(len(wav) / SAMPLE_RATE, 0.01)
        print(f"[Audio2Book] Segment {index + 1}/{total} | {dt:.1f}s de calcul pour {audio_len:.1f}s d'audio (RTF {dt / audio_len:.2f})")
        wavs.append(wav)
        if index < total - 1: wavs.append(np.zeros(int(SAMPLE_RATE * 0.25), dtype=np.float32))
    if not wavs: raise ValueError("Aucun audio genere.")
    full_audio = np.concatenate(wavs)
    if normalize: full_audio = peak_normalize(full_audio)
    return full_audio, total

def warmup():
    try:
        voices = list(VOICES_DIR.glob("*.wav"))
        if voices:
            print("[Audio2Book] Warmup GPU en cours...")
            synthesize_segment("Test.", voices[0], "fr")
            print("[Audio2Book] Warmup GPU termine.")
    except Exception as error: print(f"[Audio2Book] Warmup ignore : {error}")

def split_into_chapters(text: str, mode: str = "auto"):
    text = text.replace("\r\n", "\n")
    header_re = re.compile(r"^\s*(#{1,3}\s+|(chapitre|chapter|partie|part|livre|section)\s*\d*[.:\-–]?\s*.*)$", re.IGNORECASE)
    chapters, current_title, current_lines = [], None, []
    def flush():
        nonlocal current_title, current_lines
        content = "\n".join(current_lines).strip()
        if content: chapters.append({"title": (current_title or f"Chapitre {len(chapters) + 1}").strip(), "text": content})
        current_lines = []
    for line in text.split("\n"):
        if mode in ("auto", "headers") and header_re.match(line):
            flush()
            current_title = line.strip().lstrip("#").strip()
        else: current_lines.append(line)
    flush()
    if not chapters:
        paragraphs = re.split(r"\n\s*\n", text)
        current = ""
        for para in paragraphs:
            if len(current) + len(para) > 15000 and current:
                chapters.append({"title": f"Chapitre {len(chapters) + 1}", "text": current.strip()})
                current = para
            else: current = (current + "\n\n" + para).strip()
        if current.strip(): chapters.append({"title": f"Chapitre {len(chapters) + 1}", "text": current.strip()})
    return chapters

def process_tts_job(job: dict):
    def update_progress(current, total):
        with jobs_lock: job["progress"] = {"chapter_current": 1, "chapter_total": 1, "segment_current": current, "segment_total": total}
    full_audio, _ = build_audio(job["text"], job["voice_path"], job["language"], job["normalize"], progress_callback=update_progress)
    output_path = OUTPUT_DIR / f"{job['id']}.wav"
    sf.write(output_path, full_audio, SAMPLE_RATE)
    with jobs_lock:
        job["status"] = "completed"
        job["audio_url"] = f"/files/{job['id']}.wav"
        job["duration_seconds"] = round(len(full_audio) / SAMPLE_RATE, 2)

def process_book_job(job: dict):
    book_id = job["book_id"]
    book = load_book(book_id)
    if book is None: raise ValueError("Livre introuvable")
    voice_id = job.get("voice_id") or book.get("voice_id", "french_narrator")
    voice_path = VOICES_DIR / f"{voice_id}.wav"
    if not voice_path.exists(): raise ValueError(f"Voix introuvable : {voice_id}")
    pending = [c for c in book["chapters"] if c["status"] != "generated"]
    total_chapters = len(pending)
    with jobs_lock: job["progress"] = {"chapter_current": 0, "chapter_total": total_chapters, "segment_current": 0, "segment_total": 0}
    for index, chapter in enumerate(pending):
        print(f"[Audio2Book] Livre {book_id} : chapitre {index + 1}/{total_chapters}")
        def seg_cb(current, total, _index=index):
            with jobs_lock: job["progress"] = {"chapter_current": _index + 1, "chapter_total": total_chapters, "segment_current": current, "segment_total": total}
        try:
            audio, _ = build_audio(chapter["text"], voice_path, book.get("language", "fr"), True, progress_callback=seg_cb)
            bdir = book_dir(book_id); bdir.mkdir(parents=True, exist_ok=True)
            fname = f"chapter_{chapter['index']:03d}.wav"
            sf.write(bdir / fname, audio, SAMPLE_RATE)
            chapter["status"] = "generated"
            chapter["audio_file"] = fname
            chapter["duration_seconds"] = round(len(audio) / SAMPLE_RATE, 2)
            chapter["error"] = None
        except Exception as error:
            chapter["status"] = "error"
            chapter["error"] = str(error)
        save_book(book)
        with jobs_lock: job["progress"] = {"chapter_current": index + 1, "chapter_total": total_chapters, "segment_current": 0, "segment_total": 0}
    with jobs_lock:
        job["status"] = "completed"
        job["duration_seconds"] = sum(c.get("duration_seconds", 0) for c in book["chapters"])

def worker_loop():
    warmup()
    while True:
        job_id = job_queue.get()
        try:
            with jobs_lock:
                job = jobs.get(job_id)
                if job is None: continue
                job["status"] = "processing"
            if job.get("type") == "book": process_book_job(job)
            else: process_tts_job(job)
        except Exception as error:
            with jobs_lock:
                job = jobs.get(job_id)
                if job is not None:
                    job["status"] = "error"
                    job["error"] = str(error)
            print(f"[Audio2Book] Erreur job {job_id} : {error}")
        finally: job_queue.task_done()

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        load_model()
        threading.Thread(target=worker_loop, daemon=True).start()
        print("[Audio2Book] Worker demarre.")
    except Exception as error: print(f"[Audio2Book] ERREUR au chargement : {error}")
    yield

app = FastAPI(title="Audio2Book API", version="0.4.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.mount("/files", StaticFiles(directory=OUTPUT_DIR), name="files")
app.mount("/bookfiles", StaticFiles(directory=BOOKS_DIR), name="bookfiles")
app.mount("/voicefiles", StaticFiles(directory=VOICES_DIR), name="voicefiles")

class TTSRequest(BaseModel):
    text: str
    voice_id: str = "french_narrator"
    language: str = "fr"
    normalize: bool = True

class BookCreate(BaseModel):
    title: str
    author: str = ""
    voice_id: str = "french_narrator"
    language: str = "fr"

class ImportRequest(BaseModel):
    text: str
    split_mode: str = "auto"

class BookGenerateRequest(BaseModel):
    voice_id: str | None = None

class ExportRequest(BaseModel):
    format: str = "mp3"

@app.get("/")
def root():
    return {"software": "Audio2Book", "status": "running", "engine": "xtts-v2", "model_loaded": tts is not None}

@app.get("/api/health")
def health():
    import torch
    return {"status": "ok", "model_loaded": tts is not None, "cuda_available": torch.cuda.is_available(), "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None, "sample_rate": SAMPLE_RATE}

@app.get("/api/settings")
def get_settings(): return load_settings()

@app.post("/api/settings")
def update_settings(data: dict):
    save_settings(data)
    return {"status": "ok"}

@app.post("/api/open_folder")
def open_folder(data: dict):
    folder = data.get("folder", "outputs")
    path = BASE_DIR / folder
    if not path.exists(): path.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32": subprocess.Popen(f'explorer "{path}"')
    elif sys.platform == "darwin": subprocess.Popen(["open", str(path)])
    else: subprocess.Popen(["xdg-open", str(path)])
    return {"status": "opened"}

@app.get("/api/voices")
def list_voices():
    return {"voices": [{"id": v.stem, "url": f"/voicefiles/{v.name}"} for v in VOICES_DIR.glob("*.wav")]}

@app.post("/api/voices/upload")
async def upload_voice(voice_id: str = Form(...), file: UploadFile = File(...)):
    safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', voice_id.strip())
    out_path = VOICES_DIR / f"{safe_id}.wav"
    temp_path = TEMP_DIR / f"upload_{uuid.uuid4()}.ext"
    with open(temp_path, "wb") as f: f.write(await file.read())
    subprocess.run(["ffmpeg", "-y", "-i", str(temp_path), "-ar", "22050", "-ac", "1", str(out_path)], capture_output=True)
    temp_path.unlink(missing_ok=True)
    if not out_path.exists(): temp_path.rename(out_path)
    return {"status": "ok", "voice_id": safe_id}

@app.post("/api/voices/record")
async def record_voice(voice_id: str = Form(...), file: UploadFile = File(...)):
    safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', voice_id.strip())
    out_path = VOICES_DIR / f"{safe_id}.wav"
    temp_path = TEMP_DIR / f"record_{uuid.uuid4()}.webm"
    with open(temp_path, "wb") as f: f.write(await file.read())
    subprocess.run(["ffmpeg", "-y", "-i", str(temp_path), "-ar", "22050", "-ac", "1", str(out_path)], capture_output=True)
    temp_path.unlink(missing_ok=True)
    return {"status": "ok", "voice_id": safe_id}

@app.delete("/api/voices/{voice_id}")
def delete_voice(voice_id: str):
    path = VOICES_DIR / f"{voice_id}.wav"
    if path.exists(): path.unlink()
    return {"status": "deleted"}

@app.post("/api/tts")
def generate_tts(request: TTSRequest):
    if tts is None: raise HTTPException(503, "Modele non charge.")
    if not request.text.strip(): raise HTTPException(400, "Texte vide.")
    voice_path = VOICES_DIR / f"{request.voice_id}.wav"
    if not voice_path.exists(): raise HTTPException(404, f"Voix introuvable : {request.voice_id}")
    full_audio, total = build_audio(request.text, voice_path, request.language, request.normalize)
    generation_id = str(uuid.uuid4())
    output_path = OUTPUT_DIR / f"{generation_id}.wav"
    sf.write(output_path, full_audio, SAMPLE_RATE)
    return {"id": generation_id, "status": "completed", "audio_url": f"/files/{generation_id}.wav", "duration_seconds": round(len(full_audio) / SAMPLE_RATE, 2), "segments": total}

@app.post("/api/books")
def create_book(request: BookCreate):
    book = {"id": str(uuid.uuid4()), "title": request.title.strip(), "author": request.author.strip(), "voice_id": request.voice_id, "language": request.language, "created_at": time.strftime("%Y-%m-%d %H:%M:%S"), "chapters": []}
    save_book(book)
    return book

@app.get("/api/books")
def list_books():
    result = []
    for path in BOOKS_DIR.glob("*.json"):
        try:
            with open(path, "r", encoding="utf-8") as f: book = json.load(f)
            result.append({"id": book["id"], "title": book["title"], "author": book.get("author", ""), "voice_id": book.get("voice_id"), "created_at": book.get("created_at"), "chapters_total": len(book.get("chapters", [])), "chapters_generated": sum(1 for c in book.get("chapters", []) if c["status"] == "generated")})
        except Exception: continue
    return {"books": result}

@app.get("/api/books/{book_id}")
def get_book(book_id: str):
    book = load_book(book_id)
    if book is None: raise HTTPException(404, "Livre introuvable")
    return book

@app.delete("/api/books/{book_id}")
def delete_book(book_id: str):
    path = BOOKS_DIR / f"{book_id}.json"
    if not path.exists(): raise HTTPException(404, "Livre introuvable")
    path.unlink()
    shutil.rmtree(book_dir(book_id), ignore_errors=True)
    return {"status": "deleted"}

@app.post("/api/books/{book_id}/import")
def import_text(book_id: str, request: ImportRequest):
    book = load_book(book_id)
    if book is None: raise HTTPException(404, "Livre introuvable")
    parsed = split_into_chapters(request.text, request.split_mode)
    if not parsed: raise HTTPException(400, "Aucun chapitre detecte.")
    start = len(book["chapters"])
    for i, chapter in enumerate(parsed):
        book["chapters"].append({"index": start + i + 1, "title": chapter["title"], "text": chapter["text"], "status": "pending", "audio_file": None, "duration_seconds": None, "error": None})
    save_book(book)
    return {"status": "imported", "chapters_added": len(parsed), "book": book}

@app.post("/api/books/{book_id}/generate")
def generate_book(book_id: str, request: BookGenerateRequest):
    if tts is None: raise HTTPException(503, "Modele non charge.")
    book = load_book(book_id)
    if book is None: raise HTTPException(404, "Livre introuvable")
    pending = [c for c in book["chapters"] if c["status"] != "generated"]
    if not pending: raise HTTPException(400, "Tous les chapitres sont deja generes.")
    job_id = str(uuid.uuid4())
    job = {"id": job_id, "type": "book", "book_id": book_id, "status": "queued", "progress": {"chapter_current": 0, "chapter_total": len(pending), "segment_current": 0, "segment_total": 0}, "voice_id": request.voice_id, "audio_url": None, "duration_seconds": None, "error": None}
    with jobs_lock:
        jobs[job_id] = job
        book_job_ids[book_id] = job_id
    job_queue.put(job_id)
    return {"job_id": job_id, "status": "queued", "chapters": len(pending)}

@app.get("/api/books/{book_id}/progress")
def book_progress(book_id: str):
    with jobs_lock:
        job_id = book_job_ids.get(book_id)
        job = jobs.get(job_id) if job_id else None
        if job is None: return {"status": "idle", "progress": None}
        return {"status": job["status"], "progress": job["progress"], "error": job["error"]}

@app.post("/api/books/{book_id}/export")
def export_book(book_id: str, request: ExportRequest):
    book = load_book(book_id)
    if book is None: raise HTTPException(404, "Livre introuvable")
    bdir = book_dir(book_id)
    generated = [c for c in book["chapters"] if c["status"] == "generated" and c.get("audio_file")]
    if not generated: raise HTTPException(400, "Aucun chapitre genere.")
    wavs = []
    for chapter in generated:
        data, sr = sf.read(bdir / chapter["audio_file"], dtype="float32")
        wavs.append(data)
        wavs.append(np.zeros(int(SAMPLE_RATE * 0.7), dtype=np.float32))
    full_audio = np.concatenate(wavs)
    peak_normalize(full_audio)
    export_dir = bdir / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^a-z0-9]+", "-", book["title"].lower()).strip("-") or "livre"
    wav_path = export_dir / f"{slug}.wav"
    sf.write(wav_path, full_audio, SAMPLE_RATE)
    out_path = wav_path
    if request.format == "mp3":
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            mp3_path = export_dir / f"{slug}.mp3"
            cmd = [ffmpeg, "-y", "-i", str(wav_path), "-b:a", "192k", "-metadata", f"title={book['title']}", "-metadata", f"artist={book.get('author') or 'Audio2Book'}", str(mp3_path)]
            if subprocess.run(cmd, capture_output=True, text=True).returncode == 0:
                out_path = mp3_path
    relative = out_path.relative_to(BOOKS_DIR).as_posix()
    return {"status": "exported", "format": out_path.suffix.lstrip("."), "url": f"/bookfiles/{relative}", "path": str(out_path), "size_mb": round(out_path.stat().st_size / 1_000_000, 2), "duration_seconds": round(len(full_audio) / SAMPLE_RATE, 2)}