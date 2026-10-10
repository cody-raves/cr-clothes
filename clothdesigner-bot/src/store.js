'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_UPLOAD_RECORDS = 200;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomic write: write to a temp file in the same directory, then rename over
// the target (rename replaces existing files on both Windows and POSIX).
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filesDir = path.join(dataDir, 'files');
    this.outboxDir = path.join(dataDir, 'outbox');
    fs.mkdirSync(this.filesDir, { recursive: true });
    fs.mkdirSync(this.outboxDir, { recursive: true });

    this.serversFile = path.join(dataDir, 'servers.json');
    this.uploadsFile = path.join(dataDir, 'uploads.json');

    // servers: { [tokenHash]: { tokenHash, guildId, channelId, guildName,
    //                           channelName, createdAt, revoked } }
    this.servers = readJson(this.serversFile, {});
    // uploads: newest-first list of { id, tokenHash, guildId, name, mode,
    //                                 fileName, size, at, delivered }
    this.uploads = readJson(this.uploadsFile, []);
  }

  saveServers() {
    writeJsonAtomic(this.serversFile, this.servers);
  }

  saveUploads() {
    writeJsonAtomic(this.uploadsFile, this.uploads);
  }

  getServer(tokenHash) {
    return this.servers[tokenHash] || null;
  }

  activeServers() {
    return Object.values(this.servers).filter((r) => !r.revoked);
  }

  findActiveByGuild(guildId) {
    return this.activeServers().find((r) => r.guildId === guildId) || null;
  }

  // Issue (or rotate) the pairing for a guild: any previous active token for
  // the same guild is revoked, then the new record is stored.
  issuePairing({ tokenHash, guildId, channelId, guildName, channelName }) {
    for (const rec of Object.values(this.servers)) {
      if (rec.guildId === guildId && !rec.revoked) rec.revoked = true;
    }
    const record = {
      tokenHash,
      guildId,
      channelId,
      guildName: guildName || '',
      channelName: channelName || '',
      createdAt: new Date().toISOString(),
      revoked: false,
    };
    this.servers[tokenHash] = record;
    this.saveServers();
    return record;
  }

  revokeByTokenHash(tokenHash) {
    const rec = this.servers[tokenHash];
    if (!rec || rec.revoked) return false;
    rec.revoked = true;
    this.saveServers();
    return true;
  }

  revokeByGuild(guildId) {
    let n = 0;
    for (const rec of Object.values(this.servers)) {
      if (rec.guildId === guildId && !rec.revoked) {
        rec.revoked = true;
        n += 1;
      }
    }
    if (n > 0) this.saveServers();
    return n;
  }

  recordUpload(upload) {
    this.uploads.unshift(upload);
    if (this.uploads.length > MAX_UPLOAD_RECORDS) {
      this.uploads.length = MAX_UPLOAD_RECORDS;
    }
    this.saveUploads();
  }

  uploadCountForGuild(guildId) {
    return this.uploads.filter((u) => u.guildId === guildId).length;
  }

  getUpload(id) {
    return this.uploads.find((u) => u.id === id) || null;
  }

  markUploadDeleted(id) {
    const rec = this.getUpload(id);
    if (!rec) return false;
    rec.deleted = true;
    this.saveUploads();
    return true;
  }
}

module.exports = Store;
