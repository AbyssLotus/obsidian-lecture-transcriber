# Lecture Transcriber

Transcribe lecture recordings in Obsidian and turn them into notes — a title, a
summary, key points, and the full transcript, filed into the note that already
references the recording.

Everything runs on your own machine. No API keys, no accounts, nothing uploaded.

## What it does

- **Transcribes** any recording in your vault with Whisper
- **Files it** into the note that embeds the recording, or one with the same name
- **Summarises** it with a local model into a title, summary and key points
- **Writes maths as LaTeX**, so `$x = -\frac{b}{2a}$` renders properly
- **Keeps your computer awake** while recording and while transcribing
- **Uses your own notes as vocabulary**, so terms you typed are recognised

## Install

### From Obsidian (once listed)

Settings → Community plugins → Browse → search "Lecture Transcriber" → Install.

### Before then, with BRAT

1. Install the **BRAT** plugin from Community plugins
2. BRAT → Add beta plugin → `tripphinch/obsidian-lecture-transcriber`
3. Enable **Lecture Transcriber** in Community plugins

### Manually

Download `main.js`, `manifest.json` and `styles.css` from the
[latest release](../../releases/latest) into
`<vault>/.obsidian/plugins/lecture-transcriber/`, then enable it.

## Setup

The first time it loads, a setup window offers to download what is missing.
It picks the right build for your computer and puts everything in one place.

| | Windows | macOS | Linux |
|---|---|---|---|
| Whisper program | downloaded automatically | `brew install whisper-cpp` (offered, and run for you if Homebrew is present) | downloaded automatically |
| Speech model | downloaded automatically (~1.1 GB) | same | same |
| ffmpeg | not needed | not needed | not needed |

ffmpeg is not required: Obsidian decodes audio itself. It is only used as a
fallback for a format Obsidian refuses, and the plugin will say so if that
ever happens.

Summaries additionally need [Ollama](https://ollama.com) with a model pulled,
for example `ollama pull qwen3`. Without it, transcripts still work and the
note says the summary was unavailable.

## Using it

Press the microphone in the left ribbon to transcribe everything that has not
been done yet, or record straight into Obsidian and let it happen on its own.

Commands:

- **Transcribe all audio in vault**
- **Transcribe audio linked in the current note**
- **Set up (download Whisper and the model)**

## Settings worth knowing

- **Corrections** — `wrong => right`, one per line, for words the model keeps
  getting wrong. Applied to every transcript, so these are guaranteed fixes.
- **Extra vocabulary** — names and jargon to bias recognition toward.
- **Fast decoding** — greedy instead of beam search; about 1.5x faster with no
  measured loss.
- **Keep the screen on** — recommended. When the display sleeps, Obsidian gets
  throttled and a summary in progress can fail.
- **Let the model think first** — off by default. Roughly 3x slower for no real
  gain on lecture material.

## Notes on accuracy

Measured on real lecture audio while building this:

- The full `large-v3` family is clearly better than `turbo` on lecture speech;
  turbo rendered "algebraic equation" as "algebraic queen".
- A denoiser (`afftdn`) made things worse, not better — it caused duplicated
  sentences. It is not used.
- Disabling text-context carry-over (`-mc 0`) is essential: with it enabled a
  97-minute low-bitrate recording fell into a repetition loop 30 minutes in and
  never recovered. It costs nothing measurable in accuracy.
- Transcripts carry a visible warning when repetition suggests content was lost.

## Development

```bash
node test/run-all.js                                   # run the suites
node scripts/build.js                                  # assemble dist/
VAULT=/path/to/vault node scripts/build.js --install   # install into a vault
```

The suites run against a stub of the Obsidian API, so they exercise the
platform logic on Windows, macOS and Linux in CI without needing Obsidian.

## Licence

MIT
