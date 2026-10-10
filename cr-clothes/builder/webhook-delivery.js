// builder/webhook-delivery.js
// Delivers finished packs to Discord with NO bot and NO external service.
//
// The pack never leaves the server. The baker writes it next to the other
// outputs, builder/http-download.lua serves it over the FXServer HTTP endpoint,
// and this module posts a Discord webhook carrying the *link*. Discord stores
// a message; the bytes stay on infrastructure the server owner already runs.
//
// Why a link instead of an attachment: Discord caps webhook uploads (8 MB on
// unboosted guilds) and clothing packs can exceed that, but mainly because
// attaching the file would mean the owner's content lives on someone else's
// box. A link keeps the pipeline owner-controlled end to end.
//
//   set clothdesigner_webhook_url "https://discord.com/api/webhooks/..."
//   set clothdesigner_public_url  "http://1.2.3.4:30120"
//
// The URL IS the credential. /out/<file> has no auth, so every delivered pack
// gets an unguessable id in its filename (see deliveryName) and the directory
// listing is disabled whenever webhook delivery is on. Anyone who has the link
// can download; nobody can enumerate or guess one.
//
// Injected getConvar/log keep this pure Node and testable outside FiveM. Never
// throws into the caller: a failed webhook must never fail an export.

const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const POST_TIMEOUT_MS = 15 * 1000;
const RETRY_DELAYS_MS = [2000, 5000];

// Discord only accepts webhooks on its own domains; posting the pack link to an
// arbitrary host because a convar said so would be an exfiltration primitive.
const ALLOWED_WEBHOOK_HOSTS = new Set([
    'discord.com',
    'discordapp.com',
    'ptb.discord.com',
    'canary.discord.com'
]);

function createWebhookDelivery(options) {
    const getConvar = options.getConvar;
    const log = options.log || (() => {});
    const resourceName = options.resourceName || 'cr-clothes';

    function settings() {
        const webhookUrl = String(getConvar('clothdesigner_webhook_url') || '').trim();
        const publicUrl = String(getConvar('clothdesigner_public_url') || '').trim().replace(/\/+$/, '');
        return { webhookUrl, publicUrl };
    }

    // Enabled only with a *valid Discord* webhook URL. A misconfigured convar
    // should disable delivery, not send the link somewhere unexpected.
    function enabled() {
        const { webhookUrl } = settings();
        if (!webhookUrl) return false;
        try {
            const parsed = new URL(webhookUrl);
            return parsed.protocol === 'https:' && ALLOWED_WEBHOOK_HOSTS.has(parsed.hostname);
        } catch {
            return false;
        }
    }

    // Capability filename: <packName>_<16 hex>.zip. safeName() in
    // http-download.lua accepts [A-Za-z0-9_-.], so this stays servable.
    function deliveryName(packName, extension) {
        const base = String(packName || 'design')
            .replace(/[^A-Za-z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 60) || 'design';
        return `${base}_${crypto.randomBytes(8).toString('hex')}${extension}`;
    }

    function downloadUrl(fileName) {
        const { publicUrl } = settings();
        if (!publicUrl) return null;
        return `${publicUrl}/${resourceName}/out/${fileName}`;
    }

    async function postOnce(webhookUrl, payload) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
        try {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            const text = await response.text().catch(() => '');
            return { status: response.status, ok: response.ok, detail: text.slice(0, 300) };
        } finally {
            clearTimeout(timer);
        }
    }

    // deliver({ zipPath, name, mode, packName, collection, note, slotId, sizeBytes })
    // -> { ok, status, detail, url }
    async function deliver(delivery) {
        const { webhookUrl, publicUrl } = settings();
        if (!enabled()) {
            return { ok: false, status: 0, detail: 'webhook delivery disabled (convar unset or not a Discord URL)' };
        }
        if (!publicUrl) {
            log('webhook delivery skipped: set clothdesigner_public_url to your server\'s reachable address.');
            return { ok: false, status: 0, detail: 'clothdesigner_public_url not set' };
        }

        const fileName = path.basename(delivery.zipPath || '');
        if (!fileName) return { ok: false, status: 0, detail: 'no pack file' };

        const url = downloadUrl(fileName);
        let sizeText = '';
        try {
            const bytes = delivery.sizeBytes ?? fs.statSync(delivery.zipPath).size;
            sizeText = `${(bytes / 1024 / 1024).toFixed(2)} MB`;
        } catch { /* size is cosmetic */ }

        const fields = [
            { name: 'Install', value: `Unzip into \`resources/\`, add \`ensure ${String(delivery.packName || 'pack')}\` to server.cfg, restart.`, inline: false }
        ];
        if (sizeText) fields.push({ name: 'Size', value: sizeText, inline: true });
        if (delivery.mode) fields.push({ name: 'Mode', value: String(delivery.mode), inline: true });
        // The card is what the person installing the pack reads; the export
        // message in game went to the player who made the design. So what an
        // installer has to know is said here too: a pack that adds a new item
        // takes one of the few collection slots, and a pack that replaces a
        // texture says that it does. (Discord allows 1024 characters a field.)
        if (delivery.collection) {
            fields.push({ name: 'Collection', value: `\`${String(delivery.collection)}\`. Each installed pack uses one clothing collection slot, and a server only has a few.`, inline: false });
        }
        if (delivery.note) fields.push({ name: 'Note', value: String(delivery.note).slice(0, 1024), inline: false });

        // The 3D preview is served from the same endpoint as the pack, so the
        // message can show the garment without anything being uploaded.
        const previewName = delivery.previewPath && fs.existsSync(delivery.previewPath) ? path.basename(delivery.previewPath) : null;

        // Packs in a temporary folder do not survive a restart; say so there,
        // and do not claim it where the pack is kept.
        const packDir = path.resolve(path.dirname(delivery.zipPath)).split(path.sep).join('/');
        const temporary = packDir.startsWith('/tmp/') || packDir.startsWith(os.tmpdir().split(path.sep).join('/'));
        const footerText = temporary
            ? 'Baked on your server; nothing was uploaded. Download it before the server restarts.'
            : 'Baked on your server; nothing was uploaded.';

        const payload = {
            username: 'cr-clothes',
            embeds: [{
                title: String(delivery.name || 'Clothing pack').slice(0, 250),
                description: `**[Download the pack](${url})**`,
                url,
                color: 0x4b66ff,
                fields,
                ...(previewName ? { image: { url: downloadUrl(previewName) } } : {}),
                footer: { text: footerText },
                timestamp: new Date().toISOString()
            }]
        };

        let last = { ok: false, status: 0, detail: 'not attempted' };
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            try {
                last = await postOnce(webhookUrl, payload);
                if (last.ok) {
                    log(`pack delivered to Discord webhook (${fileName}).`);
                    return { ...last, url };
                }
                // 4xx other than rate limiting is a config problem; retrying won't fix it.
                if (last.status >= 400 && last.status < 500 && last.status !== 429) break;
            } catch (error) {
                last = { ok: false, status: 0, detail: error?.message || String(error) };
            }
            const delay = RETRY_DELAYS_MS[attempt];
            if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        }

        log(`webhook delivery failed (${last.status}): ${last.detail}`);
        return { ...last, url };
    }

    return { enabled, deliver, deliveryName, downloadUrl, settings };
}

module.exports = { createWebhookDelivery };
