# Audio2Book

**Studio de livres audio local propulsé par XTTS-v2**

Générez des livres audio avec des voix réalistes, 100% hors ligne sur votre GPU NVIDIA.

##  Fonctionnalités

-  **100% Local** — Aucune donnée ne quitte votre machine
-  **Voix Réalistes** — Propulsé par XTTS-v2 avec clonage de voix
-  **Mode Livre Audio** — Gestion de chapitres, import .txt, export MP3 avec métadonnées
-  **Interface Moderne** — Thèmes clair/sombre, visualisation audio
-  **Accéléré GPU** — Optimisé pour NVIDIA RTX
-  **Privacy First** — Votre texte et vos voix restent chez vous

<img width="1 132" height="651" alt="Capture d&#39;écran 2026-09-20 103921" src="https://github.com/user-attachments/assets/080f4fd9-3ae8-406a-afc2-6242aba8c2bf" />

##  Stack Technique

- **Backend**: Python 3.11 + FastAPI + XTTS-v2
- **Frontend**: React + TypeScript + Tailwind CSS
- **Desktop**: Tauri 2 (Rust)
- **Audio**: FFmpeg + SoundFile

##  Installation

### Prérequis
- Python 3.11
- Node.js 18+
- GPU NVIDIA avec support CUDA
- FFmpeg installé

### Setup

```bash
# Cloner le repo
git clone https://github.com/spectglak-ui/audio2book.git
cd audio2book

# Backend
cd backend
python -m venv .venv
.venv\Scripts\activate  # Windows
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install

# Lancer l'app
npm run tauri dev
