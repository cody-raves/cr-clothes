'use strict';

const crypto = require('crypto');

const PREFIX = 'cd_live_';
const FORMAT = /^cd_live_[a-f0-9]{32}$/;

// New pairing token: cd_live_ + 32 lowercase hex chars (16 random bytes).
function issue() {
  return PREFIX + crypto.randomBytes(16).toString('hex');
}

// Tokens are stored hashed; the plaintext is shown once at issue time.
function hash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function isValidFormat(token) {
  return typeof token === 'string' && FORMAT.test(token);
}

module.exports = { PREFIX, issue, hash, isValidFormat };
