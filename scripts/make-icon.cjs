// 生成 resources/icon.ico（256x256 32bpp 品牌蓝渐变占位图标）
const fs = require('node:fs');
const path = require('node:path');
const w = 256, h = 256;
const px = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const t = (x + y) / (w + h);
    px[i] = Math.round(0xfe - t * 0x40);      // B
    px[i + 1] = Math.round(0x7c - t * 0x20);  // G
    px[i + 2] = Math.round(0x4d + t * 0x30);  // R
    px[i + 3] = 0xff;                          // A
  }
}
const bmp = Buffer.alloc(40 + px.length);
bmp.writeUInt32LE(40, 0);
bmp.writeInt32LE(w, 4);
bmp.writeInt32LE(h * 2, 8);
bmp.writeUInt16LE(1, 12);
bmp.writeUInt16LE(32, 14);
px.copy(bmp, 40);
const ico = Buffer.alloc(6 + 16 + bmp.length);
ico.writeUInt16LE(0, 0);           // reserved
ico.writeUInt16LE(1, 2);           // type: icon
ico.writeUInt16LE(1, 4);           // count
ico.writeUInt8(0, 6);              // width 256
ico.writeUInt8(0, 7);              // height 256
ico.writeUInt8(0, 8);              // colors
ico.writeUInt8(0, 9);              // reserved
ico.writeUInt16LE(1, 10);          // planes
ico.writeUInt16LE(32, 12);         // bitcount
ico.writeUInt32LE(bmp.length, 14); // size
ico.writeUInt32LE(22, 18);         // offset
bmp.copy(ico, 22);
const out = path.join(process.cwd(), 'resources', 'icon.ico');
fs.writeFileSync(out, ico);
console.log('icon.ico written:', ico.length, 'bytes ->', out);
