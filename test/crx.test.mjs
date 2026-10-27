import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { crx, extensionId, zip } from '../scripts/crx.mjs';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

test('extensionId is 32 letters a–p', () => {
  assert.match(extensionId(pem), /^[a-p]{32}$/);
});

test('zip stores files that inflate back to the original', () => {
  const data = Buffer.from('hello hello hello');
  const archive = zip([{ name: 'a.txt', data }]);
  const nameLen = archive.readUInt16LE(26);
  const size = archive.readUInt32LE(18);
  assert.deepEqual(inflateRawSync(archive.subarray(30 + nameLen, 30 + nameLen + size)), data);
  assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50);
});

test('crx has a CRX3 header with a valid signature over the archive', () => {
  const archive = zip([{ name: 'manifest.json', data: Buffer.from('{}') }]);
  const file = crx(archive, pem);
  assert.equal(file.subarray(0, 4).toString(), 'Cr24');
  assert.equal(file.readUInt32LE(4), 3);
  const headerLen = file.readUInt32LE(8);
  const header = file.subarray(12, 12 + headerLen);
  assert.deepEqual(file.subarray(12 + headerLen), archive);

  // field 2 { field 1: spki (294 bytes), field 2: signature (256 bytes) }, field 10000: signed data
  const spki = header.subarray(6, 300);
  const signature = header.subarray(303, 559);
  const signedData = header.subarray(headerLen - 18);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedData.length);
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\0'), len, signedData, archive]);
  assert.ok(verify('sha256', message, createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature));
});
