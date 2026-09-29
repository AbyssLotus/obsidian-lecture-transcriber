# Transcriber and Summary for Idiots

Records and lecture audio in, finished notes out. For each recording you get a
title, a summary, key points, and the full transcript — written into the note
that already links the recording.

Everything runs on your own computer. No accounts, no API keys, no subscription,
and nothing is ever uploaded.

---

## Setup, step by step

You do not need to use a terminal. Follow these in order.

### 1. Install the plugin

**In Obsidian:** Settings → Community plugins → **Browse** → search
*Transcriber and Summary for Idiots* → **Install** → **Enable**.

*Not listed yet? Use BRAT:* install the **BRAT** plugin the same way, then
BRAT → *Add beta plugin* → paste `AbyssLotus/obsidian-lecture-transcriber`.

### 2. Let it install the speech parts

The first time it loads, a **Setup** window appears and lists what is missing.
Press **Install what is missing** and wait. It downloads about 1.1 GB.

If the window is gone, reopen it: Settings → *Transcriber and Summary for
Idiots* → **Set up**.

> **On a Mac** there is no ready-made Whisper download, so the plugin uses
> Homebrew. If you do not have it, the window tells you: install Homebrew from
> [brew.sh](https://brew.sh), then press **Install what is missing** again.

**You can stop here.** Transcription now works. Steps 3 and 4 only add the
summary and key points.

### 3. Install Ollama (only for summaries)

Summaries are written by a second program called Ollama. It is free and also
runs entirely on your computer.

1. Download it from **[ollama.com/download](https://ollama.com/download)**
2. Install it like any other app
3. **Open it once.** It has no real window — it just runs quietly in the
   background. That is normal and correct.
4. Back in Obsidian, open the **Setup** window again

### 4. Let it download a summary model

With Ollama running, the Setup window offers two buttons. Press one:

| Choice | Size | Use when |
|---|---|---|
| `qwen3:4b` | ~2.6 GB | Most computers. Start here. |
| `qwen3:8b` | ~5.2 GB | You have 16 GB of memory or more and want better key points. |

A progress bar shows the download. When it finishes, summaries are on.

---

## Using it

Press the **microphone** in the left sidebar. It transcribes every recording in
your vault that has not been done yet, showing progress per file.

Or just record straight into Obsidian and forget about it — new recordings are
transcribed on their own a few seconds after they appear.

**Where the notes go.** If a note embeds the recording (`![[Recording 1.m4a]]`),
the transcript goes into that note. Otherwise a note beside the recording with
the same name is used, or created.

**How long it takes.** Roughly 1 minute of processing per 20 minutes of audio,
plus about 20 seconds for the summary. A one-hour lecture takes about 4 minutes.
Your computer is kept awake for the whole thing, including while recording.

---

## If something goes wrong

**"Not set up yet"** — open Settings → *Transcriber and Summary for Idiots* →
**Set up** and press the button.

**Transcripts appear but no summary** — Ollama is not running, or has no model.
Open Settings → **Test the summary model** → *Test*. It tells you exactly what
is wrong in one line. Usually: open the Ollama app, then press Test again.

**Everything is slow** — Settings → **Summary model**: pick a smaller one.
`qwen3:4b` is several times faster than a large model.

**It keeps mishearing the same word** — Settings → **Corrections**, one rule per
line:

```
gravel => parabola
Dr Thurman => Dr Thierman
```

Those are applied to every transcript from then on, so the fix is permanent.

**The transcript has a warning box on it** — the recording confused Whisper
badly enough that some of the lecture is probably missing. Usually very quiet or
very low-quality audio. Record closer to the speaker if you can.

**The Mac still sleeps with the lid shut** — nothing can prevent that; macOS
does not allow it. Leave the lid open.

---

## Settings worth knowing

- **Corrections** — permanent find-and-replace for words it keeps getting wrong.
- **Extra vocabulary** — names, course codes and jargon to expect.
- **Use my notes to improve accuracy** — on by default. What you have already
  typed in the note makes those words far likelier to be recognised.
- **Write maths as LaTeX** — on by default, so `$x = -\frac{b}{2a}$` renders as
  a real equation.
- **Also mark up maths in the transcript** — off by default, and slow (about 35
  minutes for a one-hour lecture). Worth it for maths classes only.
- **Keep the screen on too** — leave this on. When the display sleeps, Obsidian
  gets throttled and a summary in progress can fail.
- **Let the model think first** — off by default. About three times slower for
  no real gain on lecture material.

---

## What it does not do

- **Mobile.** Desktop only. It runs real programs on your computer, which
  Obsidian on phones and tablets cannot do.
- **Identify who is speaking.** The transcript is one continuous voice.
- **Fix bad recordings.** A phone across a lecture hall will transcribe poorly
  no matter the settings.

---

## Notes on accuracy, if you care

Measured on real lecture recordings while building this:

- The full `large-v3` model family is clearly better than `turbo` on lecture
  speech — turbo rendered "algebraic equation" as "algebraic queen".
- A denoiser made things worse, not better: it caused duplicated sentences.
  None is used.
- Text-context carry-over is disabled deliberately. With it on, a 97-minute
  low-bitrate recording fell into a repetition loop 30 minutes in and never
  recovered, losing two thirds of the lecture. Turning it off costs nothing
  measurable in accuracy.
- Audio is decoded and levelled inside Obsidian, which is why ffmpeg is not
  needed. This was checked to transcribe identically to the ffmpeg version.

---

## For developers

```bash
node test/run-all.js                                   # run the suites
node scripts/build.js                                  # assemble dist/
VAULT=/path/to/vault node scripts/build.js --install   # install into a vault
```

The suites run against a stub of the Obsidian API, so CI exercises the
platform-specific code on Windows, macOS and Linux without needing Obsidian.

## Licence

MIT
