'use strict';

const EMBED_COLOR = 0x7c3aed; // violet

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const INSTALL_LINE =
  'Install: extract the zip into your server’s `resources/` folder, add an `ensure <resource-name>` line to server.cfg, then restart the server.';

// Builds the Discord message payload for one uploaded pack. The same object
// is used by the live poster (src/discord.js) and the dry-run outbox writer.
function buildCard({ record, id, name, mode, fileName, size, filePath, previewPath, meta, config }) {
  const attach = size <= config.attachLimitMb * 1024 * 1024;
  const downloadUrl = `${config.publicUrl}/files/${id}/${fileName}`;
  const serverName =
    (meta && typeof meta.server === 'string' && meta.server.slice(0, 100)) ||
    record.guildName ||
    'unknown';

  const descriptionParts = ['A new clothing pack is ready.'];
  if (!attach) {
    descriptionParts.push(`**[Download ${fileName}](${downloadUrl})** (too large to attach)`);
  }
  descriptionParts.push(INSTALL_LINE);

  const previewFileName = previewPath ? `preview_${id}.png` : null;

  const embed = {
    title: name,
    description: descriptionParts.join('\n\n'),
    color: EMBED_COLOR,
    fields: [
      { name: 'Mode', value: mode, inline: true },
      { name: 'File', value: fileName, inline: true },
      { name: 'Size', value: humanSize(size), inline: true },
      { name: 'Server', value: serverName, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'ClothDesigner' },
  };
  if (previewFileName) {
    embed.image = { url: `attachment://${previewFileName}` };
  }

  // Button row. Download is a link button to the self-hosted copy (works even
  // after the attachment is gone); the other two are handled in discord.js.
  const components = [
    {
      type: 1, // action row
      components: [
        { type: 2, style: 5, label: 'Download', url: downloadUrl },
        { type: 2, style: 2, label: 'Install steps', custom_id: `cd:install:${id}` },
        { type: 2, style: 4, label: 'Delete', custom_id: `cd:delete:${id}` },
      ],
    },
  ];

  return {
    id,
    guildId: record.guildId,
    channelId: record.channelId,
    embed,
    components,
    wouldDeliver: attach ? 'attach' : 'link',
    attachment: attach ? { fileName, filePath, size } : null,
    preview: previewPath ? { fileName: previewFileName, filePath: previewPath } : null,
    downloadUrl,
  };
}

module.exports = { buildCard, humanSize };
