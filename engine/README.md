# WaveWeaver Engine

The Python tool host behind [WaveWeaver Studio](../studio). The
studio does editing with ffmpeg directly; anything ffmpeg can't do well —
speech recognition, translation, learned noise reduction, reference
mastering, hosting your VST3 plugins, source separation — lives here, one
plugin per file.

The studio starts the engine for you the first time a page needs it. You
only set it up once.

## Setup

```sh
# from the repository root
python -m venv .venv
.venv/Scripts/pip install -r engine/requirements.txt      # Windows
# .venv/bin/pip install -r engine/requirements.txt        # macOS / Linux

# NVIDIA GPU (optional, 10–30x faster Whisper/NLLB):
.venv/Scripts/pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12>=9,<10"

# Offline translation weights (optional, ~1.4 GB, non-commercial licence):
.venv/Scripts/python -m engine.download nllb
```

Run it by hand (the studio does this automatically):

```sh
.venv/Scripts/python -m engine          # http://127.0.0.1:8765
```

On start it prints every tool and whether it's ready:

```txt
  ■ denoise        Noise reduction
  □ stems          Separate stems  — Missing demucs, torch. Install: pip install demucs
```

The GPU is probed once, in a child process (a missing cuDNN aborts a
process rather than raising), and the answer is cached in
`models/device.json`. Delete that file to re-probe; set
`WAVEWEAVER_DEVICE=cpu` to force the CPU.

## Tools

| id | What it does | Built on | Licence |
| --- | --- | --- | --- |
| `transcribe` | Speech → timed text, ~100 languages, word timestamps; can translate straight to English | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (Whisper on CTranslate2) | MIT |
| `translate` | Caption cues → another language, timing kept. Claude reads whole scenes; NLLB runs offline | [Claude](https://docs.anthropic.com) (Anthropic API) · [NLLB-200](https://huggingface.co/OpenNMT/nllb-200-distilled-1.3B-ct2-int8) on CTranslate2 | API · **CC-BY-NC-4.0 weights** |
| `vad` | Where is someone talking? Drives the studio's speech-aware jump cut | [Silero VAD](https://github.com/snakers4/silero-vad) via faster-whisper | MIT |
| `denoise` | Spectral-gating noise reduction from a learned noise sample (select a gap) | [noisereduce](https://github.com/timsainb/noisereduce) | MIT |
| `fx` | Reverb, delay, chorus, phaser, drive, bitcrush, Rubber Band pitch shift | [pedalboard](https://github.com/spotify/pedalboard) (JUCE) | GPLv3 |
| `vst` | Run any installed VST3 effect with settings saved from its own window | pedalboard | GPLv3 + your plugins |
| `match` | Reference mastering: match loudness, tone and width to a track you like | [Matchering 2](https://github.com/sergree/matchering) | GPLv3 |
| `stems` | Vocals / drums / bass / other separation *(optional — needs PyTorch)* | [Demucs v4](https://github.com/facebookresearch/demucs) | MIT |
| `deepfilter` | Neural speech enhancement: noise *and* room echo *(optional — needs PyTorch)* | [DeepFilterNet 3](https://github.com/Rikorose/DeepFilterNet) | MIT/Apache-2.0 |

Everything that's plain DSP — EQ, compression, limiting, gating, de-essing,
de-hum, loudness normalisation, mixing and ducking — stays in the studio's
one-pass ffmpeg graphs, where it's faster and previewable for free.

### The open-source landscape, and why these

- **Speech recognition.** Whisper is still the open baseline; faster-whisper
  is the fastest faithful runtime and bundles Silero VAD, which suppresses
  Whisper's habit of inventing text over silence and music. WhisperX adds
  forced alignment and diarisation on top (a good next plugin, via
  pyannote, which needs a Hugging Face token).
- **Translation.** For subtitles, an LLM that sees whole scenes beats
  sentence-by-sentence MT on coherence and line length — that's the Claude
  provider. For fully offline use, Meta's NLLB-200 covers 200 languages;
  the 1.3B distilled model on CTranslate2 runs on the same runtime Whisper
  already uses, so it adds no new dependency.
- **Noise.** Classic spectral gating (noisereduce) is predictable and fast
  with a learned profile. Neural enhancers (DeepFilterNet 3, or RNNoise via
  ffmpeg's `arnndn` with a model file) handle non-stationary noise and
  reverb far better — at the cost of PyTorch.
- **Mastering.** Matchering is the established open reference-matcher. The
  studio's presets cover the rule-based side (EQ → comp → limiter →
  two-pass EBU R128).
- **Effects & plugins.** Spotify's pedalboard is the best-maintained Python
  DSP host and the only one that loads VST3/AU plugins headlessly — so your
  FabFilter, Neural DSP or Waves plugins become WaveWeaver tools.

## Writing a plugin

Drop a file into `engine/tools/` (or the folder named by
`WAVEWEAVER_PLUGINS`, default `plugins/` at the repository root) and restart the
engine — or press **Rescan** in the Desk's Lab. The studio builds the form
from your `params`; previews and full renders work automatically.

```python
# plugins/telephone.py
import numpy as np
from engine.registry import Param, Tool
from engine.tools._common import process_audio


def run(ctx):
    from scipy.signal import butter, sosfilt  # heavy imports inside run()

    sos = butter(4, [ctx.params["low"], ctx.params["high"]], btype="band", fs=48000, output="sos")
    # Carry the filter's state from block to block, or every block boundary clicks.
    state = np.zeros((sos.shape[0], 2, 2))

    def fn(block: np.ndarray) -> np.ndarray:  # (channels, frames) float32 @ 48 kHz
        nonlocal state
        out, state = sosfilt(sos, block, axis=1, zi=state)
        return out.astype(np.float32)

    return process_audio(ctx, "telephone", fn)


TOOL = Tool(
    id="telephone",
    label="Telephone",
    group="fx",
    blurb="Band-limit to sound like a phone call.",
    run=run,
    requires=["scipy"],
    params=[
        Param("low", "Low", "number", 300, min=100, max=1000, step=10, unit="Hz"),
        Param("high", "High", "number", 3400, min=2000, max=8000, step=100, unit="Hz"),
    ],
)
```

What `ctx` gives you:

| | |
| --- | --- |
| `ctx.input`, `ctx.info` | the source path and a probe (duration, has_video, …) |
| `ctx.params` | your params, already validated and clamped |
| `ctx.excerpt` | `(start, duration)` when this is a preview run, else `None` |
| `ctx.progress(ratio, phase)`, `ctx.log(line)` | show up live in the studio |
| `ctx.check()` | call between units of work; raises when the job is cancelled |
| `ctx.spawn(args)` | start a subprocess that's killed if the job is cancelled |
| `ctx.output_path(tag)` | where to write (preview `b.wav`, or `<stem>-<tag>-<stamp>.<ext>`) |

`process_audio(ctx, tag, fn)` covers the common case: it streams the input
through `fn` in 10-second blocks (constant memory for any length), writes
WAV for previews, and for renders keeps the input's format — a cleaned
`.mp4` stays an `.mp4` with its picture stream-copied. Pass
`context_seconds` for stateless processors that need audio around each
block, and `flush` for ones with latency (see `tools/vst.py`).

Data tools (like `transcribe`) set `output="data"` and return
`{"data": {...}}` instead of files.

## HTTP API

The studio is the only client. Everything binds to `127.0.0.1`.

| | |
| --- | --- |
| `GET /health` | version, device, how many tools are ready |
| `GET /tools`, `POST /tools/rescan` | the catalogue the studio renders forms from |
| `POST /jobs` | `{tool, input:{bin,kind,name}, params, excerpt?, output:{mode:"render"\|"preview"\|"data"}}` |
| `GET /jobs/{id}?since=n` | status, progress, log lines after the first *n* |
| `DELETE /jobs/{id}` | cancel (kills child processes) |
| `GET /vst/plugins`, `POST /vst/editor` | installed VST3s; open one's window and save its state |

## Downloads (yt-dlp)

The studio's Downloads page doesn't go through the HTTP server. For every
download (and every link it reads) it starts `engine/fetch.py` directly,
the way it starts ffmpeg:

```sh
.venv/Scripts/python -m engine.fetch      # first stdin line: the job, as JSON
```

The worker drives [yt-dlp](https://github.com/yt-dlp/yt-dlp) through its
Python API — progress and postprocessor hooks, a `YoutubeDL` that refuses
to write outside its work folder — and answers with one JSON object per
stdout line (`@ww {"event": "progress", …}`). After the job line, stdin is
a control channel: `stop` asks yt-dlp to wrap up (a live recording's ffmpeg
is sent `q`, so the file is closed properly), and end-of-file does the
same, so a download never outlives the studio.

| `cmd` | |
| --- | --- |
| `probe` | read a link: a video's formats (and which ones `format` picks), captions, chapters; a playlist's entries |
| `select` | re-run format selection on an earlier probe's info dict, offline |
| `download` | download one URL into `workdir` |
| `version` | yt-dlp, yt-dlp-ejs and Python versions |

YouTube needs a JavaScript runtime for its player challenges; the studio
passes its own Node (`WAVEWEAVER_NODE`), so nothing else is required.
Everything else — the queue, file names, bins, subscriptions — lives in the
studio (`src/lib/server/downloads.ts`).

## Layout

```txt
engine/
  app.py        HTTP routes
  fetch.py      yt-dlp worker for the Downloads page (started per job, not a route)
  registry.py   Tool / Param, discovery, readiness checks
  jobs.py       thread-pool jobs with cancellation
  context.py    what run() receives
  media.py      ffmpeg ⇄ numpy streaming, loudness metering
  gpu.py        one-time CUDA probe in a child process
  download.py   model weights
  tools/        one module per tool
```

The older FastAPI app in `../app/` (v2) is untouched and still runs on its
own; the studio doesn't use it.

## Lock files

The desktop app's Setup installs `requirements.lock` and `requirements-gpu.lock`:
exact versions, checked by hash, wheels only. yt-dlp stays out of them on purpose,
because it has to keep up with sites changing. After changing `requirements.txt`,
regenerate both from this folder:

```bash
grep -v '^yt-dlp' requirements.txt > locked.in
uv pip compile locked.in --python-version 3.11 --python-platform windows --generate-hashes --no-header --no-annotate -o requirements.lock
printf 'nvidia-cublas-cu12
nvidia-cudnn-cu12>=9,<10
' > gpu.in
uv pip compile gpu.in -c requirements.lock --python-version 3.11 --python-platform windows --generate-hashes --no-header --no-annotate -o requirements-gpu.lock
rm locked.in gpu.in
```
