'use strict';

// Optional bot-side baking: a game server can send just the design canvas (raw
// RGBA) and a garment slot, and the bake, pack assembly and 3D preview render
// run here instead of on the game server. That needs the garment templates to
// be present under this bot's data/templates folder.
//
// Most setups do not use this: the resource bakes on the game server and only
// hands the finished pack to the bot for delivery (POST /api/v1/upload).
//
// The baker modules under src/baker/ are the same pure-Node files the game
// resource uses.

const fs = require('fs');
const path = require('path');

const Exporter = require('./baker/resource-pack-exporter.js');
const PngEncoder = require('./baker/png-encoder.js');
const PreviewRender = require('./baker/preview-render.js');

function loadRegistry(templatesDir) {
  const registryPath = path.join(templatesDir, 'generated', 'registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  return { registryPath, slots: Array.isArray(registry.slots) ? registry.slots : [] };
}

// Same preview-mesh lookup the game server uses: the previews folder whose
// gender matches and which carries <modelFile>.xml next to its model.obj.
function findPreviewObj(templatesDir, slot) {
  // Garments prepared by crclothes_prepare record their mesh directly.
  const recorded = slot.preview && slot.preview.exact && typeof slot.preview.model === 'string' ? slot.preview.model : null;
  if (recorded) {
    const direct = path.resolve(templatesDir, recorded);
    if (direct.startsWith(path.resolve(templatesDir) + path.sep) && fs.existsSync(direct)) {
      return { objPath: direct, uvTransform: 'none' };
    }
  }
  try {
    const previewsRoot = path.join(templatesDir, 'generated', 'previews');
    const wantedXml = `${slot.modelFile}.xml`;
    const genderPrefix = slot.gender === 'male' ? 'male_' : 'female_';
    for (const dir of fs.readdirSync(previewsRoot)) {
      if (!dir.startsWith(genderPrefix)) continue;
      const objPath = path.join(previewsRoot, dir, 'model.obj');
      if (fs.existsSync(path.join(previewsRoot, dir, wantedXml)) && fs.existsSync(objPath)) {
        // uvTransform from the preview's own manifest: raw-UV regens (v7) =
        // 'none'; legacy swap-uv-flip-v exports need rotateCW compensation.
        let uvTransform = 'none';
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(previewsRoot, dir, 'manifest.json'), 'utf8'));
          uvTransform = manifest.version >= 7 ? 'none' : (manifest.uvTransform === 'swap-uv-flip-v' ? 'rotateCW' : 'none');
        } catch {}
        return { objPath, uvTransform };
      }
    }
  } catch {}
  return null;
}

// bake({ config, request }) -> { pack, previewPath|null }
// request: { slotId, textureIndex, width, height, rgba (Buffer), name, mode }
async function bake({ config, request }) {
  const templatesDir = config.templatesDir;
  const { registryPath, slots } = loadRegistry(templatesDir);
  const slot = slots.find((s) => s && s.id === request.slotId);
  if (!slot) throw Object.assign(new Error(`unknown slot '${request.slotId}'`), { code: 'bad_slot' });

  const outputDir = path.join(config.dataDir, 'bakes');
  fs.mkdirSync(outputDir, { recursive: true });

  const options = {
    resourceRoot: templatesDir,
    registryPath,
    slotId: request.slotId,
    textureIndex: request.textureIndex,
    width: request.width,
    height: request.height,
    rawRgba: request.rgba,
    exportName: request.name,
    outputDir,
  };

  const pack =
    request.mode === 'addon'
      ? Exporter.createAddonPack(options)
      : Exporter.createReplacePack(options);

  // 3D preview of the garment wearing the design; flat texture as fallback.
  let previewPath = null;
  try {
    const preview = findPreviewObj(templatesDir, slot);
    let png;
    if (preview) {
      const render = await PreviewRender.renderPreview({
        objPath: preview.objPath,
        textureRgba: request.rgba,
        texWidth: request.width,
        texHeight: request.height,
        size: 1024,
        // Mid-slate ground so the garment stays visible on either Discord theme.
        background: [72, 78, 92],
        // Manifest-driven; raw-UV previews (v7) = none (truth-validated).
        uvTransform: preview.uvTransform,
      });
      png = PngEncoder.encodePng(render.rgba, render.width, render.height, { maxDimension: 512 });
    } else {
      png = PngEncoder.encodePng(request.rgba, request.width, request.height, { maxDimension: 512 });
    }
    previewPath = path.join(outputDir, `${pack.packName}_preview.png`);
    fs.writeFileSync(previewPath, png);
  } catch {
    previewPath = null;
  }

  return { pack, previewPath };
}

module.exports = { bake };
