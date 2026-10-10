fx_version 'cerulean'
game 'gta5'

author 'cody-raves'
description 'In-game clothing designer: players design garments, the server bakes a real addon clothing pack'
version '1.0.0'

lua54 'yes'
node_version '22'

ui_page 'web/index.html'

shared_script 'config.lua'
client_scripts {
    'client.lua',
}
server_scripts {
    'builder/fs-bridge.lua',
    'builder/output-store.js',
    'builder/http-download.lua',
    'bridge/framework.lua',
    'grants.lua',
    'server.lua',
    'builder/server.js',
    'builder/prepare-command.js'
}

files {
    'web/index.html',
    'web/renderer.html',
    'web/style.css',
    'web/designer.js',
    'web/browser-preview.js',
    'web/exact-preview.js',
    'web/renderer.js',
    'web/img/*.png',
    'generated/registry.json',
    'generated/previews/**/*'
    -- NOTE: stream/ is deliberately NOT in files{}. Streamed assets are
    -- auto-scanned from stream/; listing them here double-registers them as
    -- plain client downloads, which no working clothing pack does.
}
