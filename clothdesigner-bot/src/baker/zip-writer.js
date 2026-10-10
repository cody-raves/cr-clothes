'use strict';

// ---------------------------------------------------------------------------
// zip-writer.js -- minimal pure-JS ZIP writer (no dependencies)
// ---------------------------------------------------------------------------
// STORE method only (no compression): the payloads we pack (RSC7 YTDs) are
// already deflate-compressed, so re-deflating buys nothing and correctness
// beats size. Produces standard ZIPs that Windows Explorer, PowerShell
// Expand-Archive, and unzip(1) all open.
//
// Loaded via require() (NOT a FiveM server_script), so no IIFE wrapper needed.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buffer.length; i += 1) {
        c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// Fixed, valid DOS timestamp: 2026-01-01 00:00:00. ZIP requires *a* timestamp;
// a constant keeps output deterministic and avoids DOS-epoch edge cases.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

const MAX_UINT32 = 0xFFFFFFFF;

function normalizeEntryName(rawName) {
    const name = String(rawName == null ? '' : rawName).replace(/\\/g, '/');
    if (!name) throw new Error('Zip entry has an empty name.');
    if (name.startsWith('/')) throw new Error(`Zip entry name must be relative: '${name}'`);
    if (name.split('/').some(part => part === '' || part === '.' || part === '..')) {
        throw new Error(`Zip entry name contains an empty, '.' or '..' segment: '${name}'`);
    }
    return name;
}

/**
 * Build a ZIP archive (STORE / no compression) from a list of entries.
 * @param {Array<{name: string, data: Buffer}>} entries paths use '/' separators
 * @returns {Buffer} the complete zip file bytes
 */
function createZip(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('createZip expects a non-empty array of {name, data} entries.');
    }
    if (entries.length > 0xFFFF) {
        throw new Error(`createZip supports at most 65535 entries, got ${entries.length}.`);
    }

    const localParts = [];
    const centralParts = [];
    const seen = new Set();
    let offset = 0;

    for (const entry of entries) {
        const name = normalizeEntryName(entry && entry.name);
        if (seen.has(name)) throw new Error(`Duplicate zip entry name: '${name}'`);
        seen.add(name);

        const data = entry.data;
        if (!Buffer.isBuffer(data)) {
            throw new Error(`Zip entry '${name}' data must be a Buffer.`);
        }
        if (data.length > MAX_UINT32) {
            throw new Error(`Zip entry '${name}' is too large for a non-zip64 archive.`);
        }

        const nameBytes = Buffer.from(name, 'utf8');
        if (nameBytes.length > 0xFFFF) {
            throw new Error(`Zip entry name is too long: '${name}'`);
        }
        const crc = crc32(data);

        // Local file header
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034B50, 0);        // signature
        local.writeUInt16LE(20, 4);                // version needed to extract (2.0)
        local.writeUInt16LE(0x0800, 6);            // general purpose flags: bit 11 = UTF-8 names
        local.writeUInt16LE(0, 8);                 // method 0 = STORE
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);      // compressed size (== uncompressed for STORE)
        local.writeUInt32LE(data.length, 22);      // uncompressed size
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);                // extra field length

        // Central directory header
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014B50, 0);      // signature
        central.writeUInt16LE(20, 4);              // version made by (2.0, MS-DOS attrs)
        central.writeUInt16LE(20, 6);              // version needed to extract
        central.writeUInt16LE(0x0800, 8);          // flags (UTF-8)
        central.writeUInt16LE(0, 10);              // method STORE
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(0, 30);              // extra field length
        central.writeUInt16LE(0, 32);              // file comment length
        central.writeUInt16LE(0, 34);              // disk number start
        central.writeUInt16LE(0, 36);              // internal file attributes
        central.writeUInt32LE(0, 38);              // external file attributes
        central.writeUInt32LE(offset, 42);         // local header offset

        localParts.push(local, nameBytes, data);
        centralParts.push(central, nameBytes);
        offset += 30 + nameBytes.length + data.length;

        if (offset > MAX_UINT32) {
            throw new Error('Zip archive exceeds the 4 GiB non-zip64 limit.');
        }
    }

    const centralDir = Buffer.concat(centralParts);
    if (offset + centralDir.length + 22 > MAX_UINT32) {
        throw new Error('Zip archive exceeds the 4 GiB non-zip64 limit.');
    }

    // End of central directory record
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);             // signature
    eocd.writeUInt16LE(0, 4);                      // this disk
    eocd.writeUInt16LE(0, 6);                      // disk with central dir
    eocd.writeUInt16LE(entries.length, 8);         // entries on this disk
    eocd.writeUInt16LE(entries.length, 10);        // total entries
    eocd.writeUInt32LE(centralDir.length, 12);     // central dir size
    eocd.writeUInt32LE(offset, 16);                // central dir offset
    eocd.writeUInt16LE(0, 20);                     // comment length

    return Buffer.concat([...localParts, centralDir, eocd]);
}

module.exports = {
    createZip,
    crc32
};
