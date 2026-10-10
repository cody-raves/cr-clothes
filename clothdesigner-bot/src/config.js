'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Hand-rolled .env loader: KEY=value lines, optional single/double quotes,
// '#' comment lines. Real environment variables always win over .env.
function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

function num(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const config = {
  root: ROOT,
  discordToken: (process.env.DISCORD_TOKEN || '').trim(),
  clientId: (process.env.DISCORD_CLIENT_ID || '').trim(),
  port: Math.floor(num('PORT', 8085)),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:8085').replace(/\/+$/, ''),
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || './data'),
  templatesDir: path.resolve(ROOT, process.env.TEMPLATES_DIR || './data/templates'),
  maxUploadMb: num('MAX_UPLOAD_MB', 30),
  attachLimitMb: num('ATTACH_LIMIT_MB', 7.5),
};

// No Discord token => dry-run: HTTP API runs, cards go to data/outbox/.
config.dryRun = config.discordToken === '';

module.exports = config;
