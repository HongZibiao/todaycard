#!/usr/bin/env node
'use strict';

/**
 * 生成应用图标（纯 Node，无第三方依赖）。
 * 输出：
 *   build/icon.ico   —— Windows 安装包 + 窗口图标，内含 16/32/48/64/128/256
 *   build/icon.png   —— 512px，macOS/Linux 打包用
 *   assets/tray.png  —— 32px，托盘用
 *
 * 之所以自己画：图标要进仓库、要能重新生成，不能是一个来路不明的二进制文件。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array，长度 w*h*4 */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 图形

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 圆角矩形有向距离场（<0 在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 点到线段距离 */
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/**
 * 画一张 size×size 的图标。
 * 视觉：靛蓝渐变圆角方块 + 白色对勾，元素少、16px 下仍能认出来。
 */
function drawIcon(size) {
  const SS = 4; // 超采样倍数，用于抗锯齿
  const S = size * SS;
  const out = new Uint8Array(size * size * 4);

  const margin = S * 0.045;
  const half = S / 2 - margin;
  const radius = S * 0.235;
  const stroke = S * 0.115;

  // 对勾三个拐点（比例坐标）
  const pts = [
    [0.305, 0.515],
    [0.445, 0.655],
    [0.705, 0.365],
  ].map(([x, y]) => [x * S, y * S]);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;

          const dCard = sdRoundRect(px, py, S / 2, S / 2, half, half, radius);
          const inCard = dCard <= 0;

          if (!inCard) continue;

          // 渐变：上浅下深
          const t = py / S;
          let r = 108 + (67 - 108) * t;
          let g = 106 + (56 - 106) * t;
          let b = 244 + (202 - 244) * t;

          // 对勾：两条线段取并集
          const dCheck = Math.min(
            sdSegment(px, py, pts[0][0], pts[0][1], pts[1][0], pts[1][1]),
            sdSegment(px, py, pts[1][0], pts[1][1], pts[2][0], pts[2][1])
          );
          const checkAlpha = clamp01((stroke / 2 - dCheck) / (SS * 0.9) + 0.5);

          r = r + (255 - r) * checkAlpha;
          g = g + (255 - g) * checkAlpha;
          b = b + (255 - b) * checkAlpha;

          rSum += r;
          gSum += g;
          bSum += b;
          aSum += 255;
        }
      }

      const i = (y * size + x) * 4;
      const samples = SS * SS;
      const cov = aSum / (255 * samples);
      if (cov > 0) {
        out[i] = Math.round(rSum / (cov * samples));
        out[i + 1] = Math.round(gSum / (cov * samples));
        out[i + 2] = Math.round(bSum / (cov * samples));
        out[i + 3] = Math.round(cov * 255);
      }
    }
  }

  return encodePNG(size, size, out);
}

// ---------------------------------------------------------------- ICO 封装

/** ICO 里可以直接塞 PNG（Vista 以后支持），省掉 BMP 的位运算 */
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;
    e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

// ---------------------------------------------------------------- main

function main() {
  const buildDir = path.join(ROOT, 'build');
  const assetsDir = path.join(ROOT, 'assets');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = sizes.map((size) => ({ size, data: drawIcon(size) }));

  fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(pngs));
  fs.writeFileSync(path.join(buildDir, 'icon.png'), drawIcon(512));
  fs.writeFileSync(path.join(assetsDir, 'tray.png'), drawIcon(32));

  console.log('图标已生成：build/icon.ico, build/icon.png, assets/tray.png');
}

main();
