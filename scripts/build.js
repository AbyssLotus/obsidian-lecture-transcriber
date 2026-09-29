#!/usr/bin/env node
/* There is no bundler: main.js is hand-written plain JavaScript with no
 * dependencies, so "building" is a verbatim copy. Keeping it a copy rather
 * than a transform means the released file is byte-identical to the source,
 * which anyone can check with a diff.
 *
 * Output goes to dist/ and to ./main.js, because tooling disagrees about
 * where a plugin's built file lives.
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const EXTRA = ['manifest.json', 'styles.css'];
const dist = path.join(ROOT, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const src = path.join(ROOT, 'src', 'main.js');
fs.copyFileSync(src, path.join(dist, 'main.js'));
fs.copyFileSync(src, path.join(ROOT, 'main.js'));
for (const f of EXTRA) fs.copyFileSync(path.join(ROOT, f), path.join(dist, f));

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
for (const f of fs.readdirSync(dist)) console.log(`  ${f.padEnd(16)} sha256:${sha(path.join(dist, f))}`);

if (process.argv.includes('--install')) {
  const vault = process.env.VAULT;
  if (!vault) { console.error('Set VAULT=/path/to/vault'); process.exit(1); }
  const id = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).id;
  const target = path.join(vault, '.obsidian', 'plugins', id);
  fs.mkdirSync(target, { recursive: true });
  for (const f of fs.readdirSync(dist)) fs.copyFileSync(path.join(dist, f), path.join(target, f));
  console.log(`installed into ${target}`);
}
