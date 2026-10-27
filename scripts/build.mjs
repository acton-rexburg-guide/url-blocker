// Packs extension/ into a signed .crx plus the updates.xml Chrome polls, ready
// to host on GitHub Pages.
//
// Usage: node scripts/build.mjs <base-url> [out-dir]
// The key comes from $EXTENSION_PRIVATE_KEY, or the file extension-key.pem.
// $BUILD_NUMBER (the CI run number) becomes the 4th version part so every
// release is newer than the last and devices update.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { crx, extensionId, zip } from './crx.mjs';

const [baseUrl, outDir = 'dist'] = process.argv.slice(2);
if (!/^https?:\/\//.test(baseUrl ?? '')) {
  console.error('Usage: node scripts/build.mjs <base-url> [out-dir]');
  process.exit(1);
}
const base = baseUrl.replace(/\/$/, '');
const pem = process.env.EXTENSION_PRIVATE_KEY || (existsSync('extension-key.pem') && readFileSync('extension-key.pem', 'utf8'));
if (!pem) {
  console.error('No signing key. Set the EXTENSION_PRIVATE_KEY secret (see README) or create extension-key.pem with scripts/keygen.mjs.');
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name.startsWith('.')) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const src = 'extension';
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
const build = process.env.BUILD_NUMBER;
if (build) manifest.version = `${manifest.version.split('.').slice(0, 3).join('.')}.${Number(build) % 65536}`;
manifest.update_url = `${base}/updates.xml`;

const files = walk(src)
  .map((path) => relative(src, path).split('\\').join('/'))
  .filter((name) => name !== 'manifest.json')
  .sort()
  .map((name) => ({ name, data: readFileSync(join(src, name)) }));
files.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });

const id = extensionId(pem);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'url-filter.crx'), crx(zip(files), pem));
writeFileSync(
  join(outDir, 'updates.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${id}">
    <updatecheck codebase="${base}/url-filter.crx" version="${manifest.version}" />
  </app>
</gupdate>
`,
);
writeFileSync(
  join(outDir, 'index.html'),
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>URL Filter extension</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px}code{background:#8882;padding:2px 4px;border-radius:4px;word-break:break-all}</style>
</head><body>
<h1>URL Filter extension</h1>
<p>Version <code>${manifest.version}</code></p>
<p>Extension ID: <code>${id}</code></p>
<p>Custom URL for the Admin console: <code>${base}/updates.xml</code></p>
</body></html>
`,
);
console.log(`Built ${manifest.version} for ${id} into ${outDir}/`);
