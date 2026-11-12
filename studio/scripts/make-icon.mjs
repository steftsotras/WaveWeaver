// Draws electron/assets/icon.png: static/favicon.svg's stepped wave at 1024 px.
// electron-builder makes the .ico from it. No image library, so no dependency
// for a file that changes about never.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 1024;
const UNIT = SIZE / 32;
const STROKE = 2.5;
const BG = [0x0a, 0x0a, 0x0a];
const FG = [0xff, 0x4f, 0x00];

// favicon.svg: M4 16 h3 v-6 h3 v12 h3 V6 h3 v20 h3 V10 h3 v12 h3 v-6 h3
const POINTS = [[4, 16], [7, 16], [7, 10], [10, 10], [10, 22], [13, 22], [13, 6], [16, 6], [16, 26], [19, 26], [19, 10], [22, 10], [22, 22], [25, 22], [25, 16], [28, 16]];

const px = Buffer.alloc(SIZE * SIZE * 3);
for (let i = 0; i < px.length; i += 3) BG.forEach((v, c) => (px[i + c] = v));

function fill(x0, y0, x1, y1) {
	for (let y = Math.round(y0 * UNIT); y < Math.round(y1 * UNIT); y++)
		for (let x = Math.round(x0 * UNIT); x < Math.round(x1 * UNIT); x++) FG.forEach((v, c) => (px[(y * SIZE + x) * 3 + c] = v));
}

const half = STROKE / 2;
for (let i = 1; i < POINTS.length; i++) {
	const [ax, ay] = POINTS[i - 1];
	const [bx, by] = POINTS[i];
	fill(Math.min(ax, bx) - half, Math.min(ay, by) - half, Math.max(ax, bx) + half, Math.max(ay, by) + half);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
	for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
	return n >>> 0;
});
function crc32(buf) {
	let c = 0xffffffff;
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const body = Buffer.concat([Buffer.from(type), data]);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), body.length + 4);
	return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bits per channel
ihdr[9] = 2; // RGB

const rows = Buffer.alloc((SIZE * 3 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) px.copy(rows, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3);

mkdirSync('electron/assets', { recursive: true });
writeFileSync(
	'electron/assets/icon.png',
	Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]),
);
