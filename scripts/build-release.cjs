'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid release version');
const name = `yuliu-extension-${manifest.version}`;
const output = path.join(root, 'dist', name);
if (fs.existsSync(output)) throw new Error('Release already exists; inspect it before rebuilding');
const files = ['manifest.json', 'README.md', 'PRIVACY.md'];
for (const item of fs.readdirSync(root, {withFileTypes: true})) {
  if (item.isFile() && /\.(js|css|html)$/.test(item.name)) files.push(item.name);
}
// The service worker imports evaluation modules at startup. Keep their public,
// synthetic assets too; omitting them breaks existing diagnostic buttons.
function walk(relative) {
  for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
    const file = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symlink not allowed: ${file}`);
    if (entry.isDirectory() && entry.name !== 'results') walk(file);
    else if (entry.isFile() && /\.(js|json|html|css)$/.test(entry.name)) files.push(file);
  }
}
walk('evaluation');
const secret = /sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/;
for (const file of files) {
  if (secret.test(fs.readFileSync(path.join(root, file), 'utf8'))) throw new Error(`Potential credential: ${file}`);
}
const required = [manifest.background.service_worker, manifest.action.default_popup,
  manifest.options_ui.page, ...manifest.content_scripts.flatMap(s => s.js)];
for (const file of required) if (!files.includes(file)) throw new Error(`Missing manifest asset: ${file}`);
const checksums = [];
for (const file of [...new Set(files)].sort()) {
  const bytes = fs.readFileSync(path.join(root, file));
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, bytes);
  checksums.push(`${crypto.createHash('sha256').update(bytes).digest('hex')}  ${file}`);
}
fs.writeFileSync(path.join(root, 'dist', `${name}-files.sha256`), checksums.join('\n') + '\n');
console.log(JSON.stringify({version: manifest.version, files: checksums.length, output}));
