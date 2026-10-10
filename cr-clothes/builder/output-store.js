// builder/output-store.js
// Owns the directory baked packs are written to, and exposes it to Lua.
//
// Hosted servers mount the resource tree read-only, so baked output goes to
// /tmp. The host also blocks io.popen, and Lua cannot reliably enumerate
// directories -- but the Node runtime reads /tmp fine. So JS owns listing and
// reading, and builder/http-download.lua only decodes base64 and serves bytes.
//
// This is production infrastructure: builder/http-download.lua depends on these
// two exports, and webhook delivery depends on that in turn. It previously
// lived inside builder/smoke-test.js, which meant removing a dev-only test file
// silently broke downloads -- hence this module.
//
// Wrapped in an IIFE: FiveM loads every server_scripts JS file into one shared
// module scope, so top-level `const fs`/`path` here would collide with the
// same names in builder/server.js.

(() => {
const fs = require('node:fs');
const path = require('node:path');

const resourceRoot = GetResourcePath(GetCurrentResourceName());
const OUTPUT_DIR = require(path.join(resourceRoot, 'builder', 'output-dir.js')).resolveOutputDir(resourceRoot);

// Served names are attacker-influenced (they arrive from the HTTP path), so
// allow only a flat, safe character set and never anything path-like.
function safeOutputName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9_.-]+$/.test(name) && !name.includes('..');
}

global.exports('bakerListOutputs', () => {
    try {
        // Files only: sub-folders cannot be served and should not be listed.
        const names = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
            .filter(entry => entry.isFile() && safeOutputName(entry.name))
            .map(entry => entry.name);
        return JSON.stringify(names.sort());
    } catch {
        return '[]';
    }
});

global.exports('bakerReadOutputB64', (name) => {
    if (!safeOutputName(name)) return false;
    try {
        return fs.readFileSync(path.join(OUTPUT_DIR, name)).toString('base64');
    } catch {
        return false;
    }
});
})();
