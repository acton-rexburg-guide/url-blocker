// Minimal ZIP writer and CRX3 signer, so packaging needs nothing but Node.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

export function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function field(num, bytes) {
  return Buffer.concat([varint((num << 3) | 2), varint(bytes.length), bytes]);
}

function publicKeyDer(pem) {
  return createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' });
}

// Chrome's extension ID: first 16 bytes of SHA-256(public key), hex digits mapped to a–p.
export function extensionId(pem) {
  const hex = createHash('sha256').update(publicKeyDer(pem)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

// CRX3: "Cr24", version 3, header length, CrxFileHeader protobuf, then the ZIP.
export function crx(archive, pem) {
  const spki = publicKeyDer(pem);
  const crxId = createHash('sha256').update(spki).digest().subarray(0, 16);
  const signedData = field(1, crxId);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedData.length);
  const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), len, signedData, archive]), createPrivateKey(pem));
  const header = Buffer.concat([field(2, Buffer.concat([field(1, spki), field(2, signature)])), field(10000, signedData)]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0);
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, archive]);
}
