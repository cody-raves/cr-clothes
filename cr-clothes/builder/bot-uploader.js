// builder/bot-uploader.js
// Sends finished pack zips to the hosted ClothDesigner Discord bot.
//
// Pairing model: the admin runs /setup in their Discord, gets a cd_live_ token,
// and sets two server convars. Uploads carry the token as Bearer auth; the bot
// maps it to the right guild/channel and posts the pack card there.
//
//   set clothdesigner_bot_url   "http://bot-host:8085"
//   set clothdesigner_bot_token "cd_live_..."
//
// Injected getConvar/log keep this module pure Node and unit-testable outside
// FiveM. Never logs the token. Never throws into the caller.

const fs = require('node:fs');
const path = require('node:path');

const UPLOAD_TIMEOUT_MS = 30 * 1000;
const RETRY_DELAYS_MS = [2000, 5000];

function createUploader(options) {
    const getConvar = options.getConvar;
    const log = options.log || (() => {});

    function settings() {
        const url = String(getConvar('clothdesigner_bot_url') || '').trim().replace(/\/+$/, '');
        const token = String(getConvar('clothdesigner_bot_token') || '').trim();
        return { url, token };
    }

    function enabled() {
        const { url, token } = settings();
        return url !== '' && token !== '';
    }

    async function postOnce(url, token, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
        try {
            const response = await fetch(`${url}/api/v1/upload`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body,
                signal: controller.signal
            });
            const text = await response.text().catch(() => '');
            return { status: response.status, ok: response.ok, detail: text.slice(0, 300) };
        } finally {
            clearTimeout(timer);
        }
    }

    async function uploadPack(pack) {
        const { url, token } = settings();
        if (!url || !token) {
            return { ok: false, status: 0, detail: 'bot upload disabled (convars not set)' };
        }

        let fileBuffer;
        try {
            fileBuffer = fs.readFileSync(pack.zipPath);
        } catch (error) {
            log(`bot upload failed: cannot read pack file (${error?.message || error})`);
            return { ok: false, status: 0, detail: `cannot read pack file: ${error?.message || error}` };
        }

        // Optional design-preview PNG; failure to read it never blocks the upload.
        let previewB64 = null;
        if (pack.previewPath) {
            try {
                previewB64 = fs.readFileSync(pack.previewPath).toString('base64');
            } catch (error) {
                log(`bot upload: preview skipped (${error?.message || error})`);
            }
        }

        const body = JSON.stringify({
            name: String(pack.name || 'Unnamed design').slice(0, 120),
            mode: String(pack.mode || 'replace'),
            fileName: path.basename(pack.zipPath),
            fileB64: fileBuffer.toString('base64'),
            previewB64,
            meta: pack.meta || {}
        });

        let lastResult = { ok: false, status: 0, detail: 'not attempted' };
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
            }
            try {
                lastResult = await postOnce(url, token, body);
            } catch (error) {
                lastResult = { ok: false, status: 0, detail: `network: ${error?.message || error}` };
                continue; // network errors retry
            }
            // 4xx are configuration errors (bad token, too large): retrying cannot help.
            if (lastResult.ok || (lastResult.status >= 400 && lastResult.status < 500)) break;
        }

        const kb = Math.round(fileBuffer.length / 1024);
        if (lastResult.ok) {
            log(`bot upload ok: ${pack.name || path.basename(pack.zipPath)} (${kb} KB)`);
        } else {
            log(`bot upload failed: ${lastResult.status || 'network'} ${lastResult.detail}`);
        }
        return lastResult;
    }

    return { enabled, uploadPack };
}

module.exports = { createUploader };
