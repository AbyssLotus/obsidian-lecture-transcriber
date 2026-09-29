#!/usr/bin/env node
/* Assembles the three files Obsidian loads into dist/, and with --install
 * copies them straight into a vault for testing. */
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const FILES = ['manifest.json', 'styles.css'];
const dist = path.join(ROOT, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'src', 'main.js'), path.join(dist, 'main.js'));
for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dist, f));

const id = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).id;
console.log(`built dist/ (${fs.readdirSync(dist).join(', ')})`);

if (process.argv.includes('--install')) {
  const vault = process.env.VAULT;
  if (!vault) { console.error('Set VAULT=/path/to/vault'); process.exit(1); }
  const target = path.join(vault, '.obsidian', 'plugins', id);
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(dist)) fs.copyFileSync(path.join(dist, f), path.join(target, f));
  console.log(`installed into ${target}`);
}
