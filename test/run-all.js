#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const dir = __dirname;
const suites = fs.readdirSync(dir).filter(f => /^(test\d+|platform\.test)\.js$/.test(f)).sort();
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
