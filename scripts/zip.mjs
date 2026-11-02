// 無圧縮の zip を書く・読む（.mcpb とプラグインの zip。試作 0-3b と kSQL の build-mcpb.mjs を元にした）。
//   - 時刻は 1980-01-01 00:00 に固定する（同じ中身なら同じバイト列。sha256 で固定して配る。リリース手順 0-9）
//   - 読むほうは、自分で書いた形（無圧縮、名前の重複・絶対パス・.. ・\ が無い）だけを受け付ける
import { readFileSync } from "node:fs";

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ b) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS の日付の 1980-01-01（月 1、日 1） */
const DOS_DATE = (1 << 5) | 1;

/** @param {{ path: string, data: Buffer | Uint8Array }[]} entries */
export function createZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path.replace(/\\/g, "/"), "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 の名前
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * zip の中身（名前 → バイト列）。createZip の形だけを受け付ける
 * @param {string | Buffer} file
 * @returns {Map<string, Buffer>}
 */
export function readZip(file) {
  const zip = typeof file === "string" ? readFileSync(file) : file;
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(eocd >= 0, "zip の終わりの目印が無い");
  const count = zip.readUInt16LE(eocd + 10);
  let off = zip.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert(zip.readUInt32LE(off) === 0x02014b50, "zip の中央ディレクトリが壊れている");
    const method = zip.readUInt16LE(off + 10);
    const size = zip.readUInt32LE(off + 20);
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const localOff = zip.readUInt32LE(off + 42);
    const name = zip.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    assert(method === 0, `${name} が無圧縮でない`);
    assert(!name.startsWith("/") && !name.includes("\\") && !name.split("/").includes("..") && !name.endsWith("/"), `zip の中の名前がおかしい: ${name}`);
    assert(!entries.has(name), `zip の中の名前が重複している: ${name}`);
    const dataOff = localOff + 30 + zip.readUInt16LE(localOff + 26) + zip.readUInt16LE(localOff + 28);
    entries.set(name, zip.subarray(dataOff, dataOff + size));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
