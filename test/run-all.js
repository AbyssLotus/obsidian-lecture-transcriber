#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const dir = __dirname;
const ROOT = path.join(dir, '..');

// main.js does require('obsidian'), which only exists inside Obsidian. Tests
// run against a committed stub, copied into node_modules so Node resolves it
// from src/ the same way it would in the real app.
(function installStub() {
  const from = path.join(dir, 'stubs', 'obsidian');
  const to = path.join(ROOT, 'node_modules', 'obsidian');
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
})();
// Any *.test.js, plus the numbered suites. Anything needing a real Whisper or
// Ollama (e2e, repro, mkwav) is deliberately excluded — CI has neither.
const MANUAL = new Set(['e2e.js', 'repro.js', 'mkwav.js', 'run-all.js']);
const suites = fs.readdirSync(dir)
  .filter(f => f.endsWith('.js') && !MANUAL.has(f))
  .filter(f => /\.test\.js$/.test(f) || /^test\d+\.js$/.test(f))
  .sort();
let total = 0, failed = 0;
for (const s of suites) {
  let out = '';
  try { out = execFileSync('node', [path.join(dir, s)], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const m = out.match(/=== (\d+) passed, (\d+) failed ===/);
  if (m) { total += +m[1]; failed += +m[2]; console.log(`${s.padEnd(20)} ${m[1]} passed, ${m[2]} failed`); }
  else { failed++; console.log(`${s.padEnd(20)} DID NOT REPORT\n${out.slice(-500)}`); }
}
console.log(`\nTOTAL: ${total} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
