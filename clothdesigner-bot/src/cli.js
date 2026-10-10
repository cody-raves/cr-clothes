'use strict';

// Operator CLI — works entirely without Discord. For local testing and
// emergency pairing management.
//
//   npm run cli -- issue-token --guild <id> --channel <id> [--name <label>]
//   npm run cli -- list
//   npm run cli -- revoke --token <plaintext-token>

const config = require('./config');
const Store = require('./store');
const tokenLib = require('./token');

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

function usage() {
  console.log(
    [
      'Usage:',
      '  cli.js issue-token --guild <guildId> --channel <channelId> [--name <label>]',
      '  cli.js list',
      '  cli.js revoke --token <plaintext-token>',
    ].join('\n')
  );
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const store = new Store(config.dataDir);

if (command === 'issue-token') {
  if (!flags.guild || !flags.channel) usage();
  const token = tokenLib.issue();
  store.issuePairing({
    tokenHash: tokenLib.hash(token),
    guildId: String(flags.guild),
    channelId: String(flags.channel),
    guildName: typeof flags.name === 'string' ? flags.name : '(cli)',
    channelName: '(cli)',
  });
  console.log('New pairing token (shown once, stored hashed):');
  console.log(token);
  console.log('');
  console.log('server.cfg lines:');
  console.log(`  set clothdesigner_bot_url "${config.publicUrl}"`);
  console.log(`  set clothdesigner_bot_token "${token}"`);
} else if (command === 'list') {
  const records = Object.values(store.servers);
  if (records.length === 0) {
    console.log('No pairings.');
  } else {
    for (const r of records) {
      console.log(
        [
          r.revoked ? 'REVOKED' : 'active ',
          `hash=${r.tokenHash.slice(0, 12)}…`,
          `guild=${r.guildId}`,
          `channel=${r.channelId}`,
          `created=${r.createdAt}`,
          r.guildName ? `name=${JSON.stringify(r.guildName)}` : '',
        ]
          .filter(Boolean)
          .join('  ')
      );
    }
  }
} else if (command === 'revoke') {
  if (typeof flags.token !== 'string') usage();
  if (!tokenLib.isValidFormat(flags.token)) {
    console.error('Token does not look like a ClothDesigner token (cd_live_ + 32 hex).');
    process.exit(1);
  }
  const ok = store.revokeByTokenHash(tokenLib.hash(flags.token));
  console.log(ok ? 'Token revoked.' : 'Token not found or already revoked.');
  process.exit(ok ? 0 : 1);
} else {
  usage();
}
