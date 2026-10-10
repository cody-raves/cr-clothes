'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tokenLib = require('./token');
const { buildCard } = require('./card');
const { bake } = require('./bake');

const RATE_LIMIT_MAX = 10; // uploads
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // per 10 minutes, per token

const FILE_NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const FILE_ID_RE = /^[a-f0-9]{16}$/;

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function isSafeFileName(name) {
  return (
    typeof name === 'string' &&
    FILE_NAME_RE.test(name) &&
    !/^\.+$/.test(name) // reject "." / ".." style names
  );
}

// Reads the request body up to `cap` bytes; rejects larger bodies.
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > cap) {
        const err = new Error('payload too large');
        err.tooLarge = true;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// createApi({ config, store, deliver, log }) -> node:http server.
// `deliver(cardPayload)` is injected: live mode posts to Discord, dry-run
// writes the payload to data/outbox/. It resolves to 'attach'|'link'|'outbox'.
function createApi({ config, store, deliver, log = console.log }) {
  const rate = new Map(); // tokenHash -> [timestamps]

  function rateLimited(tokenHash) {
    const now = Date.now();
    const hits = (rate.get(tokenHash) || []).filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS
    );
    if (hits.length >= RATE_LIMIT_MAX) {
      rate.set(tokenHash, hits);
      return true;
    }
    hits.push(now);
    rate.set(tokenHash, hits);
    return false;
  }

  async function handleUpload(req, res) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m || !tokenLib.isValidFormat(m[1])) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    const tokenHash = tokenLib.hash(m[1]);
    const record = store.getServer(tokenHash);
    if (!record || record.revoked) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    if (rateLimited(tokenHash)) {
      return sendJson(res, 429, {
        ok: false,
        error: 'rate_limited',
        detail: `max ${RATE_LIMIT_MAX} uploads per ${RATE_LIMIT_WINDOW_MS / 60000} minutes`,
      });
    }

    const maxBytes = Math.floor(config.maxUploadMb * 1024 * 1024);
    // Base64 inflates ~4/3; allow that plus 1 MB of JSON envelope.
    const rawCap = Math.ceil(maxBytes * (4 / 3)) + 1024 * 1024;

    let raw;
    try {
      raw = await readBody(req, rawCap);
    } catch (err) {
      if (err.tooLarge) {
        return sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      }
      throw err;
    }

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_json' });
    }
    if (typeof body !== 'object' || body === null) {
      return sendJson(res, 400, { ok: false, error: 'invalid_body' });
    }

    const { name, mode, fileName, fileB64, previewB64, meta } = body;
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 100) {
      return sendJson(res, 400, { ok: false, error: 'bad_name' });
    }
    if (typeof mode !== 'string' || mode.length < 1 || mode.length > 40) {
      return sendJson(res, 400, { ok: false, error: 'bad_mode' });
    }
    if (!isSafeFileName(fileName)) {
      return sendJson(res, 400, { ok: false, error: 'bad_fileName' });
    }
    if (typeof fileB64 !== 'string' || fileB64.length === 0) {
      return sendJson(res, 400, { ok: false, error: 'bad_fileB64' });
    }
    if (meta !== undefined && (typeof meta !== 'object' || meta === null)) {
      return sendJson(res, 400, { ok: false, error: 'bad_meta' });
    }
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(fileB64)) {
      return sendJson(res, 400, { ok: false, error: 'bad_fileB64' });
    }

    const fileData = Buffer.from(fileB64, 'base64');
    if (fileData.length === 0) {
      return sendJson(res, 400, { ok: false, error: 'bad_fileB64' });
    }
    if (fileData.length > maxBytes) {
      return sendJson(res, 413, {
        ok: false,
        error: 'file_too_large',
        detail: `decoded file exceeds ${config.maxUploadMb} MB`,
      });
    }

    // Optional design-preview PNG (max 4 MB, must actually be a PNG).
    let previewData = null;
    if (previewB64 !== undefined && previewB64 !== null) {
      if (typeof previewB64 !== 'string' || !/^[A-Za-z0-9+/=\r\n]+$/.test(previewB64)) {
        return sendJson(res, 400, { ok: false, error: 'bad_previewB64' });
      }
      previewData = Buffer.from(previewB64, 'base64');
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (
        previewData.length === 0 ||
        previewData.length > 4 * 1024 * 1024 ||
        previewData.length < 8 ||
        !previewData.subarray(0, 8).equals(pngMagic)
      ) {
        return sendJson(res, 400, { ok: false, error: 'bad_previewB64' });
      }
    }

    const id = crypto.randomBytes(8).toString('hex'); // 16 lowercase hex
    const dir = path.join(store.filesDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, fileData);

    let previewPath = null;
    if (previewData) {
      previewPath = path.join(dir, 'preview.png');
      fs.writeFileSync(previewPath, previewData);
    }

    const card = buildCard({
      record,
      id,
      name: name.trim(),
      mode,
      fileName,
      size: fileData.length,
      filePath,
      previewPath,
      meta,
      config,
    });

    let delivered;
    try {
      delivered = await deliver(card);
    } catch (err) {
      log(`[api] delivery failed for upload ${id}: ${err.message}`);
      return sendJson(res, 502, { ok: false, error: 'delivery_failed', id });
    }

    store.recordUpload({
      id,
      tokenHash,
      guildId: record.guildId,
      name: name.trim(),
      mode,
      fileName,
      size: fileData.length,
      at: new Date().toISOString(),
      delivered,
    });

    log(
      `[api] upload ${id} "${name.trim()}" ${fileName} (${fileData.length} B) ` +
        `guild=${record.guildId} delivered=${delivered}`
    );
    return sendJson(res, 200, { ok: true, id, delivered });
  }

  // Bot-side bake: the game server sends only the raw design canvas and a
  // garment slot; the RSC7 patch, pack assembly, and 3D preview all run here.
  async function handleBake(req, res) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m || !tokenLib.isValidFormat(m[1])) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    const tokenHash = tokenLib.hash(m[1]);
    const record = store.getServer(tokenHash);
    if (!record || record.revoked) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    if (rateLimited(tokenHash)) {
      return sendJson(res, 429, { ok: false, error: 'rate_limited' });
    }

    // 1024x1024 RGBA is 4 MiB -> ~5.6 MiB base64; cap generously.
    let raw;
    try {
      raw = await readBody(req, 48 * 1024 * 1024);
    } catch (err) {
      if (err.tooLarge) return sendJson(res, 413, { ok: false, error: 'payload_too_large' });
      throw err;
    }

    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_json' });
    }

    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : null;
    const slotId = typeof body.slotId === 'string' ? body.slotId.slice(0, 120) : null;
    // Addon (a real new clothing item) is the product output; replace-mode
    // caret packs are a dev/test vehicle and must be asked for explicitly.
    const mode = body.mode === 'replace' ? 'replace' : 'addon';
    const textureIndex = Number.isInteger(body.textureIndex) ? body.textureIndex : 0;
    const width = Number.isInteger(body.width) ? body.width : 1024;
    const height = Number.isInteger(body.height) ? body.height : 1024;
    if (!name || !slotId) return sendJson(res, 400, { ok: false, error: 'bad_request' });
    if (width < 16 || width > 2048 || height < 16 || height > 2048 || textureIndex < 0 || textureIndex > 25) {
      return sendJson(res, 400, { ok: false, error: 'bad_dimensions' });
    }
    if (typeof body.rgbaB64 !== 'string' || !/^[A-Za-z0-9+/=\r\n]+$/.test(body.rgbaB64)) {
      return sendJson(res, 400, { ok: false, error: 'bad_rgbaB64' });
    }
    const rgba = Buffer.from(body.rgbaB64, 'base64');
    if (rgba.length !== width * height * 4) {
      return sendJson(res, 400, {
        ok: false,
        error: 'bad_rgbaB64',
        detail: `decoded ${rgba.length} bytes; expected ${width * height * 4} for ${width}x${height} RGBA`,
      });
    }

    let baked;
    try {
      baked = await bake({ config, request: { slotId, textureIndex, width, height, rgba, name, mode } });
    } catch (err) {
      if (err.code === 'bad_slot') return sendJson(res, 400, { ok: false, error: 'bad_slot' });
      log(`[api] bake failed: ${err.stack || err.message}`);
      return sendJson(res, 500, { ok: false, error: 'bake_failed' });
    }

    // Move outputs into the standard per-upload file store and post the card.
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(store.filesDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const fileName = path.basename(baked.pack.zipPath);
    const filePath = path.join(dir, fileName);
    fs.renameSync(baked.pack.zipPath, filePath);
    let previewPath = null;
    if (baked.previewPath) {
      previewPath = path.join(dir, 'preview.png');
      fs.renameSync(baked.previewPath, previewPath);
    }
    const size = fs.statSync(filePath).size;

    const card = buildCard({ record, id, name, mode, fileName, size, filePath, previewPath, meta: body.meta, config });

    let delivered;
    try {
      delivered = await deliver(card);
    } catch (err) {
      log(`[api] delivery failed for bake ${id}: ${err.message}`);
      return sendJson(res, 502, { ok: false, error: 'delivery_failed', id });
    }

    store.recordUpload({
      id, tokenHash, guildId: record.guildId, name, mode, fileName, size,
      at: new Date().toISOString(), delivered, baked: true,
    });
    log(`[api] bake ${id} "${name}" ${fileName} (${size} B) guild=${record.guildId} delivered=${delivered}`);
    return sendJson(res, 200, { ok: true, id, delivered, packName: baked.pack.packName, zipBytes: size });
  }

  function handleFileGet(req, res, urlPath) {
    const m = /^\/files\/([a-f0-9]{16})\/([^/]{1,80})$/.exec(urlPath);
    if (!m) return sendJson(res, 404, { ok: false, error: 'not_found' });
    const [, id, rawName] = m;
    let fileName;
    try {
      fileName = decodeURIComponent(rawName);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }
    if (!FILE_ID_RE.test(id) || !isSafeFileName(fileName)) {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }

    const filePath = path.resolve(store.filesDir, id, fileName);
    // Belt and suspenders: the resolved path must stay inside data/files/.
    if (!filePath.startsWith(path.resolve(store.filesDir) + path.sep)) {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not_found' });
    }
    if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: 'not_found' });

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad_request' });
    }

    if (req.method === 'POST' && urlPath === '/api/v1/upload') {
      handleUpload(req, res).catch((err) => {
        log(`[api] upload error: ${err.stack || err.message}`);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'internal_error' });
        } else {
          res.destroy();
        }
      });
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/v1/bake') {
      handleBake(req, res).catch((err) => {
        log(`[api] bake error: ${err.stack || err.message}`);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'internal_error' });
        } else {
          res.destroy();
        }
      });
      return;
    }
    if (req.method === 'GET' && urlPath.startsWith('/files/')) {
      return handleFileGet(req, res, urlPath);
    }
    if (req.method === 'GET' && urlPath === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        mode: config.dryRun ? 'dry-run' : 'live',
        guilds: store.activeServers().length,
      });
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
  });

  return server;
}

module.exports = { createApi };
