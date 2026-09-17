/**
 * 一键把 src 里的 png 转成 ico（可选工具）
 * 说明：仓库已自带 build/icon.ico，无需运行本脚本。
 * 若需替换图标，请把 256x256 的 png 放到 build/icon.png 后执行：
 *   node scripts/make-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const png = path.join(root, 'build', 'icon.png');
const ico = path.join(root, 'build', 'icon.ico');

if (!fs.existsSync(png)) {
  console.log('[make-icon] 未找到 build/icon.png，跳过（沿用现有 icon.ico）');
  process.exit(0);
}

// 最小 ICO 封装：把 PNG 直接嵌入 ICO（Windows Vista+ 支持 PNG-in-ICO）
const data = fs.readFileSync(png);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(1, 4); // count

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // width 256
entry.writeUInt8(0, 1); // height 256
entry.writeUInt8(0, 2); // colors
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(data.length, 8);
entry.writeUInt32LE(22, 12); // offset

fs.writeFileSync(ico, Buffer.concat([header, entry, data]));
console.log(`[make-icon] 已生成 ${ico}（${Math.round(data.length / 1024)} KB）`);
