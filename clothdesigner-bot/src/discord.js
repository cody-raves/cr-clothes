'use strict';

// Live Discord layer. Only require()d / started when DISCORD_TOKEN is set —
// dry-run mode never loads this module.

const fs = require('fs');
const path = require('path');

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

const tokenLib = require('./token');

function cfgSnippet(config, token) {
  return [
    '```',
    `set clothdesigner_bot_url "${config.publicUrl}"`,
    `set clothdesigner_bot_token "${token}"`,
    '```',
  ].join('\n');
}

function createDiscord({ config, store, log = console.log }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  async function handleSetup(interaction) {
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) {
      return interaction.reply({
        content: 'Run /setup in the text channel where pack cards should be posted.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const hadPairing = !!store.findActiveByGuild(interaction.guildId);
    const token = tokenLib.issue();
    store.issuePairing({
      tokenHash: tokenLib.hash(token),
      guildId: interaction.guildId,
      channelId: channel.id,
      guildName: interaction.guild ? interaction.guild.name : '',
      channelName: channel.name || '',
    });

    const lines = [
      hadPairing
        ? 'Pairing **rotated** — the previous token is now revoked.'
        : 'Pairing created.',
      `Pack cards will be posted in <#${channel.id}>.`,
      '',
      '**Your pairing token (shown only once — save it now):**',
      `\`${token}\``,
      '',
      'Add these two lines to your FiveM **server.cfg** and restart:',
      cfgSnippet(config, token),
      '_Keep the token secret. Re-run /setup any time to rotate it, or /revoke to disable uploads._',
    ];

    return interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleRevoke(interaction) {
    const n = store.revokeByGuild(interaction.guildId);
    return interaction.reply({
      content:
        n > 0
          ? 'Pairing revoked. Uploads from your game server will now be rejected. Run /setup to pair again.'
          : 'No active pairing found for this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleStatus(interaction) {
    const rec = store.findActiveByGuild(interaction.guildId);
    if (!rec) {
      return interaction.reply({
        content: 'Not paired. Run /setup in the channel where you want pack cards.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const count = store.uploadCountForGuild(interaction.guildId);
    return interaction.reply({
      content: [
        '**ClothDesigner pairing**',
        `Channel: <#${rec.channelId}>`,
        `Paired since: ${rec.createdAt}`,
        `Uploads recorded: ${count}`,
        '_The token itself is never shown. Re-run /setup to rotate it._',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  }

  // Button handlers. custom_id format: cd:<action>:<uploadId>
  async function handleButton(interaction) {
    const m = /^cd:(install|delete):([a-f0-9]{16})$/.exec(interaction.customId);
    if (!m) return;
    const [, action, id] = m;
    const upload = store.getUpload(id);

    if (action === 'install') {
      const ensureName = upload
        ? upload.fileName.replace(/\.zip$/i, '')
        : '<resource-name>';
      return interaction.reply({
        content: [
          `**Installing \`${upload ? upload.fileName : 'the pack'}\`**`,
          '',
          '1. Download the zip (attachment or Download button) and **extract** it — you get a folder named `' + ensureName + '`.',
          '2. Upload that folder into your server\'s `resources/` directory (e.g. `resources/[standalone]/`) via FTP or your panel\'s file manager.',
          '3. Add this line to **server.cfg**:',
          '```cfg',
          `ensure ${ensureName}`,
          '```',
          '4. **Fully restart** the server (streamed clothing loads at startup — a resource restart is not enough).',
          '5. The garment/texture is now live. Replace-mode packs override the target garment for everyone; addon packs add new slots.',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (action === 'delete') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need the **Manage Server** permission to delete packs.',
          flags: MessageFlags.Ephemeral,
        });
      }
      try {
        fs.rmSync(path.join(store.filesDir, id), { recursive: true, force: true });
      } catch {}
      store.markUploadDeleted(id);

      // Disable the buttons on the original card and mark it deleted.
      const message = interaction.message;
      const disabledRows = (message.components || []).map((row) => ({
        type: 1,
        components: row.components.map((c) => {
          const btn = { type: 2, style: c.style, label: c.label, disabled: true };
          if (c.style === 5) btn.url = c.url; else btn.custom_id = c.customId || c.custom_id;
          return btn;
        }),
      }));
      const editedEmbeds = message.embeds.map((e) => {
        const data = e.toJSON ? e.toJSON() : e;
        return { ...data, footer: { text: 'ClothDesigner — deleted' }, color: 0x991b1b };
      });
      await interaction.update({ embeds: editedEmbeds, components: disabledRows });
      return interaction.followUp({
        content: 'Pack deleted from the bot\'s storage. (Anything already installed on a game server is unaffected.)',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton()) {
      try {
        await handleButton(interaction);
      } catch (err) {
        log(`[discord] button ${interaction.customId} failed: ${err.stack || err.message}`);
        const msg = { content: 'Something went wrong — try again.', flags: MessageFlags.Ephemeral };
        if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
        else await interaction.reply(msg).catch(() => {});
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.inGuild()) {
      return interaction
        .reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
    // Commands are registered with ManageGuild default permissions, but check
    // again server-side in case an admin loosened the command permissions.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction
        .reply({ content: 'You need the **Manage Server** permission to use this.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }

    try {
      if (interaction.commandName === 'setup') return await handleSetup(interaction);
      if (interaction.commandName === 'revoke') return await handleRevoke(interaction);
      if (interaction.commandName === 'status') return await handleStatus(interaction);
    } catch (err) {
      log(`[discord] ${interaction.commandName} failed: ${err.stack || err.message}`);
      const msg = { content: 'Something went wrong — try again.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg).catch(() => {});
      } else {
        await interaction.reply(msg).catch(() => {});
      }
    }
  });

  async function start() {
    await client.login(config.discordToken);
    await new Promise((resolve) => {
      if (client.isReady()) return resolve();
      client.once('clientReady', resolve);
      client.once('ready', resolve); // discord.js <14.16 event name
    });
    log(`[discord] logged in as ${client.user.tag}`);
  }

  // Posts a card payload (from src/card.js) to its paired channel.
  async function deliver(card) {
    const channel = await client.channels.fetch(card.channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`paired channel ${card.channelId} not found or not text-based`);
    }
    const message = { embeds: [card.embed], components: card.components || [] };
    message.files = [];
    if (card.attachment) {
      message.files.push({ attachment: card.attachment.filePath, name: card.attachment.fileName });
    }
    if (card.preview) {
      message.files.push({ attachment: card.preview.filePath, name: card.preview.fileName });
    }
    await channel.send(message);
    return card.attachment ? 'attach' : 'link';
  }

  async function stop() {
    await client.destroy();
  }

  return { client, start, deliver, stop };
}

module.exports = { createDiscord };
