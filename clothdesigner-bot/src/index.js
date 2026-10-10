'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config');
const Store = require('./store');
const { createApi } = require('./api');

const store = new Store(config.dataDir);

let discord = null;
let deliver;

if (config.dryRun) {
  // Dry-run delivery: write the exact would-be Discord payload to
  // data/outbox/<timestamp>-<id>.json and log a one-line summary.
  deliver = async (card) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(store.outboxDir, `${stamp}-${card.id}.json`);
    fs.writeFileSync(
      outFile,
      JSON.stringify({ ...card, dryRun: true, writtenAt: new Date().toISOString() }, null, 2)
    );
    console.log(
      `[dry-run] card -> outbox/${path.basename(outFile)} ` +
        `guild=${card.guildId} channel=${card.channelId} ` +
        `wouldDeliver=${card.wouldDeliver} title=${JSON.stringify(card.embed.title)}`
    );
    return 'outbox';
  };
} else {
  const { createDiscord } = require('./discord');
  discord = createDiscord({ config, store });
  deliver = (card) => discord.deliver(card);
}

const server = createApi({ config, store, deliver });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[bot] ${signal} received, shutting down...`);
  await new Promise((resolve) => server.close(resolve));
  if (discord) await discord.stop().catch(() => {});
  console.log('[bot] bye');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  if (discord) {
    await discord.start();
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, resolve);
  });
  console.log('==========================================');
  console.log(' ClothDesigner bot');
  console.log(` mode:       ${config.dryRun ? 'DRY-RUN (no DISCORD_TOKEN — cards go to data/outbox/)' : 'LIVE (Discord connected)'}`);
  console.log(` http:       listening on port ${config.port}`);
  console.log(` public url: ${config.publicUrl}`);
  console.log(` data dir:   ${config.dataDir}`);
  console.log(` pairings:   ${store.activeServers().length} active`);
  console.log('==========================================');
}

main().catch((err) => {
  console.error('[bot] fatal:', err.stack || err.message);
  process.exit(1);
});
