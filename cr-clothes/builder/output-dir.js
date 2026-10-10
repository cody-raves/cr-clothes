// builder/output-dir.js
// Decides where baked packs are written, once, for everything that needs it.
//
// No single location works everywhere:
//
//   hosted Linux   the resource folder is read-only; /tmp is writable
//   Windows        FiveM's Node sandbox refuses paths outside what it has
//                  approved ("no device found"), so /tmp -- which resolves to
//                  <drive>:\tmp -- is rejected even though Windows allows it;
//                  the resource's own folder is permitted
//   Linux VPS      either works
//
// So this probes a short list in a platform-appropriate order and uses the
// first folder a file can actually be written to. The exporter, the download
// endpoint and the console commands all ask here, because a pack written to
// one folder and served from another is a download that 404s.
//
// Set the CLOTHDESIGNER_OUT environment variable to force a location.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cache = new Map();

function isWritable(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.write-test-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe, { force: true });
        return true;
    } catch {
        return false;
    }
}

function candidates(resourceRoot) {
    const inResource = path.join(path.resolve(resourceRoot), 'output');
    const systemTemp = path.join(os.tmpdir(), 'clothdesigner');
    const list = [];
    if (process.env.CLOTHDESIGNER_OUT) list.push(path.resolve(process.env.CLOTHDESIGNER_OUT));
    if (process.platform === 'win32') {
        // Ask for the resource folder first: probing a path the sandbox rejects
        // logs a permission warning, and on Windows this one is always allowed.
        list.push(inResource, systemTemp);
    } else {
        list.push('/tmp/clothdesigner', systemTemp, inResource);
    }
    return list;
}

// resolveOutputDir(resourceRoot) -> absolute path of a writable folder.
// The answer is cached: it must not change between writing a pack and
// serving it.
function resolveOutputDir(resourceRoot) {
    const key = path.resolve(resourceRoot);
    if (cache.has(key)) return cache.get(key);
    const options = candidates(key);
    const chosen = options.find(isWritable) || options[0];
    cache.set(key, chosen);
    return chosen;
}

module.exports = { resolveOutputDir, candidates };
