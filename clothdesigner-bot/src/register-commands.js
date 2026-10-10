'use strict';

// One-off: registers the /setup /revoke /status slash commands globally.
// Needs DISCORD_TOKEN and DISCORD_CLIENT_ID in .env. Global commands can take
// up to an hour to propagate; guild installs usually see them much sooner.

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const config = require('./config');

if (!config.discordToken || !config.clientId) {
  console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be set in .env to register commands.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Pair ClothDesigner with this channel and get a new upload token (revokes the old one)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('revoke')
    .setDescription('Revoke the current ClothDesigner upload token without issuing a new one')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show ClothDesigner pairing info and upload counts (never the token)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(config.discordToken);

rest
  .put(Routes.applicationCommands(config.clientId), { body: commands })
  .then((result) => {
    console.log(`Registered ${result.length} global slash commands: ${result.map((c) => '/' + c.name).join(', ')}`);
  })
  .catch((err) => {
    console.error('Command registration failed:', err.message);
    process.exit(1);
  });
