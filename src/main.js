'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, normalizePath } = require('obsidian');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const zlib = require('zlib');
const path = require('path');

const AUDIO_EXTS = ['m4a','mp3','wav','webm','mp4','aac','flac','ogg','opus','mov','m4v'];
const HOME = os.homedir();

/* ---------- platform ------------------------------------------------------
 * Everything OS-specific lives here so the rest of the plugin stays plain.
 * -------------------------------------------------------------------------*/
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const EXE = IS_WIN ? '.exe' : '';

// Where the plugin keeps binaries and models it installed itself.
function dataDir() {
  if (IS_WIN) {
    return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'LectureTranscriber');
  }
  if (IS_MAC) return path.join(HOME, 'Library', 'Application Support', 'LectureTranscriber');
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'lecture-transcriber');
}
const MODEL_DIR = path.join(dataDir(), 'models');
const BIN_DIR = path.join(dataDir(), 'bin');

// Places a user-installed copy commonly lives, per platform.
function searchDirs() {
  const dirs = [BIN_DIR];
  if (IS_WIN) {
    dirs.push(
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'whisper'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'whisper'),
      path.join(process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey', 'bin'),
    );
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
              path.join(HOME, '.local', 'bin'), '/snap/bin');
  }
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) dirs.push(d);
  return dirs;
}

function findBinary(names) {
  for (const dir of searchDirs()) {
    for (const n of names) {
      const candidate = path.join(dir, n + EXE);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (e) { /* keep looking */ }
    }
  }
  return '';
}

// whisper.cpp's CLI has been called several things across releases.
const WHISPER_NAMES = ['whisper-cli', 'whisper', 'main'];
const FFMPEG_NAMES = ['ffmpeg'];

const DEFAULTS = {
  whisperPath: '',          // resolved on load, or set by the setup wizard
  ffmpegPath: '',           // optional: only used if Obsidian cannot decode a file
  // macOS gets GPU acceleration through Metal, so the accurate model is
  // affordable. The prebuilt Windows and Linux builds are CPU-only, where the
  // accurate model is several times slower, so default to the fast one there.
  modelPath: path.join(MODEL_DIR, IS_MAC ? 'ggml-large-v3-q5_0.bin' : 'ggml-large-v3-turbo-q5_0.bin'),
  vadModelPath: path.join(MODEL_DIR, 'ggml-silero-v5.1.2.bin'),
  language: 'en',
  fastDecode: true,
  maxContext: 16384,
  useVad: true,
  cleanAudio: true,
  autoTranscribeNew: true,
  keepAwake: true,
  keepAwakeRecording: true,
  keepScreenOn: true,
  ollamaTimeoutMin: 20,
  deepThinking: false,
  corrections: '',
  summarize: true,
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen3.6:latest',
  summaryExtra: '',
  mathNotation: true,
  mathInTranscript: false,
  mathModel: '',
  courseVocabulary: true,
  vocabulary: '',
  usePriorNotes: true,
  threads: 0,
  headingLabel: 'Transcript',
  setupDismissed: false,
};

const marker = (name) => `<!-- transcribed: ${name} -->`;

/* ---------- text processing ------------------------------------------------
 * Whisper emits one line per segment, and on quiet or low-bitrate audio it can
 * fall into a repetition loop. VAD and -mc 0 prevent almost all of that at the
 * source; this is the net that catches whatever still slips through.
 * -------------------------------------------------------------------------*/
function reflow(raw) {
  let text = raw.split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return { text: '', dropped: 0, words: 0 };

  const sents = (text.match(/.+?(?:[.!?](?:\s|$)|$)/g) || []).map(s => s.trim()).filter(Boolean);
  const counts = new Map();
  for (const s of sents) {
    const k = s.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  const seen = new Map();
  const kept = [];
  let prev = null, dropped = 0;
  for (const s of sents) {
    const k = s.toLowerCase();
    const n = seen.get(k) || 0;
    if (k === prev || (counts.get(k) > 8 && n >= 3)) {
      dropped++;
    } else {
      kept.push(s);
      seen.set(k, n + 1);
    }
    prev = k;
  }

  const paras = [];
  let buf = [];
  for (const s of kept) {
    buf.push(s);
    if (buf.length >= 5) { paras.push(buf.join(' ')); buf = []; }
  }
  if (buf.length) paras.push(buf.join(' '));

  const words = kept.join(' ').split(/\s+/).filter(Boolean).length;
  // A loop does not just repeat text, it *replaces* the audio underneath it,
  // so silently deduplicating one would hand back a clean-looking transcript
  // with content missing. Flag it loudly instead.
  const total = sents.length;
  const suspect = dropped > 25 && total > 0 && (dropped / total) > 0.15;
  return { text: paras.join('\n\n'), dropped, words, suspect, total };
}

class Cancelled extends Error {
  constructor() { super('Cancelled'); this.name = 'Cancelled'; }
}

module.exports = class LectureTranscriber extends Plugin {

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.resolveBinaries();
    this.running = false;
    this.cancelRequested = false;
    this.activeProc = null;
    this.activeReq = null;
    this.awakeProc = null;
    this.awakeReasons = new Set();
    this.recordingStreams = new Set();
    this.hookRecording();

    this.addRibbonIcon('mic', 'Transcribe all audio in vault', () => this.openRunner());

    this.addCommand({
      id: 'transcribe-all',
      name: 'Transcribe all audio in vault',
      callback: () => this.openRunner(),
    });

    this.addCommand({
      id: 'transcribe-current',
      name: 'Transcribe audio linked in the current note',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md') return false;
        if (!checking) this.openRunner(this.audioLinkedFrom(f));
        return true;
      },
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('mod-clickable');
    this.statusEl.onclick = () => this.openRunner();
    this.refreshStatus();

    this.addSettingTab(new TranscriberSettingTab(this.app, this));

    // Auto-transcribe recordings as they appear (Obsidian's own recorder, or a
    // file syncing in from another device). Only after the initial index scan,
    // so opening the vault does not kick off a full re-run.
    this.addCommand({
      id: 'run-setup',
      name: 'Set up (download Whisper and the model)',
      callback: () => new SetupModal(this.app, this).open(),
    });

    this.app.workspace.onLayoutReady(() => {
      // First run, or a machine that has not been set up yet (a vault synced
      // from another computer arrives with settings but no binaries).
      if (this.settings.summarize) this.adoptInstalledModel();
      if (this.preflight().length && !this.settings.setupDismissed) {
        this.settings.setupDismissed = true;
        this.saveSettings();
        new SetupModal(this.app, this).open();
      }
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (f) => {
        if (!this.settings.autoTranscribeNew) return;
        if (!(f instanceof TFile) || !AUDIO_EXTS.includes(f.extension.toLowerCase())) return;
        // give iCloud/Obsidian a moment to finish writing the file
        // registered so it cannot fire after the plugin unloads
        this.registerInterval(window.setTimeout(() => this.queueAuto(f), 4000));
      }));
    });
  }

  onunload() {
    this.cancelRequested = true;
    this.releaseAllAwake();
    if (this.activeProc) { try { this.activeProc.kill('SIGTERM'); } catch (e) { /* already gone */ } }
    if (this.activeReq) { try { this.activeReq.destroy(); } catch (e) { /* already gone */ } }
  }

  async saveSettings() { await this.saveData(this.settings); }

  /* ---------- keep the Mac awake -----------------------------------------
   * One assertion held for the whole run, not per file, so the machine does
   * not doze between recordings. -i idle sleep, -m disk sleep, -s system
   * sleep on AC. The display is deliberately left free to sleep.
   * A closed lid still sleeps; caffeinate cannot override clamshell.
   * ---------------------------------------------------------------------*/
  // Recording and transcribing can each need the machine awake, and they
  // overlap, so the assertion is reference counted by reason rather than
  // owned by whichever finishes first.
  acquireAwake(reason) {
    if (reason === 'transcribing' && !this.settings.keepAwake) return;
    if (reason === 'recording' && !this.settings.keepAwakeRecording) return;
    this.awakeReasons.add(reason);
    if (this.awakeProc) return;
    try {
      this.awakeProc = this.spawnWakeLock();
      if (!this.awakeProc) { this.awakeReasons.clear(); return; }
      this.awakeProc.on('error', () => { this.awakeProc = null; });
    } catch (e) {
      this.awakeProc = null;
    }
  }

  /* Holding the machine awake differs per OS:
   *   macOS   caffeinate. -d also keeps the display on, which matters beyond
   *           comfort: when the display sleeps Chromium throttles Obsidian's
   *           renderer, which previously killed summaries mid-request.
   *           -s is silently ignored on battery.
   *   Windows SetThreadExecutionState via PowerShell. The assertion lives for
   *           as long as the process does, so killing it releases the lock.
   *   Linux   systemd-inhibit where available; otherwise we do nothing rather
   *           than pretend.
   * Returns the child process, or null if this platform has no mechanism. */
  spawnWakeLock() {
    const screen = !!this.settings.keepScreenOn;
    try {
      if (IS_MAC) {
        const flags = ['-i', '-m', '-s'];
        if (screen) flags.push('-d');
        return spawn('/usr/bin/caffeinate', flags, { stdio: 'ignore' });
      }
      if (IS_WIN) {
        // ES_CONTINUOUS 0x80000000 | ES_SYSTEM_REQUIRED 0x1 | ES_DISPLAY_REQUIRED 0x2
        const state = screen ? '0x80000003' : '0x80000001';
        const ps = [
          'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;' +
            'public class LtPower{[DllImport("kernel32.dll",SetLastError=true)]' +
            'public static extern uint SetThreadExecutionState(uint esFlags);}\';',
          `[LtPower]::SetThreadExecutionState(${state}) | Out-Null;`,
          'while($true){Start-Sleep -Seconds 60}',
        ].join(' ');
        return spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
          { stdio: 'ignore', windowsHide: true });
      }
      const inhibit = findBinary(['systemd-inhibit']);
      if (inhibit) {
        return spawn(inhibit,
          ['--what=idle:sleep', '--who=Lecture Transcriber', '--why=Transcribing',
           'sleep', '86400'], { stdio: 'ignore' });
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // Fill in any binary the user has not set explicitly, and repair a saved
  // path that no longer exists (a Homebrew move, or settings synced between
  // a Mac and a PC through the vault).
  resolveBinaries() {
    const ok = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (e) { return false; } };
    if (!this.settings.whisperPath || !ok(this.settings.whisperPath)) {
      this.settings.whisperPath = findBinary(WHISPER_NAMES);
    }
    if (this.settings.ffmpegPath && !ok(this.settings.ffmpegPath)) this.settings.ffmpegPath = '';
    if (!this.settings.ffmpegPath) this.settings.ffmpegPath = findBinary(FFMPEG_NAMES);
    for (const key of ['modelPath', 'vadModelPath']) {
      const v = this.settings[key];
      if (v && !fs.existsSync(v)) {
        const alt = path.join(MODEL_DIR, path.basename(v));
        if (fs.existsSync(alt)) this.settings[key] = alt;
      }
    }
  }

  releaseAwake(reason) {
    this.awakeReasons.delete(reason);
    if (this.awakeReasons.size || !this.awakeProc) return;
    try { this.awakeProc.kill('SIGTERM'); } catch (e) { /* already gone */ }
    this.awakeProc = null;
  }

  releaseAllAwake() {
    this.awakeReasons.clear();
    if (!this.awakeProc) return;
    try { this.awakeProc.kill('SIGTERM'); } catch (e) { /* already gone */ }
    this.awakeProc = null;
  }

  /* Obsidian's recorder — and any other plugin that records — goes through
   * getUserMedia. Wrapping it catches a recording starting without depending
   * on Obsidian's private plugin internals, which are not a stable API.
   * Note that track.stop() does not fire 'ended', so readyState is polled too. */
  hookRecording() {
    const md = (typeof navigator !== 'undefined') && navigator.mediaDevices;
    if (!md || !md.getUserMedia || md.__ltHooked) return;
    const orig = md.getUserMedia.bind(md);
    const plugin = this;
    md.getUserMedia = async function (constraints) {
      const stream = await orig(constraints);
      try {
        if (constraints && constraints.audio && stream.getAudioTracks().length) {
          plugin.onRecordingStarted(stream);
        }
      } catch (e) { /* never break the caller's recording */ }
      return stream;
    };
    md.__ltHooked = true;
    this.register(() => {
      try { md.getUserMedia = orig; delete md.__ltHooked; } catch (e) { /* torn down */ }
    });
  }

  onRecordingStarted(stream) {
    if (!this.settings.keepAwakeRecording) return;
    this.recordingStreams.add(stream);
    this.acquireAwake('recording');
    this.refreshStatus();

    const finish = () => {
      if (!this.recordingStreams.has(stream)) return;
      this.recordingStreams.delete(stream);
      if (!this.recordingStreams.size) this.releaseAwake('recording');
      this.refreshStatus();
    };
    stream.getAudioTracks().forEach(t => t.addEventListener('ended', finish));
    const iv = window.setInterval(() => {
      if (stream.getAudioTracks().every(t => t.readyState === 'ended')) {
        window.clearInterval(iv);
        finish();
      }
    }, 2000);
    this.registerInterval(iv);
  }

  /* ---------- discovery -------------------------------------------------- */

  allAudio() {
    return this.app.vault.getFiles()
      .filter(f => AUDIO_EXTS.includes(f.extension.toLowerCase()))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  audioLinkedFrom(note) {
    const links = this.app.metadataCache.resolvedLinks[note.path] || {};
    return Object.keys(links)
      .map(p => this.app.vault.getAbstractFileByPath(p))
      .filter(f => f instanceof TFile && AUDIO_EXTS.includes(f.extension.toLowerCase()));
  }

  // Which note does this recording belong to?
  //  1. a note that embeds it   2. a note with the same name   3. create one
  targetNoteFor(audio) {
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const src of Object.keys(resolved)) {
      if (src.toLowerCase().endsWith('.md') && resolved[src][audio.path]) {
        const f = this.app.vault.getAbstractFileByPath(src);
        if (f instanceof TFile) return { file: f, path: src };
      }
    }
    const dir = audio.parent && audio.parent.path !== '/' ? audio.parent.path + '/' : '';
    const sib = normalizePath(`${dir}${audio.basename}.md`);
    const existing = this.app.vault.getAbstractFileByPath(sib);
    return { file: existing instanceof TFile ? existing : null, path: sib };
  }

  async isDone(audio) {
    const { file } = this.targetNoteFor(audio);
    if (!file) return false;
    const content = await this.app.vault.cachedRead(file);
    return content.includes(marker(audio.name));
  }

  async pending() {
    const out = [];
    for (const a of this.allAudio()) if (!(await this.isDone(a))) out.push(a);
    return out;
  }

  async refreshStatus() {
    if (!this.statusEl) return;
    if (this.recordingStreams && this.recordingStreams.size) {
      this.statusEl.setText('🔴 recording — Mac staying awake');
      return;
    }
    if (this.running) return;
    try {
      const n = (await this.pending()).length;
      this.statusEl.setText(n ? `🎙 ${n} to transcribe` : '🎙 transcribed');
    } catch (e) {
      this.statusEl.setText('🎙');
    }
  }

  /* ---------- process plumbing ------------------------------------------- */

  run(cmd, args, onStderr) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(cmd, args);
      } catch (e) {
        reject(new Error(`Could not start ${path.basename(cmd)}: ${e.message}`));
        return;
      }
      this.activeProc = proc;
      let err = '';
      proc.stdout.on('data', () => {});
      proc.stderr.on('data', d => {
        const s = d.toString();
        err += s;
        if (err.length > 8000) err = err.slice(-4000);
        if (onStderr) onStderr(s);
      });
      proc.on('error', e => {
        this.activeProc = null;
        reject(new Error(`${path.basename(cmd)} failed to launch: ${e.message}`));
      });
      proc.on('close', (code, signal) => {
        this.activeProc = null;
        if (signal) reject(new Cancelled());
        else if (code === 0) resolve();
        else reject(new Error(`${path.basename(cmd)} exited with code ${code}\n${err.slice(-400)}`));
      });
    });
  }

  preflight() {
    const s = this.settings;
    const missing = [];
    if (!s.whisperPath || !fs.existsSync(s.whisperPath)) missing.push('the Whisper program');
    if (!s.modelPath || !fs.existsSync(s.modelPath)) missing.push('the Whisper model');
    // ffmpeg is optional: Obsidian decodes audio itself, and ffmpeg is only a
    // fallback for formats it refuses.
    return missing;
  }

  /* ---------- the actual work -------------------------------------------- */

  // Audio is copied out of the vault through Obsidian's own API and processed
  // in a temp dir. External binaries never touch iCloud, which is what keeps
  // this working without granting anything Full Disk Access.
  /* ---------- audio preparation, without ffmpeg -------------------------
   * Obsidian is Chromium, which already decodes every format its own audio
   * player supports, and an OfflineAudioContext resamples and downmixes as
   * it renders. That replaces the one ffmpeg call this plugin used to make,
   * which removes a large per-platform binary from the install. ffmpeg is
   * still used as a fallback for anything Chromium refuses.
   * ---------------------------------------------------------------------*/
  static SAMPLE_RATE = 16000;

  webAudioAvailable() {
    return typeof window !== 'undefined' &&
           typeof (window.OfflineAudioContext || window.webkitOfflineAudioContext) === 'function';
  }

  async decodeToWav(arrayBuffer, clean) {
    const SR = LectureTranscriber.SAMPLE_RATE;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;

    // decodeAudioData resamples to the context's rate as it decodes
    const probe = new OAC(1, 1, SR);
    const decoded = await probe.decodeAudioData(arrayBuffer.slice(0));

    // render to mono, optionally through a high-pass to drop room rumble
    const off = new OAC(1, Math.max(1, decoded.length), SR);
    const src = off.createBufferSource();
    src.buffer = decoded;
    let tail = src;
    if (clean) {
      const hp = off.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 60;
      tail.connect(hp);
      tail = hp;
    }
    tail.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();

    const samples = rendered.getChannelData(0);
    if (clean) this.normalise(samples);
    return this.encodeWav(samples, SR);
  }

  /* Whisper is sensitive to level: quiet recordings are what send it into
   * repetition loops. This is the part of ffmpeg's loudnorm that matters —
   * bring RMS to a target, then make sure nothing clips. */
  normalise(samples) {
    const n = samples.length;
    if (!n) return;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / n);
    if (rms < 1e-6) return;                 // silence

    const TARGET_RMS = 0.1;                 // about -20 dBFS, a normal speech level
    const MAX_GAIN = 12;                    // do not amplify hiss out of nothing
    const KNEE = 0.7;                       // leave everything below this untouched
    const CEILING = 0.95;

    const gain = Math.min(MAX_GAIN, TARGET_RMS / rms);
    if (Math.abs(gain - 1) < 0.01) return;

    // A hard peak limit lets one stray transient hold the whole lecture quiet,
    // which is the opposite of what is wanted: quiet audio is what sends
    // Whisper into repetition loops. Gain for the body of the signal, then
    // soft-knee the few samples that would overshoot.
    const range = CEILING - KNEE;
    for (let i = 0; i < n; i++) {
      let v = samples[i] * gain;
      const a = Math.abs(v);
      if (a > KNEE) {
        const over = (a - KNEE) / range;
        const shaped = KNEE + range * Math.tanh(over);
        v = v < 0 ? -shaped : shaped;
      }
      samples[i] = v > CEILING ? CEILING : (v < -CEILING ? -CEILING : v);
    }
  }

  encodeWav(samples, sampleRate) {
    const n = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);        // PCM chunk size
    buf.writeUInt16LE(1, 20);         // format: PCM
    buf.writeUInt16LE(1, 22);         // channels
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);         // block align
    buf.writeUInt16LE(16, 34);        // bits per sample
    buf.write('data', 36);
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
    return buf;
  }

  async transcribeOne(audio, onProgress) {
    const s = this.settings;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lecture-transcriber-'));
    const src = path.join(tmp, 'input.' + audio.extension);
    const wav = path.join(tmp, 'audio.wav');
    const outBase = path.join(tmp, 'out');

    try {
      onProgress && onProgress('reading', 0);
      let priorNotes = '';
      try {
        const t = this.targetNoteFor(audio);
        if (t.file) priorNotes = await this.app.vault.read(t.file);
      } catch (e) { /* no notes to prime with; not fatal */ }
      const buf = await this.app.vault.readBinary(audio);

      onProgress && onProgress('preparing audio', 0);
      let prepared = false;
      if (this.webAudioAvailable()) {
        try {
          fs.writeFileSync(wav, await this.decodeToWav(buf, s.cleanAudio));
          prepared = true;
        } catch (e) {
          // fall through to ffmpeg for anything Chromium will not decode
        }
      }
      if (!prepared) {
        if (!s.ffmpegPath) {
          throw new Error(`Could not decode ${audio.extension} in Obsidian, and ffmpeg is not installed. Install ffmpeg, or convert the recording to wav/mp3.`);
        }
        fs.writeFileSync(src, Buffer.from(buf));
        const filters = 'highpass=f=60,loudnorm=I=-16:TP=-1.5:LRA=11';
        const fargs = ['-nostdin', '-v', 'error', '-y', '-i', src];
        if (s.cleanAudio) fargs.push('-af', filters);
        fargs.push('-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav);
        await this.run(s.ffmpegPath, fargs);
      }
      if (this.cancelRequested) throw new Cancelled();

      onProgress && onProgress('transcribing', 0);
      // Decoding settings are measured, not guessed.
      //   -mc 0 disables text-context carry-over. It is essential: with
      //   context enabled, a 97-minute 31kbps lecture fell into a hallucination
      //   loop at the 30-minute mark and never recovered, losing 67 minutes of
      //   content. Bounded values (32/64/128) all still looped. On clean audio
      //   -mc 0 costs nothing measurable and was in fact slightly more
      //   accurate, so the accuracy comes from the model, not from context.
      const wargs = [
        '-m', s.modelPath, '-f', wav, '-l', s.language || 'en',
        '-otxt', '-of', outBase,
        '-mc', '0',
        '--print-progress',
      ];
      this.courseContext = this.courseTerms(this.targetNoteFor(audio).path);
      const prompt = this.buildPrompt(priorNotes);
      if (prompt) wargs.push('--prompt', prompt);
      if (s.useVad && fs.existsSync(s.vadModelPath)) {
        wargs.push('--vad', '--vad-model', s.vadModelPath, '--vad-threshold', '0.5',
                   '--vad-min-silence-duration-ms', '500', '--vad-speech-pad-ms', '200');
      }
      // Greedy decoding instead of a 5-wide beam search. Measured on lecture
      // audio this was ~1.5x faster with no loss on the accuracy anchors and
      // no change in loop behaviour.
      if (s.fastDecode) wargs.push('-bs', '1', '-bo', '1');
      if (s.threads > 0) wargs.push('-t', String(s.threads));

      await this.run(s.whisperPath, wargs, (chunk) => {
        const m = /progress\s*=\s*(\d+)%/.exec(chunk);
        if (m && onProgress) onProgress('transcribing', parseInt(m[1], 10));
      });
      if (this.cancelRequested) throw new Cancelled();

      const txtPath = outBase + '.txt';
      if (!fs.existsSync(txtPath)) throw new Error('Whisper produced no transcript file');
      const raw = fs.readFileSync(txtPath, 'utf8');
      let { text, dropped, words, suspect } = reflow(raw);
      if (!text) throw new Error('Transcript was empty (no speech detected?)');
      const fixed = this.applyCorrections(text);
      text = fixed.text;
      const corrected = fixed.n;

      let mathInfo = null;
      if (this.settings.summarize && this.settings.mathInTranscript) {
        try {
          const m = await this.markupMath(text, onProgress);
          text = m.text;
          mathInfo = m;
        } catch (e) {
          if (e instanceof Cancelled) throw e;
          // keep the plain transcript rather than failing the whole run
        }
      }

      let digest = null, digestError = null;
      if (this.settings.summarize) {
        try {
          digest = await this.summarise(text, onProgress);
        } catch (e) {
          if (e instanceof Cancelled) throw e;
          // A failed summary must never cost you the transcript.
          digestError = e.message;
        }
      }

      onProgress && onProgress('writing note', 100);
      const note = await this.writeTranscript(audio, text, { dropped, suspect, digest, digestError, mathInfo });
      return { words, dropped, suspect, corrected, digest, digestError, mathInfo, note };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* temp dir already gone */ }
    }
  }

  /* Whisper accepts an initial prompt that biases its vocabulary. The best
   * available source of course-specific terms is what you already typed in
   * the note — "Piecewise functions" in the note makes "piecewise" far more
   * likely in the transcript. Capped to roughly the model's prompt budget. */
  /* A short list of substitutions for words Whisper reliably gets wrong for
   * you ("gravel" for "parabola"). Deterministic, applied after decoding, so
   * it fixes what prompting alone cannot. One rule per line: wrong => right */
  /* ---------- summary / key points via a local model -------------------
   * Everything stays on this machine; nothing about a lecture is uploaded.
   * -------------------------------------------------------------------*/
  // Roughly 1.4 tokens per word on this material, measured, plus headroom for
  // the model's own answer. Sizing the window to the text keeps short lectures
  // cheap instead of always paying for the largest window.
  // Reasoning models spend thousands of tokens thinking before they answer,
  // and that comes out of the same window as the prompt. A 1300-word lecture
  // once got a 4096 window, where prompt + thinking + answer did not fit, and
  // the reply came back unusable. Reserve accordingly and never go below 8k.
  outputReserve() {
    return this.settings.deepThinking ? 7000 : 2500;
  }

  contextFor(text) {
    const words = String(text).split(/\s+/).filter(Boolean).length;
    const needed = Math.ceil(words * 1.4) + this.outputReserve();
    const cap = Math.max(8192, this.settings.maxContext || 16384);
    return Math.min(cap, Math.max(8192, Math.ceil(needed / 1024) * 1024));
  }

  // The largest transcript that fits in one call, so chunking is a last resort.
  maxWordsPerCall() {
    const cap = Math.max(8192, this.settings.maxContext || 16384);
    return Math.max(800, Math.floor((cap - this.outputReserve()) / 1.4));
  }

  /* Ollama is called through Node's http module rather than Obsidian's
   * requestUrl. requestUrl goes through Chromium's network stack, which
   * suspends in-flight requests when the renderer is throttled — a summary
   * that takes a minute would die with ERR_NETWORK_IO_SUSPENDED as soon as
   * the display slept. Node's stack is not subject to that. */
  nodeRequest(method, urlStr, payload) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(urlStr); } catch (e) { reject(new Error(`Bad Ollama address: ${urlStr}`)); return; }
      const lib = u.protocol === 'https:' ? https : http;
      const data = payload ? Buffer.from(payload, 'utf8') : null;
      const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {};
      const timeoutMs = Math.max(1, this.settings.ollamaTimeoutMin || 20) * 60000;

      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method, headers,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });

      req.on('error', (e) => {
        this.activeReq = null;
        reject(new Error(`Could not reach Ollama at ${u.origin} — ${e.message}`));
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Ollama did not answer within ${Math.round(timeoutMs / 60000)} minutes`));
      });
      this.activeReq = req;
      if (data) req.write(data);
      req.end();
    });
  }

  async ollamaGenerate(prompt, system, modelOverride, opts) {
    const model = modelOverride || this.settings.ollamaModel;
    const url = `${this.settings.ollamaUrl.replace(/\/$/, '')}/api/generate`;
    const body = {
      model, prompt, system, stream: false,
      options: { num_ctx: (opts && opts.ctx) || this.contextFor(prompt + ' ' + (system || '')), temperature: 0.2 },
    };
    // Ollama reports a reasoning model's thinking separately, but it is still
    // generated into the same context window and takes several times longer.
    // Off by default: measured at 8s versus 25s with no real loss of quality.
    const wantThink = (opts && opts.think !== undefined) ? opts.think : this.settings.deepThinking;
    if (!wantThink) body.think = false;

    let res = null, lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.cancelRequested) throw new Cancelled();
      try { res = await this.nodeRequest('POST', url, JSON.stringify(body)); lastErr = null; break; }
      catch (e) { lastErr = e; }        // one retry covers a transient blip
    }
    this.activeReq = null;
    if (lastErr) throw lastErr;

    // Not every model accepts the think flag; drop it and try once more.
    if (res.status >= 400 && body.think === false && /think/i.test(res.body || '')) {
      delete body.think;
      res = await this.nodeRequest('POST', url, JSON.stringify(body));
      this.activeReq = null;
    }
    if (res.status !== 200) {
      throw new Error(`Ollama returned ${res.status}. Is it running, and is "${model}" pulled?`);
    }
    let parsed;
    try { parsed = JSON.parse(res.body); }
    catch (e) { throw new Error('Ollama returned a response that could not be read'); }
    if (parsed.done_reason === 'length') {
      throw new Error('The model ran out of room before finishing. Raise the summary context size.');
    }
    let out = parsed.response || '';
    // some models emit private reasoning first; it is not part of the answer
    return out.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  // Is a server actually answering? Distinguishes "not installed" from
  // "installed but not running", which need different advice.
  async ollamaVersion() {
    try {
      const res = await this.nodeRequest('GET', `${this.settings.ollamaUrl.replace(/\/$/, '')}/api/version`, null);
      this.activeReq = null;
      if (res.status !== 200) return '';
      return JSON.parse(res.body).version || 'unknown';
    } catch (e) { return ''; }
  }

  /* Downloading a model is the one part of Ollama setup that can be automated,
   * so it is: /api/pull streams newline-delimited progress. */
  ollamaPull(model, onProgress) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.settings.ollamaUrl.replace(/\/$/, '')}/api/pull`);
      const lib = url.protocol === 'https:' ? https : http;
      const data = Buffer.from(JSON.stringify({ model, stream: true }), 'utf8');
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      }, (res) => {
        let buf = '', failed = null;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            let j;
            try { j = JSON.parse(line); } catch (e) { continue; }
            if (j.error) { failed = j.error; continue; }
            if (onProgress) onProgress(j.status || '', j.completed || 0, j.total || 0);
          }
        });
        res.on('end', () => {
          this.activeReq = null;
          if (failed) reject(new Error(failed));
          else if (res.statusCode !== 200) reject(new Error(`Ollama returned ${res.statusCode} while downloading ${model}`));
          else resolve();
        });
      });
      req.on('error', (e) => { this.activeReq = null; reject(new Error(`Could not reach Ollama — ${e.message}`)); });
      req.setTimeout(90 * 60000, () => req.destroy(new Error('The download stalled')));
      this.activeReq = req;
      req.write(data);
      req.end();
    });
  }

  // If no summary model is chosen, or the chosen one is gone, adopt one that
  // is actually installed rather than failing every summary.
  async adoptInstalledModel() {
    let list = [];
    try {
      const res = await this.nodeRequest('GET', `${this.settings.ollamaUrl.replace(/\/$/, '')}/api/tags`, null);
      this.activeReq = null;
      if (res.status !== 200) return false;
      list = (JSON.parse(res.body).models || []).filter(m => m && m.name);
    } catch (e) { return false; }
    if (!list.length) return false;
    if (this.settings.ollamaModel && list.some(m => m.name === this.settings.ollamaModel)) return true;

    // Choose by size, not alphabetically. Very small models summarise poorly and
    // very large ones are slow, so prefer the smallest above ~2 GB.
    const withSize = list.map(m => ({ name: m.name, size: m.size || 0 }));
    const sane = withSize.filter(m => m.size >= 2e9).sort((a, b) => a.size - b.size);
    const pick = (sane[0] || withSize.sort((a, b) => b.size - a.size)[0]).name;

    this.settings.ollamaModel = pick;
    await this.saveSettings();
    return true;
  }

  async ollamaModels() {
    try {
      const res = await this.nodeRequest('GET', `${this.settings.ollamaUrl.replace(/\/$/, '')}/api/tags`, null);
      this.activeReq = null;
      if (res.status !== 200) return [];
      return (JSON.parse(res.body).models || []).map(m => m.name);
    } catch (e) { return []; }
  }

  /* ---------- LaTeX for Obsidian ---------------------------------------
   * Obsidian renders $...$ and $$...$$ only. Models reach for \( \), \[ \],
   * fenced blocks and equation environments, so normalise whatever comes back.
   * -------------------------------------------------------------------*/
  normalizeMath(text, inline) {
    if (!text) return text;
    let t = String(text);
    t = t.replace(/```(?:math|latex|tex)\s*\n?([\s\S]*?)```/gi, (_m, b) => `$$${b.trim()}$$`);
    t = t.replace(/\\\[([\s\S]*?)\\\]/g, (_m, b) => `$$${b.trim()}$$`);
    t = t.replace(/\\\(([\s\S]*?)\\\)/g, (_m, b) => `$${b.trim()}$`);
    t = t.replace(/\\begin\{(equation\*?|align\*?|displaymath)\}([\s\S]*?)\\end\{\1\}/g,
                  (_m, _e, b) => `$$${b.trim()}$$`);
    // A bullet is one line, and a $$ block inside it breaks the list, so keep
    // key points inline.
    if (inline) t = t.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (_m, b) => `$${b.replace(/\s+/g, ' ').trim()}$`);
    return t;
  }

  /* A verbatim transcript contains no intended LaTeX, but speech-to-text does
   * produce things like "$5 ... $10", and Obsidian would render everything
   * between that pair as maths. */
  escapeDollars(text) {
    return String(text).replace(/\$/g, () => '\\$');
  }

  chunkParagraphs(text, maxWords) {
    const paras = String(text).split(/\n\s*\n/);
    const out = [];
    let buf = [], n = 0;
    for (const para of paras) {
      const w = para.split(/\s+/).filter(Boolean).length;
      if (n && n + w > maxWords) { out.push(buf.join('\n\n')); buf = []; n = 0; }
      buf.push(para); n += w;
    }
    if (buf.length) out.push(buf.join('\n\n'));
    return out.filter(x => x.trim());
  }

  /* Optional: mark up spoken maths in the transcript itself. This rewrites the
   * transcript, so each chunk is only accepted if the model returned something
   * close to the same length — otherwise the original is kept. */
  async markupMath(text, onProgress) {
    const SYS =
      'You mark up mathematics in lecture transcripts. You are given raw speech-to-text. ' +
      'Rewrite it so spoken mathematics appears as LaTeX for Obsidian between single dollar ' +
      "signs, for example 'three x minus eight' becomes $3x - 8$. " +
      'STRICT RULES: keep every other word exactly as it is; do not summarise, reorder, ' +
      'correct grammar, or remove filler; do not add commentary; change ONLY the spans that ' +
      'are mathematics. Output the rewritten text and nothing else.';

    const chunks = this.chunkParagraphs(text, 400);
    const out = [];
    let kept = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (this.cancelRequested) throw new Cancelled();
      onProgress && onProgress(`formatting maths ${i + 1}/${chunks.length}`, 0);
      let piece = chunks[i];
      try {
        const r = this.normalizeMath(
          (await this.ollamaGenerate(piece, SYS, this.settings.mathModel || undefined)).trim());
        const a = piece.split(/\s+/).length, b = r.split(/\s+/).length;
        // LaTeX is more compact than spoken maths, so allow shrinkage but
        // reject anything that looks like the model rewrote or dropped content.
        if (r && b > a * 0.7 && b < a * 1.3) { piece = r; kept++; }
      } catch (e) {
        if (e instanceof Cancelled) throw e;   // leave the chunk as-is otherwise
      }
      out.push(piece);
    }
    return { text: out.join('\n\n'), converted: kept, chunks: chunks.length };
  }

  chunkWords(text, size, overlap) {
    const w = text.split(/\s+/).filter(Boolean);
    if (w.length <= size) return [text];
    const out = [];
    for (let i = 0; i < w.length; i += (size - overlap)) {
      out.push(w.slice(i, i + size).join(' '));
      if (i + size >= w.length) break;
    }
    return out;
  }

  // Scanned line by line rather than with one big regex: models drift on
  // format, drop sections, and wrap headings differently, and a partial
  // answer is still worth keeping.
  parseSummary(raw) {
    const clean = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
    let title = '', mode = null;
    const summary = [], points = [];

    for (const line of clean.split('\n')) {
      const t = line.trim();
      let m;
      if ((m = t.match(/^#*\s*TITLE\s*[:\-]\s*(.*)$/i))) { title = m[1]; mode = 'title'; continue; }
      if ((m = t.match(/^#*\s*SUMMARY\s*[:\-]?\s*(.*)$/i))) { mode = 'summary'; if (m[1]) summary.push(m[1]); continue; }
      if ((m = t.match(/^#*\s*KEY\s*POINTS?\s*[:\-]?\s*(.*)$/i))) { mode = 'points'; if (m[1]) points.push(m[1]); continue; }

      if (!t) { if (mode === 'title') mode = null; continue; }
      if (mode === 'summary') summary.push(t);
      else if (mode === 'points') points.push(t.replace(/^[-*\u2022]\s?/, '').replace(/^\d+[.)]\s?/, ''));
    }

    return {
      title: title.replace(/^["'#\s]+|["'\s]+$/g, '').trim(),
      summary: summary.join('\n').trim(),
      points: points.map(x => x.replace(/^[-*\u2022]\s?/, '').trim()).filter(x => x.length > 1),
    };
  }

  // Long lectures exceed any sane context window, so map each chunk to bullets
  // and reduce those into the final summary.
  async summarise(text, onProgress) {
    const SYSTEM =
      "You summarise university lecture transcripts for a student's notes. " +
      'The transcript is raw speech-to-text: it contains filler, false starts and ' +
      'transcription errors. Infer the intended meaning, and never invent facts that ' +
      'are not supported by the transcript. Be specific and concrete, and prefer the ' +
      "lecturer's own terminology.";
    const MATH =
      ' Write ALL mathematics as LaTeX for Obsidian: inline maths between single dollar signs ' +
      'like $f(x) = 3x - 8$, and displayed equations between double dollar signs. ' +
      'Never use \\( \\) or \\[ \\] delimiters, and never put maths in code fences.';
    const extra = (this.settings.summaryExtra || '').trim();
    let sys = SYSTEM + (this.settings.mathNotation ? MATH : '');
    if (extra) sys += ' ' + extra;

    const chunks = this.chunkWords(text, this.maxWordsPerCall(), 120);
    let material = text;

    if (chunks.length > 1) {
      const partials = [];
      for (let i = 0; i < chunks.length; i++) {
        if (this.cancelRequested) throw new Cancelled();
        onProgress && onProgress(`summarising ${i + 1}/${chunks.length}`, 0);
        const r = await this.ollamaGenerate(
          `This is part ${i + 1} of ${chunks.length} of one lecture transcript. ` +
          'List the substantive points it contains as concise bullets. No preamble.\n\n' + chunks[i],
          sys);
        partials.push(r);
      }
      material = partials.join('\n');
    }

    if (this.cancelRequested) throw new Cancelled();
    onProgress && onProgress('writing summary', 0);
    const finalPrompt =
      'Below is the content of one class session.\n\n' +
      'Respond in EXACTLY this format, with no preamble:\n\n' +
      'TITLE: <a short specific title, 3-8 words, no date>\n' +
      'SUMMARY:\n<3-5 sentences describing what the session covered>\n' +
      'KEYPOINTS:\n- <a specific point a student would revise from>\n- <5 to 9 bullets total>\n\n' +
      'CONTENT:\n' + material;

    let raw = await this.ollamaGenerate(finalPrompt, sys);
    let parsed = this.parseSummary(raw);

    // A model occasionally answers in a shape the parser cannot use. Rather
    // than lose the summary, try once more with the largest window allowed
    // and thinking off, which is the most reliable combination measured.
    if (!parsed.summary && !parsed.points.length) {
      if (this.cancelRequested) throw new Cancelled();
      onProgress && onProgress('retrying summary', 0);
      raw = await this.ollamaGenerate(finalPrompt, sys, undefined, {
        think: false,
        ctx: Math.max(8192, this.settings.maxContext || 16384),
      });
      parsed = this.parseSummary(raw);
    }
    if (this.settings.mathNotation) {
      parsed.summary = this.normalizeMath(parsed.summary, false);
      parsed.points = parsed.points.map(x => this.normalizeMath(x, true));
    }
    if (!parsed.summary && !parsed.points.length) {
      throw new Error('The model did not return a usable summary');
    }
    return parsed;
  }

  parseCorrections() {
    const out = [];
    for (const line of (this.settings.corrections || '').split('\n')) {
      const m = line.match(/^\s*(.+?)\s*(?:=>|->)\s*(.+?)\s*$/);
      if (!m) continue;
      const from = m[1].trim(), to = m[2].trim();
      if (!from) continue;
      const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // whole word when the term is wordlike, substring otherwise
      const body = /^[\w\s'-]+$/.test(from) ? `\\b${esc}\\b` : esc;
      try { out.push({ re: new RegExp(body, 'gi'), to }); } catch (e) { /* skip bad rule */ }
    }
    return out;
  }

  applyCorrections(text) {
    let n = 0;
    for (const { re, to } of this.parseCorrections()) {
      text = text.replace(re, () => { n++; return to; });
    }
    return { text, n };
  }

  /* Terms from the rest of the course, not just this one note: sibling note
   * titles and their headings. A calculus folder therefore primes calculus
   * words even in a lecture where you have not typed anything yet. */
  // Keyed off the note's folder, not the audio's: recordings are often kept
  // together in one folder (Voice/) while the notes live per course.
  courseTerms(notePath) {
    if (!this.settings.courseVocabulary) return '';
    const dir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '/';
    const terms = new Set();
    for (const f of this.app.vault.getFiles()) {
      if (f.extension !== 'md') continue;
      const fdir = f.parent ? f.parent.path : '/';
      if (fdir !== dir) continue;
      terms.add(f.basename.replace(/[0-9._-]+/g, ' ').trim());
      const cache = this.app.metadataCache.getFileCache(f);
      if (cache && cache.headings) {
        for (const h of cache.headings) terms.add(h.heading);
      }
    }
    return Array.from(terms).filter(t => t && t.length > 2).slice(0, 40).join('. ');
  }

  buildPrompt(noteContent) {
    const parts = [];
    const vocab = (this.settings.vocabulary || '').trim();
    if (vocab) parts.push(vocab);
    if (this.courseContext) parts.push(this.courseContext);

    if (this.settings.usePriorNotes && noteContent) {
      const t = noteContent
        .replace(/<!-- transcribed:[\s\S]*$/, '')      // drop earlier transcripts
        .replace(/^---[\s\S]*?\n---/, '')              // frontmatter
        .replace(/!\[\[[^\]]*\]\]/g, '')              // embeds
        .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
        .replace(/[#*_`>|-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (t) parts.push(t);
    }

    let p = parts.join('. ').trim();
    if (p.length > 800) p = p.slice(-800);   // ~224 token budget
    return p;
  }

  async writeTranscript(audio, text, info) {
    const { file, path: notePath } = this.targetNoteFor(audio);
    const stamp = window.moment ? window.moment().format('YYYY-MM-DD HH:mm') : new Date().toISOString().slice(0, 16).replace('T', ' ');
    const d = info && info.digest;
    const heading = (d && d.title) ? d.title : `${this.settings.headingLabel} — ${audio.name}`;
    const block = [
      '',
      marker(audio.name),
      `## ${heading}`,
      '',
      `*Transcribed ${stamp} with ${path.basename(this.settings.modelPath).replace(/^ggml-|\.bin$/g, '')}.*`,
      '',
    ];
    if (info && info.suspect) {
      block.push(
        '> [!warning] This transcript may be incomplete',
        `> Whisper repeated itself heavily here (${info.dropped} repeated lines removed), which usually means`,
        '> it stopped following the audio and some of the lecture is missing. Check it against the recording.',
        '',
      );
    }
    if (info && info.digestError) {
      block.push(`*Summary unavailable: ${info.digestError}*`, '');
    }
    if (d && d.summary) {
      block.push('### Summary', '', d.summary, '');
    }
    if (d && d.points && d.points.length) {
      block.push('### Key points', '', ...d.points.map(x => `- ${x}`), '');
    }
    // The raw transcript goes under its own heading so it folds away and the
    // summary stays visible.
    // Only a marked-up transcript should be treated as containing LaTeX.
    const bodyText = (info && info.mathInfo) ? text : this.escapeDollars(text);
    block.push('### Transcript', '', bodyText, '');
    const blockText = block.join('\n');

    let note = file;
    if (!note) note = await this.app.vault.create(notePath, '');

    // drop any previous transcript for this same recording, then append.
    // Vault.process is atomic, so a note being edited while a long lecture
    // finishes transcribing does not lose either change.
    const esc = audio.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\n*<!-- transcribed: ' + esc + ' -->[\\s\\S]*?(?=\\n<!-- transcribed: |$)');
    await this.app.vault.process(note, (existing) =>
      existing.replace(re, '').replace(/\s+$/, '') + '\n' + blockText);
    return note.path;
  }

  /* ---------- orchestration ---------------------------------------------- */

  async queueAuto(file) {
    if (this.running) return;
    if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) return;
    if (await this.isDone(file)) return;
    if (this.preflight().length) return;

    this.running = true;
    this.acquireAwake('transcribing');
    this.statusEl.setText(`🎙 transcribing ${file.name}…`);
    try {
      const r = await this.transcribeOne(file, (phase, pct) => {
        const shown = phase === 'transcribing' ? `${phase} ${pct || 0}%` : phase;
        this.statusEl.setText(`🎙 ${shown} — ${file.name}`);
      });
      const fixNote = r.corrected ? `, ${r.corrected} correction(s) applied` : '';
      new Notice(r.suspect
        ? `Transcribed ${file.name} — ${r.words} words${fixNote}, but it may be incomplete. See the warning in the note.`
        : `Transcribed ${file.name} — ${r.words} words${fixNote}`, r.suspect ? 10000 : undefined);
    } catch (e) {
      if (!(e instanceof Cancelled)) new Notice(`Transcription failed: ${e.message}`, 8000);
    } finally {
      this.releaseAwake('transcribing');
      this.running = false;
      this.refreshStatus();
    }
  }

  openRunner(files) {
    if (this.running) { new Notice('A transcription is already running.'); return; }
    new RunnerModal(this.app, this, files).open();
  }
};

/* ---------- setup: fetch what is missing ----------------------------------
 * The plugin needs a Whisper program and a model. Rather than making people
 * find and install those themselves, this downloads the right build for the
 * machine it is running on. Summaries additionally want Ollama, which cannot
 * be installed silently, so that stays a link.
 * -------------------------------------------------------------------------*/
const WHISPER_RELEASE = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/';
const WHISPER_ASSETS = {
  'win32-x64': 'whisper-bin-x64.zip',
  'win32-arm64': 'whisper-bin-win-cpu-arm64.zip',
  'linux-x64': 'whisper-bin-ubuntu-x64.tar.gz',
  'linux-arm64': 'whisper-bin-ubuntu-arm64.tar.gz',
};
const MODELS = {
  'ggml-large-v3-q5_0.bin': { mb: 1080, label: 'Accurate (1.1 GB) — recommended' },
  'ggml-large-v3-turbo-q5_0.bin': { mb: 574, label: 'Fast, less accurate (0.6 GB)' },
};
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
// Summary models, smallest first. Both are ordinary Ollama library tags.
const SUMMARY_MODELS = [
  { tag: 'qwen3:4b', label: 'qwen3:4b — about 2.6 GB, works on most machines' },
  { tag: 'qwen3:8b', label: 'qwen3:8b — about 5.2 GB, better key points' },
];
const VAD_MODEL = 'ggml-silero-v5.1.2.bin';

function downloadTo(url, dest, onProgress, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 6) { reject(new Error('Too many redirects')); return; }
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'obsidian-lecture-transcriber' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(downloadTo(new URL(res.headers.location, url).toString(), dest, onProgress, (redirects || 0) + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed (${res.statusCode}) for ${url}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (c) => { got += c.length; if (onProgress) onProgress(got, total); });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => {
        out.close(() => { try { fs.renameSync(tmp, dest); resolve(dest); } catch (e) { reject(e); } });
      });
    });
    req.on('error', reject);
    req.setTimeout(20 * 60000, () => req.destroy(new Error('Download timed out')));
  });
}

/* Zips are unpacked in JavaScript rather than by shelling out to tar. tar.exe
 * exists on current Windows but is not guaranteed to be reachable, and relying
 * on it made unpacking the most fragile step of setup. zlib is built into Node,
 * so this needs nothing from the machine. */
function unzip(file, destDir) {
  const buf = fs.readFileSync(file);
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('The downloaded file is not a zip archive (the download may have been blocked or redirected)');
  }

  // End of central directory: scan back for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The zip archive is damaged (no directory found)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let written = 0;

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    // Never let an archive write outside the destination.
    const safe = path.normalize(name).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const out = path.join(destDir, safe);
    if (!path.resolve(out).startsWith(path.resolve(destDir))) continue;

    const lnLen = buf.readUInt16LE(localOff + 26);
    const lxLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnLen + lxLen;
    const raw = buf.slice(start, start + compSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`The zip uses an unsupported compression method (${method})`);

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    written++;
  }
  if (!written) throw new Error('The zip archive contained no files');
}

// .tar.gz (Linux builds) still goes through tar, which Linux always has.
function untarGz(file, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', file, '-C', destDir], { stdio: 'ignore' });
    proc.on('error', () => reject(new Error('Could not run tar to unpack the download')));
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Unpacking failed (tar exited ${code})`)));
  });
}

async function extractArchive(file, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (/\.zip$/i.test(file)) unzip(file, destDir);
  else await untarGz(file, destDir);
}

/* The Windows archive contains whisper-cli.exe and also main.exe, which is the
 * deprecated older CLI. Matching whichever the filesystem happened to list
 * first could pick main.exe and then pass it flags built for whisper-cli, so
 * candidates are collected and then chosen in WHISPER_NAMES order. */
function findWhisperIn(dir) {
  const found = new Map();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      const base = e.name.toLowerCase();
      for (const n of WHISPER_NAMES) {
        if (base === (n + EXE).toLowerCase() && !found.has(n)) found.set(n, full);
      }
    }
  }
  for (const n of WHISPER_NAMES) if (found.has(n)) return found.get(n);
  return '';
}

/* Runs the program once so a broken or incompatible download is reported during
 * setup, with the reason, instead of failing on the first real lecture with an
 * exit code. Also catches a missing runtime DLL on Windows. */
function verifyWhisper(bin) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, ['--help'], { windowsHide: true });
    } catch (e) {
      resolve(`could not be started (${e.message})`);
      return;
    }
    let out = '';
    const done = (msg) => { try { proc.kill(); } catch (e) { /* gone */ } resolve(msg); };
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('error', (e) => done(`could not be started (${e.message})`));
    proc.on('close', () => {
      // --help exits non-zero on some builds, so look for the usage text.
      if (/usage|--model|-m FNAME/i.test(out)) resolve('');
      else resolve(`ran but did not look like Whisper. Output was: ${out.slice(0, 200) || '(nothing)'}`);
    });
    setTimeout(() => done('did not respond'), 20000);
  });
}

class SetupModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; this.busy = false; }

  async onOpen() {
    this.titleEl.setText('Set up Transcriber and Summary for Idiots');
    this.render();
  }

  status() {
    const s = this.plugin.settings;
    const has = (p) => !!p && fs.existsSync(p);
    return {
      whisper: has(s.whisperPath),
      model: has(s.modelPath),
      vad: has(s.vadModelPath),
    };
  }

  async render() {
    const c = this.contentEl;
    c.empty();
    const st = this.status();
    // Asked once per render; the rows below are drawn from it.
    this.ollama = { version: await this.plugin.ollamaVersion(), models: [] };
    if (this.ollama.version) this.ollama.models = await this.plugin.ollamaModels();

    c.createEl('p', { text: 'Everything runs on this computer. Nothing is uploaded.' , cls: 'lt-summary' });

    const list = c.createDiv({ cls: 'lt-modal-list' });
    const row = (name, ok, note) => {
      const r = list.createDiv({ cls: 'lt-row' + (ok ? ' is-done' : '') });
      r.createDiv({ cls: 'lt-row-name', text: name });
      r.createDiv({ cls: 'lt-row-state', text: ok ? 'ready' : (note || 'missing') });
    };
    row('Whisper program', st.whisper, IS_MAC && !st.whisper ? 'needs Homebrew' : 'will download');
    row('Speech model', st.model, `will download ${MODELS[path.basename(this.plugin.settings.modelPath)] ? MODELS[path.basename(this.plugin.settings.modelPath)].mb + ' MB' : ''}`);
    row('Silence detection model', st.vad, 'will download 1 MB');

    // Summaries are optional, so this is reported separately and never blocks
    // transcription.
    const oll = this.ollama;
    const hasModel = oll.models.length > 0;
    row('Ollama (only needed for summaries)',
        !!oll.version && hasModel,
        !oll.version ? 'not running — optional' : (hasModel ? '' : 'no model yet'));

    if (!oll.version) {
      const help = c.createDiv({ cls: 'lt-summary' });
      help.createSpan({ text: 'Transcripts work without Ollama. For summaries and key points, install it, open it once so it runs in the background, then reopen this window. ' });
      help.createEl('a', { text: 'Get Ollama', href: 'https://ollama.com/download' });
      const cmd = IS_MAC ? 'brew install --cask ollama' : (IS_WIN ? 'winget install Ollama.Ollama' : 'curl -fsSL https://ollama.com/install.sh | sh');
      c.createEl('p', { text: `Or from a terminal:  ${cmd}`, cls: 'lt-summary' });
    } else if (!hasModel) {
      c.createEl('p', {
        text: `Ollama ${oll.version} is running but has no model yet. Pick one and it will be downloaded for you:`,
        cls: 'lt-summary',
      });
      const pickRow = c.createDiv({ cls: 'lt-buttons' });
      for (const m of SUMMARY_MODELS) {
        const b = pickRow.createEl('button', { text: `Download ${m.tag}` });
        b.setAttr('title', m.label);
        b.onclick = () => this.pullModel(m.tag, b);
      }
    }

    this.progress = c.createDiv({ cls: 'lt-bar' }).createDiv({ cls: 'lt-bar-fill' });
    this.msg = c.createDiv({ cls: 'lt-summary', text: '' });

    const buttons = c.createDiv({ cls: 'lt-buttons' });
    buttons.createEl('button', { text: 'Close' }).onclick = () => this.close();

    if (st.whisper && st.model && st.vad) {
      this.msg.setText(this.ollama.version && this.ollama.models.length
        ? 'Everything is installed. Close this and press the microphone in the left sidebar.'
        : 'Transcription is ready. Close this and press the microphone in the left sidebar. Summaries need the Ollama step above.');
      return;
    }
    const go = buttons.createEl('button', { text: 'Install what is missing', cls: 'mod-cta' });
    go.onclick = () => this.install(go);
  }

  async pullModel(tag, btn) {
    if (this.busy) return;
    this.busy = true;
    btn.disabled = true;
    try {
      await this.plugin.ollamaPull(tag, (status, done, total) => {
        const pct = total ? (done / total) * 100 : 0;
        const mb = total ? ` — ${(done / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB` : '';
        this.say(`${status}${mb}`, pct);
      });
      this.plugin.settings.ollamaModel = tag;
      await this.plugin.saveSettings();
      this.say(`${tag} installed. Summaries are on.`, 100);
    } catch (e) {
      this.say(`Could not download ${tag}: ${e.message}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  say(text, pct) {
    if (this.msg) this.msg.setText(text);
    if (this.progress && typeof pct === 'number') this.progress.style.setProperty('--lt-progress', `${Math.round(pct)}%`);
  }

  async install(btn) {
    if (this.busy) return;
    this.busy = true;
    btn.disabled = true;
    btn.setText('Working…');
    try {
      await this.ensureWhisper();
      await this.ensureModel(path.basename(this.plugin.settings.modelPath), 'modelPath');
      await this.ensureModel(VAD_MODEL, 'vadModelPath');
      await this.plugin.saveSettings();
      this.say('Done. Checking it works…', 100);
      const check = this.plugin.preflight();
      this.say(check.length ? `Still missing: ${check.join(', ')}` : 'Ready. Press the microphone in the left sidebar to transcribe.', 100);
      this.busy = false;
      this.render();
    } catch (e) {
      this.busy = false;
      btn.disabled = false;
      btn.setText('Try again');
      this.say(`Could not finish: ${e.message}`);
    }
  }

  async ensureWhisper() {
    const s = this.plugin.settings;
    if (s.whisperPath && fs.existsSync(s.whisperPath)) return;

    const found = findBinary(WHISPER_NAMES);
    if (found) { s.whisperPath = found; return; }

    const key = `${process.platform}-${process.arch}`;
    const asset = WHISPER_ASSETS[key];
    if (!asset) {
      // macOS has no official prebuilt CLI, so offer the one-line install.
      if (IS_MAC) {
        const brew = findBinary(['brew']);
        if (!brew) {
          throw new Error('On macOS, install Homebrew from brew.sh, then run:  brew install whisper-cpp');
        }
        this.say('Installing whisper-cpp with Homebrew (this can take a few minutes)…', 10);
        await new Promise((resolve, reject) => {
          const proc = spawn(brew, ['install', 'whisper-cpp'], { stdio: 'ignore' });
          proc.on('error', reject);
          proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('brew install whisper-cpp failed — run it in a terminal to see why')));
        });
        s.whisperPath = findBinary(WHISPER_NAMES);
        if (!s.whisperPath) throw new Error('Homebrew finished but whisper-cli was still not found');
        return;
      }
      throw new Error(`No prebuilt Whisper is published for ${key}. Build whisper.cpp yourself and set the path in settings.`);
    }

    const url = WHISPER_RELEASE + asset;
    const archive = path.join(dataDir(), asset);

    // Each stage names itself, because "setup failed" is useless to act on.
    this.say(`Downloading Whisper for ${key}…`, 0);
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await downloadTo(url, archive,
          (got, total) => this.say(`Downloading Whisper… ${(got / 1e6).toFixed(0)}${total ? ' of ' + (total / 1e6).toFixed(0) : ''} MB`,
                                   total ? (got / total) * 100 : 0));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        try { fs.unlinkSync(archive + '.part'); } catch (e2) { /* nothing to clean */ }
        if (attempt === 1) this.say('Download failed, retrying once…', 0);
      }
    }
    if (lastErr) {
      throw new Error(`Download step failed: ${lastErr.message}. URL was ${url}. ` +
        'If this keeps happening, a firewall, VPN or antivirus is usually blocking github.com; ' +
        'you can also download that file in a browser and put it in ' + dataDir());
    }

    const size = (() => { try { return fs.statSync(archive).size; } catch (e) { return 0; } })();
    if (size < 100000) {
      throw new Error(`Download step produced only ${size} bytes, which is not the real file. Something between this computer and github.com replaced it.`);
    }

    this.say('Unpacking…', 100);
    try {
      await extractArchive(archive, BIN_DIR);
    } catch (e) {
      throw new Error(`Unpack step failed: ${e.message}. The archive is at ${archive} if you want to unzip it by hand into ${BIN_DIR}.`);
    }
    try { fs.unlinkSync(archive); } catch (e) { /* leave it */ }

    const bin = findWhisperIn(BIN_DIR);
    if (!bin) throw new Error('Downloaded Whisper but could not find the program inside the archive');
    if (!IS_WIN) { try { fs.chmodSync(bin, 0o755); } catch (e) { /* best effort */ } }

    this.say('Checking the download works…', 100);
    const bad = await verifyWhisper(bin);
    if (bad) {
      throw new Error(`Whisper downloaded but ${bad}` +
        (IS_WIN ? ' On Windows this is usually a missing Visual C++ runtime — install "Microsoft Visual C++ Redistributable (x64)" and press Install again.' : ''));
    }
    s.whisperPath = bin;
  }

  async ensureModel(fileName, settingKey) {
    const dest = path.join(MODEL_DIR, fileName);
    if (fs.existsSync(dest)) { this.plugin.settings[settingKey] = dest; return; }
    const label = (MODELS[fileName] && MODELS[fileName].label) || fileName;
    this.say(`Downloading ${label}…`, 0);
    await downloadTo(MODEL_BASE + fileName, dest,
      (got, total) => this.say(`Downloading ${label} — ${(got / 1e6).toFixed(0)} MB`, total ? (got / total) * 100 : 0));
    this.plugin.settings[settingKey] = dest;
  }
}

/* ---------- the button's modal --------------------------------------------*/

class RunnerModal extends Modal {
  constructor(app, plugin, preset) {
    super(app);
    this.plugin = plugin;
    this.preset = preset || null;
    this.rows = new Map();
  }

  async onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText('Transcribe audio');

    const missing = this.plugin.preflight();
    if (missing.length) {
      contentEl.createEl('p', { text: `Not set up yet — ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing.` });
      contentEl.createEl('p', {
        text: 'The setup step downloads them for this computer. Everything stays local.',
        cls: 'lt-summary',
      });
      const b = contentEl.createDiv({ cls: 'lt-buttons' });
      b.createEl('button', { text: 'Close' }).onclick = () => this.close();
      b.createEl('button', { text: 'Set up now', cls: 'mod-cta' }).onclick = () => {
        this.close();
        new SetupModal(this.app, this.plugin).open();
      };
      return;
    }

    const all = this.preset || this.plugin.allAudio();
    this.todo = [];
    this.alreadyDone = 0;
    for (const f of all) {
      if (await this.plugin.isDone(f)) this.alreadyDone++;
      else this.todo.push(f);
    }

    if (!this.todo.length) {
      contentEl.createEl('p', {
        text: this.alreadyDone
          ? `Nothing to do — all ${this.alreadyDone} recording(s) are already transcribed.`
          : 'No audio files found in this vault.',
      });
      const b = contentEl.createDiv({ cls: 'lt-buttons' });
      b.createEl('button', { text: 'Close' }).onclick = () => this.close();
      return;
    }

    contentEl.createEl('p', {
      text: `${this.todo.length} recording(s) to transcribe` +
            (this.alreadyDone ? `, ${this.alreadyDone} already done.` : '.'),
    });

    const list = contentEl.createDiv({ cls: 'lt-modal-list' });
    for (const f of this.todo) {
      const row = list.createDiv({ cls: 'lt-row' });
      row.createDiv({ cls: 'lt-row-name', text: f.path });
      const state = row.createDiv({ cls: 'lt-row-state', text: 'queued' });
      this.rows.set(f.path, { row, state });
    }

    this.bar = contentEl.createDiv({ cls: 'lt-bar' }).createDiv({ cls: 'lt-bar-fill' });
    this.summary = contentEl.createDiv({ cls: 'lt-summary', text: 'Runs locally. A one-hour lecture takes a couple of minutes.' });

    const buttons = contentEl.createDiv({ cls: 'lt-buttons' });
    this.cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    this.cancelBtn.onclick = () => {
      this.plugin.cancelRequested = true;
      if (this.plugin.activeProc) { try { this.plugin.activeProc.kill('SIGTERM'); } catch (e) { /* gone */ } }
      if (this.plugin.activeReq) { try { this.plugin.activeReq.destroy(); } catch (e) { /* gone */ } }
      this.cancelBtn.setText('Stopping…');
      this.cancelBtn.disabled = true;
    };
    this.startBtn = buttons.createEl('button', { text: `Transcribe ${this.todo.length}`, cls: 'mod-cta' });
    this.startBtn.onclick = () => this.start();
  }

  async start() {
    this.startBtn.disabled = true;
    this.startBtn.setText('Working…');
    this.plugin.running = true;
    this.plugin.cancelRequested = false;
    this.plugin.acquireAwake('transcribing');

    let done = 0, failed = 0, totalWords = 0, suspect = 0;
    for (let i = 0; i < this.todo.length; i++) {
      if (this.plugin.cancelRequested) break;
      const f = this.todo[i];
      const { row, state } = this.rows.get(f.path);
      row.addClass('is-active');
      state.setText('starting…');

      try {
        const r = await this.plugin.transcribeOne(f, (phase, pct) => {
          state.setText(phase === 'transcribing' ? `${pct}%` : phase);
        });
        row.removeClass('is-active'); row.addClass('is-done');
        if (r.suspect) {
          row.addClass('is-failed');
          state.setText(`${r.words} words ⚠`);
          state.setAttr('title', 'Whisper repeated itself heavily — the transcript may be missing content. See the warning in the note.');
          suspect++;
        } else {
          state.setText(`${r.words} words`);
        }
        totalWords += r.words;
        done++;
      } catch (e) {
        row.removeClass('is-active');
        if (e instanceof Cancelled) { state.setText('cancelled'); break; }
        row.addClass('is-failed');
        state.setText('failed');
        state.setAttr('title', e.message);
        failed++;
      }
      this.bar.style.setProperty('--lt-progress', `${Math.round(((i + 1) / this.todo.length) * 100)}%`);
    }

    this.plugin.releaseAwake('transcribing');
    this.plugin.running = false;
    this.plugin.cancelRequested = false;
    this.plugin.refreshStatus();

    this.summary.setText(
      `Done — ${done} transcribed (${totalWords.toLocaleString()} words)` +
      (failed ? `, ${failed} failed` : '') +
      (suspect ? `, ${suspect} may be incomplete — check the warning in those notes` : '') +
      (failed || suspect ? '. Hover a marked row for details.' : '.'));
    this.cancelBtn.setText('Close');
    this.cancelBtn.disabled = false;
    this.cancelBtn.onclick = () => this.close();
    this.startBtn.hide();
    if (done) new Notice(`Transcribed ${done} recording(s).`);
  }

  onClose() { this.contentEl.empty(); }
}

/* ---------- settings ------------------------------------------------------*/

class TranscriberSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const st = this.plugin.preflight();
    new Setting(containerEl)
      .setName('Setup')
      .setDesc(st.length
        ? `Not ready — ${st.join(' and ')} missing. Setup downloads the right build for this computer.`
        : 'Whisper and the model are installed.')
      .addButton(b => b.setButtonText(st.length ? 'Set up' : 'Check again')
        .setCta(st.length > 0)
        .onClick(() => new SetupModal(this.app, this.plugin).open()));

    new Setting(containerEl)
      .setName('Transcribe everything now')
      .setDesc('Scan the vault and transcribe every recording that does not have a transcript yet.')
      .addButton(b => b.setButtonText('Transcribe all').setCta().onClick(() => {
        this.plugin.openRunner();
      }));

    new Setting(containerEl).setName('Behaviour').setHeading();

    new Setting(containerEl)
      .setName('Transcribe new recordings automatically')
      .setDesc('When a recording appears in the vault, transcribe it without being asked.')
      .addToggle(t => t.setValue(this.plugin.settings.autoTranscribeNew).onChange(async v => {
        this.plugin.settings.autoTranscribeNew = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Keep the Mac awake while transcribing')
      .setDesc('Holds a power assertion for the whole run so the machine does not sleep mid-lecture. The screen may still turn off. A closed lid will still sleep — macOS does not allow overriding that.')
      .addToggle(t => t.setValue(this.plugin.settings.keepAwake).onChange(async v => {
        this.plugin.settings.keepAwake = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Keep the Mac awake while recording')
      .setDesc('Holds the machine awake for as long as a recording is running, so a long lecture cannot be cut short by the Mac going to sleep. Detected automatically when recording starts.')
      .addToggle(t => t.setValue(this.plugin.settings.keepAwakeRecording).onChange(async v => {
        this.plugin.settings.keepAwakeRecording = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Keep the screen on too')
      .setDesc('Recommended. When the display sleeps, Obsidian gets throttled and a summary in progress can die with a network error. Your Mac is currently set to sleep the display after 2 minutes on battery.')
      .addToggle(t => t.setValue(this.plugin.settings.keepScreenOn).onChange(async v => {
        this.plugin.settings.keepScreenOn = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName('Accuracy').setHeading();

    new Setting(containerEl)
      .setName('Use the rest of the course as vocabulary')
      .setDesc('Also primes Whisper with note titles and headings from other notes in the same course folder, so a new lecture benefits from terms you wrote in earlier ones.')
      .addToggle(t => t.setValue(this.plugin.settings.courseVocabulary).onChange(async v => {
        this.plugin.settings.courseVocabulary = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Corrections')
      .setDesc('Words Whisper reliably gets wrong, one rule per line, written as  wrong => right.  Applied to every transcript after decoding, so these are guaranteed fixes rather than hints.')
      .addTextArea(t => {
        t.setPlaceholder('gravel => parabola\nSoundario => scenario\nDr. Thurman => Dr. Thierman')
         .setValue(this.plugin.settings.corrections)
         .onChange(async v => { this.plugin.settings.corrections = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 5;
        t.inputEl.addClass('lt-input-wide');
      });

    new Setting(containerEl)
      .setName('Use my notes to improve accuracy')
      .setDesc('Feeds the notes you already typed in the target note to Whisper as vocabulary. Typing "piecewise functions" makes the transcript far likelier to get that term right.')
      .addToggle(t => t.setValue(this.plugin.settings.usePriorNotes).onChange(async v => {
        this.plugin.settings.usePriorNotes = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Extra vocabulary')
      .setDesc('Names and terms Whisper keeps mishearing — professors, course codes, jargon. Plain comma-separated text, applied to every recording.')
      .addTextArea(t => {
        t.setPlaceholder('Dr. Thierman, Drexel, CS-180, MYCIN, Kasparov, piecewise, asymptote')
         .setValue(this.plugin.settings.vocabulary)
         .onChange(async v => { this.plugin.settings.vocabulary = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 3;
        t.inputEl.addClass('lt-input-wide');
      });

    new Setting(containerEl)
      .setName('Clean up audio first')
      .setDesc('High-pass, denoise and normalise before recognition. Strongly recommended for quiet or low-bitrate lecture recordings.')
      .addToggle(t => t.setValue(this.plugin.settings.cleanAudio).onChange(async v => {
        this.plugin.settings.cleanAudio = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Skip silence (VAD)')
      .setDesc('Cut silent stretches before recognition. This is the main defence against Whisper repetition loops.')
      .addToggle(t => t.setValue(this.plugin.settings.useVad).onChange(async v => {
        this.plugin.settings.useVad = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName('Speed').setHeading();

    new Setting(containerEl)
      .setName('Fast decoding')
      .setDesc('Uses greedy decoding instead of a 5-wide beam search. Measured on lecture audio this was about 1.5x faster with no difference on accuracy checks. Turn off if you suspect a specific recording is being decoded badly.')
      .addToggle(t => t.setValue(this.plugin.settings.fastDecode).onChange(async v => {
        this.plugin.settings.fastDecode = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Summary context size')
      .setDesc('The largest window given to the summary model. Bigger means long lectures are summarised in one pass instead of several, which is faster and better, but uses more memory. The window is sized down automatically for short recordings.')
      .addDropdown(dd => {
        for (const n of [8192, 16384, 32768]) dd.addOption(String(n), `${n / 1024}k tokens`);
        dd.setValue(String(this.plugin.settings.maxContext))
          .onChange(async v => { this.plugin.settings.maxContext = parseInt(v, 10); await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName('Language')
      .setDesc("Two-letter code, or 'auto' to detect.")
      .addText(t => t.setValue(this.plugin.settings.language).onChange(async v => {
        this.plugin.settings.language = v.trim() || 'en'; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Transcript heading')
      .addText(t => t.setValue(this.plugin.settings.headingLabel).onChange(async v => {
        this.plugin.settings.headingLabel = v.trim() || 'Transcript'; await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName('Summary and key points').setHeading();

    new Setting(containerEl)
      .setName('Generate a summary and key points')
      .setDesc('Runs a local model (Ollama) over the finished transcript and writes a summary and key points above it, under a generated title. Nothing leaves this Mac. If it fails, the transcript is still saved.')
      .addToggle(t => t.setValue(this.plugin.settings.summarize).onChange(async v => {
        this.plugin.settings.summarize = v; await this.plugin.saveSettings();
      }));

    const modelSetting = new Setting(containerEl)
      .setName('Summary model')
      .setDesc('Loading models from Ollama…');
    this.plugin.ollamaModels().then(models => {
      if (!models.length) {
        modelSetting.setDesc('Could not reach Ollama. Start it, or turn the summary off above.');
        modelSetting.addText(t => t.setValue(this.plugin.settings.ollamaModel)
          .onChange(async v => { this.plugin.settings.ollamaModel = v.trim(); await this.plugin.saveSettings(); }));
        return;
      }
      modelSetting.setDesc('Larger models give noticeably better key points and take longer.');
      modelSetting.addDropdown(dd => {
        for (const m of models) dd.addOption(m, m);
        if (!models.includes(this.plugin.settings.ollamaModel)) dd.addOption(this.plugin.settings.ollamaModel, this.plugin.settings.ollamaModel + ' (not installed)');
        dd.setValue(this.plugin.settings.ollamaModel)
          .onChange(async v => { this.plugin.settings.ollamaModel = v; await this.plugin.saveSettings(); });
      });
    });

    new Setting(containerEl)
      .setName('Summary instructions')
      .setDesc('Optional extra direction, e.g. "Call out anything stated as being on the exam." Added to every summary request.')
      .addTextArea(t => {
        t.setPlaceholder('Call out due dates and anything described as exam material.')
         .setValue(this.plugin.settings.summaryExtra)
         .onChange(async v => { this.plugin.settings.summaryExtra = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 2; t.inputEl.addClass('lt-input-wide');
      });

    new Setting(containerEl)
      .setName('Write maths as LaTeX')
      .setDesc('Has the summary and key points use Obsidian maths notation, so $x = -\\frac{b}{2a}$ renders as an equation instead of plain text.')
      .addToggle(t => t.setValue(this.plugin.settings.mathNotation).onChange(async v => {
        this.plugin.settings.mathNotation = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Also mark up maths in the transcript')
      .setDesc('SLOW, and it rewrites the transcript rather than only adding to it. Roughly a minute of processing per 400 words on a large model — about 35 minutes for a one-hour lecture. Each passage is only accepted if it comes back the same length, otherwise the original wording is kept. Worth it for maths classes, not for others.')
      .addToggle(t => t.setValue(this.plugin.settings.mathInTranscript).onChange(async v => {
        this.plugin.settings.mathInTranscript = v; await this.plugin.saveSettings();
      }));

    const mathModelSetting = new Setting(containerEl)
      .setName('Model for transcript maths')
      .setDesc('Leave as the summary model unless you want to trade accuracy for speed. Smaller models are faster but tend to wrap every loose number in dollar signs.');
    this.plugin.ollamaModels().then(models => {
      mathModelSetting.addDropdown(dd => {
        dd.addOption('', 'Same as summary model');
        for (const m of models) dd.addOption(m, m);
        dd.setValue(this.plugin.settings.mathModel || '')
          .onChange(async v => { this.plugin.settings.mathModel = v; await this.plugin.saveSettings(); });
      });
    });

    new Setting(containerEl)
      .setName('Give up after')
      .setDesc('How long to wait for one reply from the summary model before treating it as failed.')
      .addDropdown(dd => {
        for (const n of [5, 10, 20, 45]) dd.addOption(String(n), `${n} minutes`);
        dd.setValue(String(this.plugin.settings.ollamaTimeoutMin))
          .onChange(async v => { this.plugin.settings.ollamaTimeoutMin = parseInt(v, 10); await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName('Let the model think first')
      .setDesc('Reasoning models can plan before answering. Measured on a lecture this took 25 seconds instead of 8, for no real gain, and the extra thinking competes with the answer for space in the context window. Leave off unless you want the deepest possible key points.')
      .addToggle(t => t.setValue(this.plugin.settings.deepThinking).onChange(async v => {
        this.plugin.settings.deepThinking = v; await this.plugin.saveSettings();
      }));

    const test = new Setting(containerEl)
      .setName('Test the summary model')
      .setDesc('Sends a short request and reports what happens, so you can check it without transcribing a lecture.');
    const result = test.controlEl.createSpan({ cls: 'lt-row-state' });
    test.addButton(b => b.setButtonText('Test').onClick(async () => {
      result.setText(' running…');
      result.className = 'lt-row-state lt-state-muted';
      const t0 = Date.now();
      try {
        const r = await this.plugin.summarise(
          'Today we covered the quadratic formula and how to find the vertex of a parabola. ' +
          'We also went over the domain and range of simple functions.', null);
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        result.setText(` ✓ worked in ${secs}s — "${(r.title || 'untitled').slice(0, 40)}"`);
        result.className = 'lt-row-state lt-state-ok';
      } catch (e) {
        result.setText(` ✗ ${e.message}`);
        result.className = 'lt-row-state lt-state-bad';
      }
    }));

    new Setting(containerEl)
      .setName('Ollama address')
      .addText(t => { t.setValue(this.plugin.settings.ollamaUrl)
        .onChange(async v => { this.plugin.settings.ollamaUrl = v.trim() || 'http://localhost:11434'; await this.plugin.saveSettings(); });
        t.inputEl.addClass('lt-input-url'); });

    new Setting(containerEl).setName('Paths').setHeading();

    const pathSetting = (name, key, desc) => {
      const s = new Setting(containerEl).setName(name);
      if (desc) s.setDesc(desc);
      s.addText(t => {
        t.setValue(this.plugin.settings[key]).onChange(async v => {
          this.plugin.settings[key] = v.trim(); await this.plugin.saveSettings();
          mark();
        });
        t.inputEl.addClass('lt-input-path');
      });
      const status = s.controlEl.createSpan({ cls: 'lt-row-state' });
      const optional = key === 'ffmpegPath';
      const mark = () => {
        const v = this.plugin.settings[key];
        const ok = !!v && fs.existsSync(v);
        if (ok) { status.setText(' ✓'); status.className = 'lt-row-state lt-state-ok'; return; }
        status.setText(optional ? ' not installed (fine)' : ' ✗ not found');
        status.className = 'lt-row-state ' + (optional ? 'lt-state-muted' : 'lt-state-bad');
      };
      mark();
    };

    pathSetting('Whisper program', 'whisperPath', 'Found automatically, or installed by Setup above.');
    pathSetting('ffmpeg (optional)', 'ffmpegPath', 'Not needed normally — Obsidian decodes audio itself. Only used as a fallback for a format it refuses.');
    pathSetting('Whisper model', 'modelPath', 'ggml-large-v3.bin is the most accurate. ggml-large-v3-turbo.bin is about 3x faster but measurably worse on lecture audio.');
    pathSetting('VAD model', 'vadModelPath', 'Silero VAD model. Optional, but keeps long recordings from looping.');
  }
}
