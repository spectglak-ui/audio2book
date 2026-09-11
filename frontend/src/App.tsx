import "./App.css";
import { useState, useEffect, useRef } from "react";
import logo from "./assets/logo.png";

const API_URL = "http://127.0.0.1:8000";
type View = "studio" | "books" | "voices" | "settings";

function App() {
  const [view, setView] = useState<View>("studio");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [defaultFormat, setDefaultFormat] = useState("mp3");
  
  const [voices, setVoices] = useState<{id: string, url: string}[]>([]);
  const [selectedVoice, setSelectedVoice] = useState("french_narrator");
  const [health, setHealth] = useState<{ ok: boolean; gpu: string | null; loaded: boolean }>({ ok: false, gpu: null, loaded: false });

  const [studioText, setStudioText] = useState("");
  const [studioLoading, setStudioLoading] = useState(false);
  const [studioAudioUrl, setStudioAudioUrl] = useState<string | null>(null);

  const [books, setBooks] = useState<any[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [newBookTitle, setNewBookTitle] = useState("");
  const [importText, setImportText] = useState("");
  const [bookGenerating, setBookGenerating] = useState(false);
  const [bookProgress, setBookProgress] = useState<{ current: number; total: number } | null>(null);

  const [newVoiceName, setNewVoiceName] = useState("");
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedBook = books.find((b: any) => b.id === selectedBookId) || null;

  useEffect(() => {
    fetch(`${API_URL}/api/settings`).then(r => r.json()).then(d => {
      setTheme(d.theme || "dark");
      setDefaultFormat(d.default_format || "mp3");
    }).catch(() => {});
    
    fetchVoices();
    
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch(`${API_URL}/api/health`);
        const d = await r.json();
        if (alive) setHealth({ ok: true, gpu: d.gpu_name, loaded: !!d.model_loaded });
      } catch { if (alive) setHealth({ ok: false, gpu: null, loaded: false }); }
    };
    check();
    const timer = setInterval(check, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (theme === "dark") document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
    
    fetch(`${API_URL}/api/settings`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme, default_format: defaultFormat })
    }).catch(() => {});
  }, [theme, defaultFormat]);

  const fetchVoices = async () => {
    try {
      const r = await fetch(`${API_URL}/api/voices`);
      const d = await r.json();
      setVoices(d.voices);
      if (d.voices.length > 0 && !d.voices.find((v: any) => v.id === selectedVoice)) {
        setSelectedVoice(d.voices[0].id);
      }
    } catch (e) { console.error(e); }
  };

  const fetchBooks = async () => {
    try {
      const r = await fetch(`${API_URL}/api/books`);
      const d = await r.json();
      const detailed = await Promise.all(d.books.map(async (b: any) => {
        const res = await fetch(`${API_URL}/api/books/${b.id}`);
        return await res.json();
      }));
      setBooks(detailed);
    } catch (e) { console.error(e); }
  };
  useEffect(() => { fetchBooks(); }, []);

  async function generateStudio() {
    if (!studioText.trim()) return;
    setStudioLoading(true); setStudioAudioUrl(null);
    try {
      const r = await fetch(`${API_URL}/api/tts`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: studioText, voice_id: selectedVoice, language: "fr", normalize: true })
      });
      const d = await r.json();
      setStudioAudioUrl(`${API_URL}${d.audio_url}`);
    } catch (e) { console.error(e); } finally { setStudioLoading(false); }
  }

  async function createBook() {
    if (!newBookTitle.trim()) return;
    await fetch(`${API_URL}/api/books`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newBookTitle, author: "", voice_id: selectedVoice })
    });
    setNewBookTitle("");
    await fetchBooks();
  }

  async function importBookText() {
    if (!selectedBook || !importText.trim()) return;
    await fetch(`${API_URL}/api/books/${selectedBook.id}/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: importText, split_mode: "auto" })
    });
    setImportText("");
    await fetchBooks();
  }

  async function generateBook() {
    if (!selectedBook) return;
    setBookGenerating(true);
    setBookProgress({ current: 0, total: selectedBook.chapters.filter((c: any) => c.status !== "generated").length });
    await fetch(`${API_URL}/api/books/${selectedBook.id}/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_id: selectedVoice })
    });
    const poll = setInterval(async () => {
      const r = await fetch(`${API_URL}/api/books/${selectedBook.id}/progress`);
      const d = await r.json();
      if (d.status === "completed" || d.status === "error" || d.status === "idle") {
        clearInterval(poll);
        setBookGenerating(false);
        setBookProgress(null);
        await fetchBooks();
      } else if (d.progress) {
        setBookProgress({ current: d.progress.chapter_current, total: d.progress.chapter_total });
      }
    }, 1500);
  }

  async function exportBook(format: string) {
    if (!selectedBook) return;
    const r = await fetch(`${API_URL}/api/books/${selectedBook.id}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format })
    });
    const d = await r.json();
    if (d.url) {
      const res = await fetch(`${API_URL}${d.url}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${selectedBook.title}.${format}`;
      a.click(); URL.revokeObjectURL(url);
    }
  }

  async function deleteBook(id: string) {
    if (!confirm("Supprimer ce livre ?")) return;
    await fetch(`${API_URL}/api/books/${id}`, { method: "DELETE" });
    if (selectedBookId === id) setSelectedBookId(null);
    await fetchBooks();
  }

  async function uploadVoiceFile(file: File) {
    if (!newVoiceName.trim()) { alert("Donnez un nom à la voix"); return; }
    const formData = new FormData();
    formData.append("voice_id", newVoiceName);
    formData.append("file", file);
    await fetch(`${API_URL}/api/voices/upload`, { method: "POST", body: formData });
    setNewVoiceName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    fetchVoices();
  }

  const startRecording = async () => {
    if (!newVoiceName.trim()) { alert("Donnez un nom à la voix"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("voice_id", newVoiceName);
        formData.append("file", blob, "recording.webm");
        await fetch(`${API_URL}/api/voices/record`, { method: "POST", body: formData });
        stream.getTracks().forEach(t => t.stop());
        setNewVoiceName("");
        fetchVoices();
      };
      mediaRecorder.start();
      setRecording(true);
    } catch (e) { alert("Impossible d'accéder au microphone."); }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  async function deleteVoice(id: string) {
    if (!confirm(`Supprimer la voix ${id} ?`)) return;
    await fetch(`${API_URL}/api/voices/${id}`, { method: "DELETE" });
    fetchVoices();
  }

  async function openOutputsFolder() {
    await fetch(`${API_URL}/api/open_folder`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: "outputs" })
    });
  }

  const bgMain = theme === "dark" ? "bg-zinc-950 text-white" : "bg-zinc-100 text-zinc-900";
  const bgSidebar = theme === "dark" ? "bg-zinc-900 border-white/5" : "bg-white border-zinc-200";
  const bgCard = theme === "dark" ? "bg-zinc-900/50 border-white/10" : "bg-white border-zinc-200";
  const bgInput = theme === "dark" ? "bg-zinc-950 border-white/10 text-white" : "bg-zinc-50 border-zinc-300 text-zinc-900";
  const textMuted = theme === "dark" ? "text-zinc-400" : "text-zinc-500";

  return (
    <div className={`flex h-screen ${bgMain} font-sans overflow-hidden transition-colors duration-300`}>
      <aside className={`w-64 ${bgSidebar} border-r flex flex-col p-4 transition-colors`}>
        <div className="flex items-center gap-3 mb-8 px-2">
          <img src={logo} alt="Logo" className="h-10 w-10 rounded-xl" />
          <h1 className="text-xl font-bold bg-gradient-to-r from-orange-400 to-orange-600 bg-clip-text text-transparent">Audio2Book</h1>
        </div>
        <nav className="flex-1 space-y-2">
          {[
            { id: "studio", label: "Studio Rapide", icon: "M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" },
            { id: "books", label: "Livres Audio", icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" },
            { id: "voices", label: "Gestion des Voix", icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" },
            { id: "settings", label: "Paramètres", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" }
          ].map(item => (
            <button key={item.id} onClick={() => setView(item.id as View)} className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition ${view === item.id ? "bg-orange-500/10 text-orange-500" : `${textMuted} hover:bg-black/5 dark:hover:bg-white/5`}`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={item.icon} /></svg>
              {item.label}
            </button>
          ))}
        </nav>
        <div className={`mt-auto p-3 rounded-xl ${theme === "dark" ? "bg-zinc-800/50 border-white/5" : "bg-zinc-100 border-zinc-200"} border text-xs`}>
          <div className="flex items-center gap-2 mb-1">
            <span className={`h-2 w-2 rounded-full ${health.ok && health.loaded ? "bg-green-500" : "bg-red-500"}`} />
            <span className={textMuted}>Moteur XTTS-v2</span>
          </div>
          <p className={`${textMuted} truncate`}>{health.gpu || "Hors ligne"}</p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-8">
        {!health.ok && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500">Backend introuvable.</div>
        )}

        {view === "studio" && (
          <div className="max-w-4xl mx-auto space-y-6">
            <h2 className="text-2xl font-bold">Studio Rapide</h2>
            <div className={`rounded-2xl border ${bgCard} p-6`}>
              <textarea value={studioText} onChange={(e) => setStudioText(e.target.value)} placeholder="Collez un court texte pour tester une voix..." className={`w-full h-40 rounded-xl ${bgInput} border p-4 text-sm outline-none focus:ring-2 focus:ring-orange-500 resize-none mb-4`} />
              <div className="flex gap-4 items-end">
                <div className="flex-1">
                  <label className={`block text-xs ${textMuted} mb-1`}>Voix</label>
                  <select value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)} className={`w-full rounded-lg ${bgInput} border px-3 py-2 text-sm`}>
                    {voices.map(v => <option key={v.id} value={v.id}>{v.id}</option>)}
                  </select>
                </div>
                <button onClick={generateStudio} disabled={studioLoading || !studioText.trim()} className="px-6 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold disabled:opacity-50 transition">
                  {studioLoading ? "Génération..." : "Générer"}
                </button>
              </div>
            </div>
            {studioAudioUrl && (
              <div className={`rounded-2xl border ${bgCard} p-6`}>
                <audio controls src={studioAudioUrl} className="w-full" />
              </div>
            )}
          </div>
        )}

        {view === "books" && !selectedBook && (
          <div className="max-w-4xl mx-auto space-y-6">
            <h2 className="text-2xl font-bold">Mes Livres Audio</h2>
            <div className={`rounded-2xl border ${bgCard} p-6`}>
              <h3 className="text-lg font-semibold mb-4">Créer un nouveau livre</h3>
              <div className="flex gap-4 mb-4">
                <input value={newBookTitle} onChange={e => setNewBookTitle(e.target.value)} placeholder="Titre du livre" className={`flex-1 rounded-lg ${bgInput} border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500`} />
                <button onClick={createBook} disabled={!newBookTitle.trim()} className="px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold disabled:opacity-50 transition">Créer</button>
              </div>
            </div>
            <div className="space-y-3">
              {books.length === 0 && <p className={`${textMuted} text-center py-8`}>Aucun livre pour le moment.</p>}
              {books.map((book: any) => (
                <div key={book.id} onClick={() => setSelectedBookId(book.id)} className={`rounded-xl border ${bgCard} p-4 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition flex justify-between items-center`}>
                  <div>
                    <h4 className="font-semibold">{book.title}</h4>
                    <p className={`text-xs ${textMuted}`}>{book.author} • {book.chapters.length} chapitres</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-orange-500">{book.chapters.filter((c: any) => c.status === "generated").length}/{book.chapters.length} générés</span>
                    <button onClick={(e) => { e.stopPropagation(); deleteBook(book.id); }} className="text-red-500 hover:text-red-400 text-xs">Suppr.</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "books" && selectedBook && (
          <div className="max-w-4xl mx-auto space-y-6">
            <button onClick={() => setSelectedBookId(null)} className={`text-sm ${textMuted} hover:text-orange-500 flex items-center gap-1`}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg> Retour aux livres
            </button>
            <div className="flex justify-between items-start">
              <div>
                <h2 className="text-2xl font-bold">{selectedBook.title}</h2>
                <p className={textMuted}>{selectedBook.author}</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => exportBook(defaultFormat)} disabled={bookGenerating || selectedBook.chapters.filter((c: any) => c.status === "generated").length === 0} className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold disabled:opacity-50 transition">Exporter {defaultFormat.toUpperCase()}</button>
                <button onClick={generateBook} disabled={bookGenerating || selectedBook.chapters.filter((c: any) => c.status !== "generated").length === 0} className="px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold disabled:opacity-50 transition">
                  {bookGenerating ? `Génération ${bookProgress?.current}/${bookProgress?.total}...` : "Générer les chapitres"}
                </button>
              </div>
            </div>
            {bookGenerating && bookProgress && (
              <div className="rounded-xl border border-orange-500/30 bg-orange-500/10 p-4">
                <div className="flex justify-between mb-2 text-sm">
                  <span>Chapitre {bookProgress.current} sur {bookProgress.total}</span>
                  <span>{Math.round((bookProgress.current / bookProgress.total) * 100)}%</span>
                </div>
                <div className={`h-2 rounded-full ${theme === "dark" ? "bg-zinc-800" : "bg-zinc-200"} overflow-hidden`}>
                  <div className="h-full bg-orange-500 transition-all" style={{ width: `${(bookProgress.current / bookProgress.total) * 100}%` }} />
                </div>
              </div>
            )}
            <div className={`rounded-2xl border ${bgCard} p-6`}>
              <h3 className="text-lg font-semibold mb-4">Importer du texte</h3>
              <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Collez ici le texte de votre livre..." className={`w-full h-32 rounded-xl ${bgInput} border p-4 text-sm outline-none focus:ring-2 focus:ring-orange-500 resize-none mb-4`} />
              <button onClick={importBookText} disabled={!importText.trim()} className={`px-4 py-2 rounded-lg ${theme === "dark" ? "bg-zinc-700 hover:bg-zinc-600" : "bg-zinc-200 hover:bg-zinc-300"} font-semibold disabled:opacity-50 transition`}>Importer et découper</button>
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-semibold">Chapitres ({selectedBook.chapters.length})</h3>
              {selectedBook.chapters.map((ch: any) => (
                <div key={ch.index} className={`rounded-xl border ${theme === "dark" ? "border-white/5 bg-zinc-900/30" : "border-zinc-200 bg-zinc-50"} p-4 flex justify-between items-center`}>
                  <div>
                    <h4 className="font-medium">{ch.title}</h4>
                    <p className={`text-xs ${textMuted} truncate max-w-md`}>{ch.text.slice(0, 100)}...</p>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full ${ch.status === "generated" ? "bg-green-500/20 text-green-500" : ch.status === "error" ? "bg-red-500/20 text-red-500" : `${theme === "dark" ? "bg-zinc-700 text-zinc-400" : "bg-zinc-200 text-zinc-500"}`}`}>
                    {ch.status === "generated" ? "Généré" : ch.status === "error" ? "Erreur" : "En attente"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "voices" && (
          <div className="max-w-4xl mx-auto space-y-6">
            <h2 className="text-2xl font-bold">Gestion des Voix</h2>
            <div className={`rounded-2xl border ${bgCard} p-6`}>
              <h3 className="text-lg font-semibold mb-4">Ajouter une nouvelle voix</h3>
              <input value={newVoiceName} onChange={e => setNewVoiceName(e.target.value)} placeholder="Nom de la voix (ex: voix_narrateur)" className={`w-full rounded-lg ${bgInput} border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500 mb-4`} />
              <div className="flex gap-3">
                <input type="file" accept="audio/*" ref={fileInputRef} onChange={(e) => e.target.files?.[0] && uploadVoiceFile(e.target.files[0])} className="hidden" id="voice-upload" />
                <label htmlFor="voice-upload" className={`px-4 py-2 rounded-lg ${theme === "dark" ? "bg-zinc-700 hover:bg-zinc-600" : "bg-zinc-200 hover:bg-zinc-300"} cursor-pointer font-semibold transition text-center`}>Importer un fichier audio</label>
                {recording ? (
                  <button onClick={stopRecording} className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold transition flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-white animate-pulse" /> Arrêter l'enregistrement
                  </button>
                ) : (
                  <button onClick={startRecording} className="px-4 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold transition">Enregistrer avec le micro</button>
                )}
              </div>
            </div>
            <div className="space-y-3">
              <h3 className="text-lg font-semibold">Voix disponibles ({voices.length})</h3>
              {voices.map(v => (
                <div key={v.id} className={`rounded-xl border ${bgCard} p-4 flex justify-between items-center`}>
                  <div className="flex items-center gap-4">
                    <audio controls src={`${API_URL}${v.url}`} className="h-8 w-64" />
                    <span className="font-medium">{v.id}</span>
                  </div>
                  <button onClick={() => deleteVoice(v.id)} className="text-red-500 hover:text-red-400 text-sm">Supprimer</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {view === "settings" && (
          <div className="max-w-2xl mx-auto space-y-6">
            <h2 className="text-2xl font-bold">Paramètres</h2>
            <div className={`rounded-2xl border ${bgCard} p-6 space-y-6`}>
              <div>
                <h3 className="text-lg font-semibold mb-3">Apparence</h3>
                <div className="flex gap-4">
                  <button onClick={() => setTheme("dark")} className={`flex-1 p-4 rounded-xl border-2 transition ${theme === "dark" ? "border-orange-500 bg-zinc-800 text-white" : "border-transparent bg-zinc-200 text-zinc-900"}`}><div className="text-center font-semibold">Sombre</div></button>
                  <button onClick={() => setTheme("light")} className={`flex-1 p-4 rounded-xl border-2 transition ${theme === "light" ? "border-orange-500 bg-white text-zinc-900" : "border-transparent bg-zinc-200 text-zinc-900"}`}><div className="text-center font-semibold">Clair</div></button>
                </div>
              </div>
              <div>
                <h3 className="text-lg font-semibold mb-3">Export par défaut</h3>
                <select value={defaultFormat} onChange={(e) => setDefaultFormat(e.target.value)} className={`w-full rounded-lg ${bgInput} border px-3 py-2 text-sm`}>
                  <option value="mp3">MP3 (Recommandé, léger)</option>
                  <option value="wav">WAV (Haute qualité, lourd)</option>
                </select>
              </div>
              <div>
                <h3 className="text-lg font-semibold mb-3">Dossiers</h3>
                <button onClick={openOutputsFolder} className={`w-full p-3 rounded-lg ${theme === "dark" ? "bg-zinc-800 hover:bg-zinc-700 text-white" : "bg-zinc-200 hover:bg-zinc-300 text-zinc-900"} font-semibold transition flex items-center justify-center gap-2`}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                  Ouvrir le dossier des exports
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;