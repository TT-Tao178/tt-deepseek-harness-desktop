// v6.4.2-6 技术选型核查：解析 WebM/EBML 头（修正 ID/size 不同 VINT 规则）
// 用法：node scripts/probe-webm.cjs <file.webm>
'use strict';
const fs = require('node:fs');

// EBML ID：长度由首字节前导零个数决定；值包含首字节全部位（含标记位）
function readId(buf, off) {
  const first = buf[off];
  if (first === undefined) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 4 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 4) return null;
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + (buf[off + i] ?? 0);
  return { len, value };
}
// size：标准 VINT，值不含标记位
function readSize(buf, off) {
  const first = buf[off];
  if (first === undefined) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 8) return null;
  let value = first & (mask - 1);
  for (let i = 1; i < len; i++) value = value * 256 + (buf[off + i] ?? 0);
  return { len, value };
}

function parseEBML(buf, start, end, want) {
  let off = start;
  while (off + 2 < end) {
    const id = readId(buf, off);
    if (!id) break;
    const size = readSize(buf, off + id.len);
    if (!size) break;
    const dataStart = off + id.len + size.len;
    if (dataStart + size.value > end) break;
    const idHex = id.value.toString(16).toUpperCase();
    if (want.has(idHex)) {
      let val;
      if (idHex === '86' || idHex === '4282') val = buf.slice(dataStart, dataStart + size.value).toString('latin1');
      else if (idHex === '63A2') { const priv = buf.slice(dataStart, dataStart + size.value); val = { len: priv.length, byte0: priv[0].toString(16).padStart(2, '0'), profile: (priv[0] >> 2) & 0x7 }; }
      else if (idHex === 'B0' || idHex === 'BA') val = buf.readUIntBE(dataStart, Math.min(4, size.value));
      else if (idHex === '88C0' || idHex === '88') val = buf[dataStart];
      else val = buf.slice(dataStart, dataStart + Math.min(size.value, 24)).toString('hex');
      want.get(idHex).push(val);
    }
    // 递归进容器：Segment / Tracks / TrackEntry / Video / Audio
    if (['18538067', '1654AE6B', 'AE', 'E0'].includes(idHex)) {
      parseEBML(buf, dataStart, dataStart + size.value, want);
    }
    off = dataStart + size.value;
  }
}

const file = process.argv[2];
if (!file) { console.error('usage: node probe-webm.cjs <file>'); process.exit(1); }
const buf = fs.readFileSync(file);
console.log('head hex:', buf.slice(0, 32).toString('hex'));
const want = new Map([
  ['4282', []], ['86', []], ['63A2', []], ['B0', []], ['BA', []], ['88C0', []], ['88', []],
]);
parseEBML(buf, 0, buf.length, want);
console.log('file:', file, '(' + (buf.length / 1024).toFixed(0) + ' KB)');
console.log('DocType:', want.get('4282')[0] ?? '?');
console.log('CodecID:', want.get('86')[0] ?? '?');
const priv = want.get('63A2')[0];
console.log('CodecPrivate:', priv ? 'len=' + priv.len + ' byte0=0x' + priv.byte0 + ' -> VP9 profile ' + priv.profile + (priv.profile === 1 || priv.profile === 3 ? '（带 alpha）' : '（无 alpha）') : '?');
console.log('PixelWidth:', want.get('B0')[0] ?? '?');
console.log('PixelHeight:', want.get('BA')[0] ?? '?');
console.log('AlphaMode(88C0):', want.get('88C0')[0] ?? '未声明');
console.log('AlphaMode(88):', want.get('88')[0] ?? '未声明');
