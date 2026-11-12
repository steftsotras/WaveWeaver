# WaveWeaver

A local studio for everyday audio and video work. Drop files into bins, stack
up edits (trim, jump-cut the pauses, EQ, compress, de-hum, normalise
loudness, reframe for vertical) and render them in **one** ffmpeg pass.
Transcribe, edit, translate and burn in subtitles. Mix voice over music with
automatic ducking. Master with presets or against a reference track. Run your
own VST3 plugins. Download from YouTube and other sites with yt-dlp.

**Everything previews first.** Before a tool touches a two-hour file, run it
on a short window and A/B the result against the original, sample-locked,
with loudness numbers for both sides.

Everything runs on your machine. No accounts, no cloud, no database: your
media stays in plain folders you can open in Explorer or Finder.

## Repository layout

```txt
studio/     SvelteKit app and Electron desktop shell (ffmpeg-driven editing)
engine/     Python tool host: Whisper, NLLB translation, VAD, noise reduction,
            reference mastering, VST3 hosting, yt-dlp worker
plugins/    example engine plugin; drop your own .py tools here
```

## Quick start (from source)

Requirements: Node 22+, ffmpeg 7+ on `PATH`, and Python 3.10+ for the engine
(optional: editing, mixing, presets and previews work without it).

```sh
# engine (optional), from the repository root
python -m venv .venv
.venv/Scripts/pip install -r engine/requirements.txt   # Windows
# .venv/bin/pip install -r engine/requirements.txt     # macOS / Linux

# studio
cd studio
npm install
npm run dev        # http://localhost:5190
```

The studio starts the engine on demand from `.venv` at the repository root.

## Desktop app (Windows)

```sh
cd studio
npm install
npm run dist       # studio/dist/WaveWeaver-Setup-1.0.0.exe
```

The installer bundles no ffmpeg, Python or models. On first launch, **Setup**
lets each user pick a media folder and a models folder, and installs ffmpeg, a
private Python, the engine tools, GPU support and model weights from pinned,
hash-checked sources. The installer is not code-signed yet, so Windows
SmartScreen warns on first run.

## Documentation

- [studio/README.md](studio/README.md): features, media layout, architecture
  and style notes
- [engine/README.md](engine/README.md): engine setup, tools and writing a
  plugin

## Licences and credits

WaveWeaver is licensed under the [GNU Affero General Public License v3.0](LICENSE).

- The Downloads page is modelled on [MeTube](https://github.com/alexta69/metube)
  (AGPL-3.0) and built on [yt-dlp](https://github.com/yt-dlp/yt-dlp).
- Model weights are downloaded separately and keep their own licences. The
  NLLB-200 translation weights are **non-commercial** (CC-BY-NC-4.0).
