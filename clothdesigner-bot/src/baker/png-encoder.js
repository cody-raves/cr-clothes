// builder/png-encoder.js
// Minimal pure-JS PNG encoder for RGBA8 buffers. Used to ship a preview image
// of the baked design alongside the pack upload; no native deps, ~zero cost on
// top of the bake (zlib is the same one the RSC7 writer already uses).

const zlib = require('node:zlib');
const path = require('node:path');
const { crc32 } = require(path.join(__dirname, 'zip-writer.js'));

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([length, body, crc]);
}

// Box-downsample RGBA by 2x. Used to keep preview PNGs light for Discord.
function halveRgba(rgba, width, height) {
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let oy = 0; oy < 2; oy++) {
                for (let ox = 0; ox < 2; ox++) {
                    const sx = Math.min(width - 1, x * 2 + ox);
                    const sy = Math.min(height - 1, y * 2 + oy);
                    const i = (sy * width + sx) * 4;
                    r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3];
                    n++;
                }
            }
            const o = (y * w + x) * 4;
            out[o] = Math.round(r / n);
            out[o + 1] = Math.round(g / n);
            out[o + 2] = Math.round(b / n);
            out[o + 3] = Math.round(a / n);
        }
    }
    return { data: out, width: w, height: h };
}

// encodePng(rgba, width, height, {maxDimension}) -> Buffer
// 8-bit RGBA, no interlace, filter 0 on every scanline. Downsamples by halves
// until both sides are <= maxDimension (default 512) to keep embeds light.
function encodePng(rgba, width, height, options = {}) {
    const maxDimension = Math.max(16, Math.floor(options.maxDimension || 512));
    let data = Buffer.from(rgba);
    let w = width;
    let h = height;
    if (data.length !== w * h * 4) {
        throw new Error(`encodePng: buffer is ${data.length} bytes; expected ${w * h * 4} for ${w}x${h} RGBA.`);
    }
    while (w > maxDimension || h > maxDimension) {
        const next = halveRgba(data, w, h);
        data = next.data;
        w = next.width;
        h = next.height;
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr.writeUInt8(8, 8);   // bit depth
    ihdr.writeUInt8(6, 9);   // color type: RGBA
    ihdr.writeUInt8(0, 10);  // compression
    ihdr.writeUInt8(0, 11);  // filter method
    ihdr.writeUInt8(0, 12);  // no interlace

    // Each scanline prefixed with filter byte 0 (None).
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) {
        const rowStart = y * (w * 4 + 1);
        raw[rowStart] = 0;
        data.copy(raw, rowStart + 1, y * w * 4, (y + 1) * w * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 8 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

module.exports = { encodePng };
