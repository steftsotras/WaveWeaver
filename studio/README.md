# WaveWeaver Studio

A local SvelteKit studio for everyday audio and video work. Drop files into
bins, open one on the Desk, stack up edits — trim, jump-cut the pauses, EQ,
compress, de-hum, normalise loudness, reframe for vertical — and render it all
in **one** ffmpeg pass. Transcribe, edit, translate and burn in subtitles.
Mix voice over music with automatic ducking. Master with presets or against a
reference track. Run your own VST3 plugins.

**Everything previews first.** Before a tool touches a two-hour file, run it
on a short window and A/B the result against the original — sample-locked,
with loudness numbers for both sides.

## Desktop app

`npm run dist` builds `dist/WaveWeaver-Setup-<version>.exe`, a Windows installer
of about 120 MB. It needs no admin rights and no Node, Python or ffmpeg on the
machine. It bundles the engine from `../engine` at the repository root.

On first launch the app opens **Setup**, where each user picks a media folder
and a models folder and installs what they want: ffmpeg, a private Python,
yt-dlp, the engine tools, NVIDIA GPU support and the model weights. Setup stays
in the top bar for later changes. To try the app without an installer, run
`npm run desktop`.

```txt
electron/main.cjs        window, settings, starts and stops the server
electron/preload.cjs     the folder picker and settings bridge the page uses
%LOCALAPPDATA%\WaveWeaver
  settings.json          chosen folders
  cookies.txt            yt-dlp cookies, kept out of the media folder
  python/                the venv
  tools/                 ffmpeg, uv and the Python it fetched
  models/                model weights, unless another folder is chosen
  plugins/               engine plugins
  logs/studio.log        server and engine output, rewritten each launch
```

The server runs on Electron's own Node (`ELECTRON_RUN_AS_NODE`), and yt-dlp uses
the same binary as its JavaScript runtime. Uninstalling leaves all of this in
place, along with the media folder. The installer isn't code-signed, so Windows
SmartScreen warns on first run.

The engine answers only the studio that started it: it refuses browser requests and
unknown hosts, and needs a token made fresh at each launch. Setup installs exact
builds of ffmpeg and uv whose hashes are in `src/lib/server/setup.ts`, and Python
packages from hash-checked lock files. yt-dlp is the exception, because it has to
keep up with sites changing.

## Requirements

For running from a checkout (`npm run dev`):

- Node 22+
- `ffmpeg` and `ffprobe` on `PATH` (ffmpeg 7+; any recent full build has the
  encoders and filters used here: libx264, libvpx-vp9, libmp3lame, libopus,
  libvorbis, libass)
- Optional: the **engine** in `../engine` (Python 3.10+) for
  speech, translation, learned noise reduction, reference mastering, VST3
  hosting — and **Downloads**, which run yt-dlp from its venv
  (`pip install "yt-dlp[default,curl-cffi]"`, or the page's Install
  button). See [its README](../engine/README.md).
  Editing, mixing, EQ/dynamics, presets, previews and subtitle rendering
  all work without it.

No database, no runtime npm dependencies — SvelteKit for the app, ffmpeg for
the media. API keys are optional (Claude translation reads
`ANTHROPIC_API_KEY` if you set it).

## Media Layout

Each direct child of the media root is a **bin** (the editing word for a
folder of footage). A valid bin has a `sources/` folder; `renders/` is created
when needed.

```txt
media/                          # media root
  inbox/                        # a bin (created on first run)
    sources/                    # what you brought in — uploads land here
    renders/                    # everything WaveWeaver writes
    captions/                   # interview.mp4.en.json + .srt, one pair per language
  podcast/
    sources/
    renders/
  presets/                      # your saved recipes (JSON) and VST3 states
  .downloads/                   # the download queue, subscriptions, settings
  .cache/                       # thumbnails, peaks, previews, filter scripts, downloads in progress
```

Set `WAVEWEAVER_MEDIA_DIR=/abs/path` to use a different root. `.cache/` is
derived data — delete it whenever; everything regenerates.

Files keep their names. An upload of `Interview take 2.mp4` is stored as
`Interview take 2.mp4`, and renders are named
`<source>-<steps>-<YYYYMMDD-hhmmss>.<ext>`, e.g.
`interview-jumpcut-loudnorm-reframe-20261029-204629.mp4`. You can find
everything in Explorer/Finder without opening the app.

You can also just copy files into `media/<bin>/sources/` — the Library reads
the folders, not a database.

## Run

```sh
npm install
npm run demo        # optional: a `demo` bin of test media (speech via Windows TTS)
npm run dev
# Visit http://localhost:5190
```

The dev server starts the engine on demand (from
`../.venv`, at the repository root) the first time a page needs it, and prints its
output prefixed `[engine]`. Point elsewhere with `WAVEWEAVER_ENGINE_DIR` or
`WAVEWEAVER_ENGINE_URL`; set `WAVEWEAVER_ENGINE_AUTOSTART=0` to run it yourself.

For production-style serving:

```sh
npm run build
npm start           # sets BODY_SIZE_LIMIT=Infinity so big uploads work
```

Useful checks:

```sh
npm run check
```

## What's Here

- `/` — **Library**. Every source grouped by bin: thumbnail, video/audio
  pips, runtime, frame size, codecs, size. Drag-and-drop upload with
  progress, new bins, filters, delete.
- `/downloads` — **Downloads**, a download manager built on
  [yt-dlp](https://github.com/yt-dlp/yt-dlp), modelled on
  [MeTube](https://github.com/alexta69/metube). Paste links from YouTube
  or any site yt-dlp supports — a video, a playlist, a whole channel, or
  several at once — and they land in a bin's `sources/`, ready for the
  Desk.
  - What to fetch: video (codec, MP4 / iOS-compatible, 240p–2160p), audio
    (M4A, MP3, Opus, WAV, FLAC with bitrates; tags and cover art), captions
    only (SRT, TXT, VTT, TTML…, manual or automatic), or the thumbnail. Or
    a raw yt-dlp format selector.
  - **Inspect** before you commit: a video's formats with the ones your
    options pick marked (and re-picked as you change the options), its size,
    captions and chapters; a playlist's entries to pick from.
  - **Clips**: download just a stretch, or click a chapter. Cut exactly
    (see below).
  - **Captions alongside**: fetch a language's captions with the video and
    they become an editable track on it in Captions. YouTube's automatic
    captions come in with word timings and are reflowed into proper
    subtitles, like Whisper output.
  - A playlist or channel gets a bin of its own; items are numbered by
    playlist position. Item limit, name prefix, SponsorBlock removal, split
    by chapters, video passwords, per-download yt-dlp options and named
    presets.
  - The queue: a few at a time (configurable), live progress over
    server-sent events, pause and resume (from the partial file), cancel,
    retry, start-later. Upcoming live streams wait and start when they go
    live; live streams record until you **Stop & keep**.
  - **Subscriptions** to channels and playlists: what's there now counts
    as seen; new uploads are downloaded on a schedule, optionally filtered
    by title (regex) or skipping members-only videos.
  - Settings: file-name templates, speed limit, auto-clearing, whether
    removing a row deletes its files, cookies (`cookies.txt` or from a
    browser) for private and age-restricted videos, global yt-dlp options,
    an **Update yt-dlp** button, and a bookmarklet that opens any page's link
    here.
- `/desk` — **Desk**. One file, four modes:
  - **Weave** — stack steps and render once.
    - Time: Trim, Jump cut (by level, or by *speech* with Silero VAD), Speed,
      Reverse, Fade
    - Sound: Loudness (two-pass EBU R128), Volume, EQ (six bands, drawn as a
      curve you drag), Compressor, Limiter, Gate, Stereo, Pitch, Mute
    - Repair: Denoise, De-hum (50/60 Hz + harmonics), De-ess, De-click/clip
    - Picture: Reframe (crop / bars / blurred fill), Resize, Color, Rotate,
      Flip, Frame rate

    **Presets…** appends a mastering or voice chain (Podcast −16, Streaming
    −14, Broadcast R128 −23, Audiobook/ACX, Loud, Lo-fi, Phone, Clean up
    dialogue) as ordinary editable steps. **Save recipe** writes yours to
    `media/presets/`. Every edit is dry-run and shows the exact ffmpeg
    command. **Preview** renders your waveform selection (or N seconds from
    the playhead) and opens an A/B player; **Render whole file** commits.
  - **Lab** — tools from the engine, each with a generated form, presets,
    Preview and Apply: learned-profile noise reduction (select a gap of pure
    noise, press *Use selection*), reverb/delay/chorus/drive/pitch, any
    installed VST3 (open its own window, save the settings, render with
    them), reference mastering, and optional neural cleanup / stem
    separation.
  - **Parts** — turn one long recording into a set of parts. Detect them
    from pauses (the sound between pauses; the pauses themselves are left
    out, apart from a little room tone), from speech (Silero VAD), every N
    minutes or as N equal parts (cuts snapped to the nearest real pause),
    or by hand. **Auto** reads the noise floor and programme level and sets
    the threshold. Parts shorter than a minimum are excluded (or merged into
    a neighbour), never silently deleted. Drag part edges on the waveform,
    `S` splits at the playhead, `X` keeps/drops, `[` `]` step through parts;
    playback skips what won't be kept. Paste a tracklist to name them.
    Export **one file** (gaps of silence or a crossfade between parts,
    chapters written into MP4/M4A/MP3) or **separate files** (numbered and
    tagged title/track/album/artist), with optional per-part or whole-file
    loudness. Preview shows exactly one join — the end of a part into the
    start of the next — before you commit. Part lists save themselves to
    `media/<bin>/parts/` and download as CSV, Audacity labels, a CUE sheet
    or YouTube chapters.
  - **Snapshot** — a frame as PNG, or a contact sheet.
- `/captions` — **Captions**. Whisper transcription (GPU when available)
  with word timings, previewable on 30 s first. An editor with live captions
  over the player (the spoken word highlighted), per-cue speaker and note,
  split/merge/insert, reflow to subtitle rules, shift, find/replace, undo,
  and side-by-side comparison with another language. Translate with Claude
  or offline NLLB-200 (timing kept, cue for cue). Import SRT/VTT. Export
  SRT, VTT (speakers + notes), TXT transcript, JSON; burn in (previewable;
  over a waveform for audio-only files) or mux switchable subtitle tracks
  with language tags.
- `/mix` — **Mix**. Tracks on a timeline (drag to offset), each with role,
  gain, pan, fades, mute/solo. Music ducks under voice by sidechain
  compression; a preset masters the result. Preview compares the plain sum
  (A) with the finished mix (B). Output audio, or MP4 with a track's picture
  or a waveform.
- `/stitch` — **Stitch**. Order clips, hard cuts or crossfades, one canvas.
- `/presets` — **Presets**. The preset library: try any chain on any file
  as a 20-second A/B, then take it to the Desk.
- `/renders` — Everything WaveWeaver made. Download, open on the Desk,
  promote to sources, delete.
- `/jobs` — The queue: running, queued and finished jobs with live
  progress, cancel, logs and commands.

## Architecture Notes

- Routes live under [src/routes](src/routes); shared UI and vocabulary in
  [src/lib](src/lib); everything that touches disk or spawns processes under
  [src/lib/server](src/lib/server).
- Bin discovery and path safety live in
  [src/lib/server/paths.ts](src/lib/server/paths.ts). Paths are checked with
  `path.relative` (not string prefixes) and work with Windows separators and
  drive letters.
- **The weave compiler** is [src/lib/server/weave.ts](src/lib/server/weave.ts).
  It turns a list of steps into one `filter_complex`: a linear chain per
  stream, plus labelled fragments where a step needs split/overlay (blur
  fill, GIF palettes, audio visualisers). It tracks duration, frame size and
  fps through the chain, so later steps work with real numbers — a fade-out
  knows where the end is after a speed-up and a jump cut.
  - A leading Trim becomes input seeking (`-ss`/`-t` before `-i`), so a clip
    from the middle of a two-hour file starts instantly.
  - Jump cut and Loudness need measurements. The compiler reports the first
    unresolved one as `pending`; the job runs an **audio-only** analysis
    pass over the graph prefix up to that step (`silencedetect` or
    `loudnorm print_format=json`), stores the result, and recompiles. Then
    exactly one render.
  - Jump cuts are frame-aligned: video is conformed to an fps that divides
    48 kHz evenly, audio is repackaged into frame-sized chunks
    (`asetnsamples`), and both `select` and `aselect` use the same
    half-frame-offset spans. Audio and video cut on identical boundaries, so
    there's no drift however many cuts there are.
- Pipelines live under [src/lib/server/pipelines](src/lib/server/pipelines)
  (weave, preview, tool, captions, mix, stitch, parts, snapshot) and receive
  a `JobContext` for logs, progress and the command they ran.
- **Previews** ([preview.ts](src/lib/server/pipelines/preview.ts)) write
  `a.*` (the untouched window) and `b.*` (processed) to
  `media/.cache/previews/<id>/` and meter both with ffmpeg's EBU R128 scanner.
  A weave preview *is* the weave with the window as its leading trim. The
  A/B player decodes both into Web Audio and runs them on one clock;
  switching sides is a 20 ms gain crossfade, so the comparison is
  sample-locked. Previews run in their own job lane and never wait behind a
  render.
- **The engine bridge** ([engine.ts](src/lib/server/engine.ts)) starts the
  Python engine on demand and runs its jobs *inside* studio jobs: progress,
  log lines and cancellation are mirrored, so the UI doesn't care where a
  tool runs. Engine forms are generated from the schema each plugin
  publishes ([ToolForm.svelte](src/lib/ToolForm.svelte)).
- The speech-aware jump cut renders the graph prefix to a WAV, asks the
  engine's VAD for speech spans, and turns the gaps into the same
  frame-aligned cut list the level detector produces.
- The EQ curve on screen is computed with the RBJ biquad formulas ffmpeg's
  filters implement; measured against ffmpeg it agrees within 0.02 dB.
- **Captions** ([captions.ts](src/lib/captions.ts)) keep Whisper's word
  timings, so cues can be re-flowed into subtitle rules (two lines, ~42
  characters, ≤ 6 s, breaks at punctuation and pauses, never an orphaned
  word) without losing sync. Translations keep every cue's id and timing.
  Burn-in goes through a generated ASS file so size and style scale with the
  frame.
- **Mixing** ([mix.ts](src/lib/server/pipelines/mix.ts)) is one graph:
  per-track fades/gain/pan/`adelay`, voice and music summed separately, the
  music keyed by the voice through `sidechaincompress`, then `amix` with
  normalisation off so your gains stand. Mastering runs afterwards as a
  normal weave on the mixed WAV, so two-pass loudness measures the finished
  mix.
- Jobs are tracked in an in-memory `Map` in
  [src/lib/server/jobs.ts](src/lib/server/jobs.ts) with a small queue
  (`WAVEWEAVER_CONCURRENCY`, default 2). Restarting the server clears job
  history (in dev, so does editing a server file); outputs stay on disk.
  The UI polls `/api/jobs/[id]` and cancels with `DELETE /api/jobs/[id]`,
  which kills the ffmpeg child.
- Progress is real: ffmpeg runs with `-progress pipe:1`, and `out_time` is
  divided by the duration the compiler predicted.
- Renders are written to a hidden `.part-` file and renamed into place only on
  success; a cancelled or failed job never leaves half a file. Names are
  reserved in-process so two jobs finishing in the same second can't collide.
- Filtergraphs always go through a script file (`-/filter_complex <file>`):
  a jump cut over an hour of speech produces graphs far longer than Windows'
  32K command-line limit.
- `POST /api/plan` is the dry run: same body as `POST /api/jobs`, returns the
  command, passes, expected runtime and warnings without rendering.
- Media is served through
  [`/api/media/[bin]/[kind]/[name]`](src/routes/api/media/%5Bbin%5D/%5Bkind%5D/%5Bname%5D/+server.ts)
  with `Range` support so `<video>` can seek without re-downloading.
- Uploads are a raw `PUT /api/upload?bin=&name=` streamed straight to disk —
  no multipart buffering — and only appear once complete.
- **Downloads** ([downloads.ts](src/lib/server/downloads.ts),
  [ytdlp.ts](src/lib/server/ytdlp.ts)) follow MeTube's design with the
  studio's habits. The studio owns the queue; yt-dlp runs in a child
  process per download — `python -m engine.fetch` from the engine venv,
  started and killed like ffmpeg (no engine server needed). It drives
  yt-dlp's Python API and streams JSON events: progress, postprocessor
  phases, the paths it wrote. Cancelling kills the whole process tree
  (`taskkill /T` on Windows), ffmpeg included.
  - The format catalog ([downloads.ts](src/lib/downloads.ts)) is the one
    list of choices: the form renders it, requests are validated against
    it, and `ytdlp.ts` maps each choice to a yt-dlp format selector and
    postprocessors (a port of MeTube's `dl_formats`).
  - Each download writes into `media/.cache/downloads/<id>/` and is filed
    into its bin only when finished — media to `sources/`, caption files to
    `captions/`, thumbnails and the rest to `extras/` — under its own name
    (`Title.mp4`, `Title (2).mp4`; never overwritten).
  - The queue, subscriptions and settings are JSON in `media/.downloads/`.
    A download running when the server stops is queued again on start and
    yt-dlp resumes its `.part` file; in dev, editing a server file hands the
    queue to the new module the same way.
  - Clips under two hours are downloaded whole and cut locally: yt-dlp's
    ranged download has ffmpeg seek inside the remote file, which crawls on
    YouTube's fragmented MP4 streams and can only cut at keyframes. Audio is
    cut by stream copy (exact, cover and tags kept); video is re-encoded to
    H.264 so it starts on the frame. Longer sources use yt-dlp's ranges.
  - YouTube needs a JavaScript runtime for its player challenges; the
    studio hands yt-dlp its own Node, so nothing else needs installing.
  - Inspect caches the extracted info, so changing the options re-runs only
    yt-dlp's format selection (offline, about a second) to update what will
    be fetched.
- Thumbnails and waveform peaks are derived on demand into `media/.cache`,
  keyed by path + size + mtime. Peaks stream PCM through ffmpeg at a low
  sample rate, so a two-hour file costs a few seconds and a 2,000-number
  JSON file.

## Style Notes

- Global design tokens and reusable classes live in [src/app.css](src/app.css).
- Palette: `--bg` white, `--ink` near-black, a single `--accent: #FF4F00`
  (signal orange). Muted grey flips back to ink wherever it sits on the
  accent.
- **Dark mode** swaps the same tokens (near-black page, near-white ink, the
  same orange). It follows the system; the top bar's ◐ / ○ / ● switch
  overrides it per browser, applied before the first paint. Three tokens
  keep both themes honest: `--on-accent` (text on the accent — always dark),
  `--screen` / `--screen-ink` (logs, commands, players, thumbnails — always
  dark), and `--pressed` / `--on-pressed` (a pressed toggle: ink with an
  accent label on light, the accent itself on dark). Canvases read the
  tokens through `palette()` in
  [theme.svelte.ts](src/lib/theme.svelte.ts) and redraw when the theme
  changes.
- [Unbounded](https://fonts.google.com/specimen/Unbounded) is the main
  typeface; [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono)
  is for anything a machine wrote: logs, commands, timecodes, codecs.
- Sections separate with whitespace or 1px rules. Status uses outlined or
  filled squares, not coloured pills. Choices are segmented square toggles;
  sliders are a 2px rule with a square thumb.
- Dark `--screen` surfaces are reserved for machine output: the log panel,
  the ffmpeg command, and the video screens.
- A/B is always labelled `A · before` / `B · after`; the side you're hearing
  is filled with the accent. Caption cues and the spoken word use the same
  accent highlight.
- The waveform is drawn, not decorated: ink bars, accent selection, hatched
  cuts, washed-out regions that won't be in the result.
  Ctrl+wheel zooms at the pointer, Shift+wheel scrolls, and the minimap
  underneath shows where you are; zoomed in, peaks are re-read for the
  visible stretch so a one-hour file still shows single words.
- The accent marks state, never decoration: the page you're on, the
  selection, what's playing, the side of an A/B you're hearing, and the
  length of what a render will produce. Page headings are never highlighted
  for effect (only the wordmark carries it); hover is an underline.
