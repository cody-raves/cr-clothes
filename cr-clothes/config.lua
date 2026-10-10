Config = {}

-- Chat command players use to open the designer.
Config.Command = 'clothdesigner'

-- Use original GTA clothing assets only. This mode does not stream custom YDD/YTD/YMT files.
Config.AssetMode = 'existing'
Config.CanvasSize = 1024

-- The generated-slot builder is opened with the server command /clothbuilder.
-- FiveM protects it with the command.clothbuilder ACE.
Config.Builder = {
    command = 'clothbuilder'
}

-- Keep this disabled unless you have tested it on your map. A camera placed inside nearby map
-- geometry can render a black view depending on where the command is opened.
Config.UsePreviewCamera = false

-- Female San Andreas Mercenaries garment selected in OpenIV:
-- update/x64/dlcpacks/mp2023_01/dlc.rpf/x64/models/cdimages/
-- mp2023_01_female.rpf/mp_f_freemode_01_mp_f_2023_01
--
-- YDD: jbib_000_u.ydd
-- YTD: jbib_diff_000_a_uni.ytd
Config.Garment = {
    requiredPedModel = 'mp_f_freemode_01',
    componentId = 11,
    collection = 'mp_f_2023_01',
    collectionHint = '2023_01',
    drawableId = 0,
    textureId = 0,
    paletteId = 0,

    sourceTextureDictionary = 'mp_f_freemode_01_mp_f_2023_01\\jbib_diff_000_a_uni',
    sourceTextureName = 'jbib_diff_000_a_uni'
}

Config.RuntimeTextureDictionary = 'crclothes_runtime'
Config.RuntimeTextureName = 'crclothes_diffuse'

-- Designs travel as compact drawing instructions, never PNG/base64 data.
Config.MaxTextLength = 40
Config.PublishCooldownMs = 1000
Config.MaxImageUrlLength = 2048

-- Design rights (see grants.lua). false = players need a grant to design/export
-- (from a Tebex purchase, an admin command, or a job/gang rule). true = anyone
-- may design, which suits creative/testing servers.
-- Admins with the `command.clothbuilder` ACE always bypass this.
Config.OpenDesign = false

-- When true, job/gang design grants only apply to bosses/leaders (so a police
-- chief can design department gear but a cadet cannot). See bridge/framework.lua.
Config.DesignRequiresBoss = false

-- Publishing broadcasts a design to every player, so it is ACE-gated:
-- allow with `add_ace group.admin clothdesigner.publish allow` (players with
-- command.clothbuilder access may publish too). Set OpenPublish = true to skip
-- the gate entirely -- testing/creative servers only.
Config.OpenPublish = false

-- Remote image layers are only accepted from these https hosts. The parsed
-- URL host is compared case-insensitively; a '*.domain.tld' entry matches any
-- subdomain of domain.tld. An empty list rejects all remote images.
Config.AllowedImageHosts = {
    'i.imgur.com',
    'imgur.com',
    'upload.wikimedia.org',
    'cdn.discordapp.com',
    'media.discordapp.net',
    'i.postimg.cc'
}
