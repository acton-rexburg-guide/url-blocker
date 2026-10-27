// Creates the private key that signs the extension. Run once; keep the key forever.
// Usage: node scripts/keygen.mjs [out.pem]
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { extensionId } from './crx.mjs';

const out = process.argv[2] ?? 'extension-key.pem';
if (existsSync(out)) {
  console.error(`${out} already exists. Losing or replacing the key changes the extension ID, so this won't overwrite it.`);
  process.exit(1);
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
writeFileSync(out, pem, { mode: 0o600 });
console.log(`Wrote ${out}`);
console.log(`Extension ID: ${extensionId(pem)}`);
