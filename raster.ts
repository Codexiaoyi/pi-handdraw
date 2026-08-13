/**
 * raster.ts — 极简位图光栅化 + PNG 编码
 *
 * 用于手写动画：把笔画点序列逐段画到 RGBA 位图（增量绘制），
 * 用 node:zlib 手写 PNG 编码（无外部依赖，快）。
 * 每帧只画新增像素，编码 600x120 的 PNG 约 5-15ms。
 */
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// PNG 编码（RGBA 8bit，colortype 6）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA 位图 → PNG Buffer */
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前置 filter 字节（filter 0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 6 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 位图画布
// ---------------------------------------------------------------------------

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** #rrggbb / #rgb → {r,g,b} */
export function parseColor(hex: string): RgbColor {
  let s = hex.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.length === 3) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  }
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/**
 * 增量位图画布。drawLine 画圆头线（逐点实心圆），
 * 支持只在内容变化时输出 PNG。
 */
export class RasterCanvas {
  readonly width: number;
  readonly height: number;
  private data: Buffer;

  constructor(width: number, height: number, background?: string) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    if (background && background !== "transparent") {
      const c = parseColor(background);
      for (let i = 0; i < width * height; i++) {
        this.data[i * 4] = c.r;
        this.data[i * 4 + 1] = c.g;
        this.data[i * 4 + 2] = c.b;
        this.data[i * 4 + 3] = 255;
      }
    }
  }

  getBuffer(): Buffer {
    return this.data;
  }

  /** 深拷贝（每帧增量用） */
  clone(): RasterCanvas {
    const c = new RasterCanvas(this.width, this.height);
    this.data.copy(c.data);
    return c;
  }

  private setPixel(x: number, y: number, color: RgbColor) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = color.r;
    this.data[i + 1] = color.g;
    this.data[i + 2] = color.b;
    this.data[i + 3] = 255;
  }

  /** 实心圆 */
  private fillCircle(cx: number, cy: number, r: number, color: RgbColor) {
    const r2 = Math.max(1, Math.round(r));
    const x0 = Math.max(0, Math.round(cx - r2));
    const x1 = Math.min(this.width - 1, Math.round(cx + r2));
    const y0 = Math.max(0, Math.round(cy - r2));
    const y1 = Math.min(this.height - 1, Math.round(cy + r2));
    const rr = r2 * r2;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        if (dx * dx + dy * dy <= rr) {
          const i = (y * this.width + x) * 4;
          this.data[i] = color.r;
          this.data[i + 1] = color.g;
          this.data[i + 2] = color.b;
          this.data[i + 3] = 255;
        }
      }
    }
  }

  /**
   * 画圆头线：沿点序列以半径 radius 逐点画圆。
   * 只画 points[0..progress*len) 部分（生长动画）。
   */
  drawPolyline(points: Array<[number, number]>, radius: number, color: RgbColor, progress = 1) {
    if (points.length === 0) return;
    const len = points.length;
    const end = Math.max(1, Math.ceil(len * Math.min(1, Math.max(0, progress))));
    for (let i = 0; i < end; i++) {
      this.fillCircle(points[i][0], points[i][1], radius, color);
    }
  }
}
