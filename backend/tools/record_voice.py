import sounddevice as sd
import soundfile as sf
from pathlib import Path

SAMPLE_RATE = 22050
SECONDS = 12

output_path = Path(__file__).resolve().parent.parent / "voices" / "xtts" / "french_narrator.wav"
output_path.parent.mkdir(parents=True, exist_ok=True)

print("=" * 60)
print("Enregistrement dans 3 secondes...")
print("Lis un texte francais a voix haute, clairement.")
print("Exemple : 'Bonjour, je teste Audio2Book.'")
print("=" * 60)
sd.sleep(3000)

print("🎙️ ENREGISTREMENT EN COURS... Parle maintenant !")
audio = sd.rec(int(SECONDS * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="float32")
sd.wait()

sf.write(output_path, audio, SAMPLE_RATE)
print(f"✅ Voix enregistree : {output_path}")