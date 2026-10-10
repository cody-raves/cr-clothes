local publishedDesign
local lastPublishBySource = {}
local publishedRevision = 0

local allowedBlendModes = {
    normal = true,
    multiply = true,
    screen = true,
    overlay = true,
    darken = true,
    lighten = true,
    ['color-dodge'] = true,
    ['color-burn'] = true,
    ['hard-light'] = true,
    ['soft-light'] = true,
    difference = true,
    exclusion = true,
    hue = true,
    saturation = true,
    color = true,
    luminosity = true
}

local function sanitizeBlendMode(value)
    local mode = tostring(value or 'normal'):lower()
    if allowedBlendModes[mode] then return mode end
    return 'normal'
end

-- Parse the host out of an https URL. The authority runs from '//' to the
-- first '/', '?' or '#'. Any '@' inside it is a credential trick
-- (https://evil.com@allowed.com/) and rejects the URL; a ':port' suffix is
-- stripped before matching.
local function parseImageHost(src)
    local authority = src:match('^https://([^/?#]+)')
    if not authority or authority:find('@', 1, true) then
        return nil
    end
    local host = authority:match('^([^:]+)')
    if not host or host == '' then
        return nil
    end
    return host:lower()
end

local function isAllowedImageHost(host)
    local allowlist = Config.AllowedImageHosts
    if type(allowlist) ~= 'table' then return false end
    for i = 1, #allowlist do
        local entry = tostring(allowlist[i] or ''):lower()
        if entry ~= '' then
            if entry:sub(1, 2) == '*.' then
                local suffix = entry:sub(2)
                if #host > #suffix and host:sub(-#suffix) == suffix then
                    return true
                end
            elseif host == entry then
                return true
            end
        end
    end
    return false
end

local function sanitizeImage(input)
    if type(input) ~= 'table' or type(input.src) ~= 'string' then
        return nil
    end

    local src = input.src
    if #src > Config.MaxImageUrlLength then
        return nil
    end

    local host = parseImageHost(src)
    if not host or not isAllowedImageHost(host) then
        return nil
    end

    return {
        src = src,
        name = tostring(input.name or 'Image'):sub(1, 80),
        x = math.max(0, math.min(Config.CanvasSize, tonumber(input.x) or 512)),
        y = math.max(0, math.min(Config.CanvasSize, tonumber(input.y) or 512)),
        width = math.max(16, math.min(Config.CanvasSize * 2, tonumber(input.width) or 400)),
        height = math.max(16, math.min(Config.CanvasSize * 2, tonumber(input.height) or 400)),
        rotation = math.max(-180, math.min(180, tonumber(input.rotation) or 0)),
        opacity = math.max(0, math.min(1, tonumber(input.opacity) or 1)),
        flipX = input.flipX == true,
        flipY = input.flipY == true,
        blendMode = sanitizeBlendMode(input.blendMode)
    }
end


local function sanitizeImages(input)
    local output = {}
    if type(input) ~= 'table' then return output end
    for i = 1, math.min(#input, 20) do
        local clean = sanitizeImage(input[i])
        if clean then
            clean.id = tostring(input[i].id or ('image-' .. i)):sub(1, 80)
            output[#output + 1] = clean
        end
    end
    return output
end

local function sanitizeDrawPoint(point)
    if type(point) ~= 'table' then return nil end
    return {
        x = math.max(-Config.CanvasSize, math.min(Config.CanvasSize * 2, tonumber(point.x or point[1]) or 0)),
        y = math.max(-Config.CanvasSize, math.min(Config.CanvasSize * 2, tonumber(point.y or point[2]) or 0))
    }
end

local function sanitizeDrawStrokes(input)
    local output = {}
    if type(input) ~= 'table' then return output end
    for i = 1, math.min(#input, 400) do
        local stroke = input[i]
        if type(stroke) == 'table' then
            local color = tostring(stroke.color or '#ffffff')
            if not color:match('^#%x%x%x%x%x%x$') then color = '#ffffff' end
            local points = {}
            if type(stroke.points) == 'table' then
                for pointIndex = 1, math.min(#stroke.points, 700) do
                    local cleanPoint = sanitizeDrawPoint(stroke.points[pointIndex])
                    if cleanPoint then points[#points + 1] = cleanPoint end
                end
            end
            if #points > 0 then
                output[#output + 1] = {
                    color = color,
                    size = math.max(1, math.min(160, tonumber(stroke.size) or 24)),
                    eraser = stroke.eraser == true,
                    points = points
                }
            end
        end
    end
    return output
end

local function sanitizeDraws(input)
    local output = {}
    if type(input) ~= 'table' then return output end
    for i = 1, math.min(#input, 10) do
        local layer = input[i]
        if type(layer) == 'table' then
            output[#output + 1] = {
                id = tostring(layer.id or ('draw-' .. i)):sub(1, 80),
                name = tostring(layer.name or ('Draw layer ' .. i)):sub(1, 80),
                opacity = math.max(0, math.min(1, tonumber(layer.opacity) or 1)),
                blendMode = sanitizeBlendMode(layer.blendMode),
                strokes = sanitizeDrawStrokes(layer.strokes)
            }
        end
    end
    return output
end

local function sanitizeLayerOrder(input, texts, images, draws)
    local valid, seen, output = {}, {}, {}
    for _, layer in ipairs(texts or {}) do valid[layer.id] = true end
    for _, layer in ipairs(images or {}) do valid[layer.id] = true end
    for _, layer in ipairs(draws or {}) do valid[layer.id] = true end
    if type(input) == 'table' then
        for i = 1, math.min(#input, 40) do
            local id = tostring(input[i] or ''):sub(1, 80)
            if valid[id] and not seen[id] then output[#output + 1] = id; seen[id] = true end
        end
    end
    for _, layer in ipairs(texts or {}) do if not seen[layer.id] then output[#output + 1] = layer.id; seen[layer.id] = true end end
    for _, layer in ipairs(images or {}) do if not seen[layer.id] then output[#output + 1] = layer.id; seen[layer.id] = true end end
    for _, layer in ipairs(draws or {}) do if not seen[layer.id] then output[#output + 1] = layer.id; seen[layer.id] = true end end
    return output
end

local function sanitizeTexts(input)
    local output = {}
    if type(input) == 'table' then
        for i = 1, math.min(#input, 10) do
            local layer = input[i]
            if type(layer) == 'table' then
                local color = tostring(layer.color or '#ffffff')
                if not color:match('^#%x%x%x%x%x%x$') then color = '#ffffff' end
                output[#output + 1] = {
                    id = tostring(layer.id or ('text-' .. i)):sub(1, 80),
                    text = tostring(layer.text or ''):sub(1, Config.MaxTextLength),
                    color = color,
                    x = math.max(0, math.min(Config.CanvasSize, tonumber(layer.x) or 512)),
                    y = math.max(0, math.min(Config.CanvasSize, tonumber(layer.y) or 512)),
                    size = math.max(24, math.min(420, tonumber(layer.size) or 190)),
                    rotation = math.max(-180, math.min(180, tonumber(layer.rotation) or 0)),
                    opacity = math.max(0, math.min(1, tonumber(layer.opacity) or 1)),
                    flipX = layer.flipX == true,
                    flipY = layer.flipY == true,
                    blendMode = sanitizeBlendMode(layer.blendMode)
                }
            end
        end
    end
    return output
end

local function sanitizeDesign(input)
    if type(input) ~= 'table' then
        return nil
    end

    local text = tostring(input.text or ''):sub(1, Config.MaxTextLength)
    local background = tostring(input.background or '#1d4ed8')
    local textColor = tostring(input.textColor or '#ffffff')

    if not background:match('^#%x%x%x%x%x%x$') then
        return nil
    end

    if not textColor:match('^#%x%x%x%x%x%x$') then
        return nil
    end

    local texts = sanitizeTexts(input.texts)
    local images = sanitizeImages(input.images)
    local draws = sanitizeDraws(input.draws)
    if #images == 0 and input.image then
        local legacy = sanitizeImage(input.image)
        if legacy then legacy.id = tostring(input.image.id or 'image-legacy'):sub(1, 80); images[1] = legacy end
    end
    return {
        background = background,
        texts = texts,
        text = text,
        textColor = textColor,
        x = math.max(0, math.min(Config.CanvasSize, tonumber(input.x) or 512)),
        y = math.max(0, math.min(Config.CanvasSize, tonumber(input.y) or 512)),
        size = math.max(24, math.min(420, tonumber(input.size) or 190)),
        rotation = math.max(-180, math.min(180, tonumber(input.rotation) or 0)),
        images = images,
        draws = draws,
        layerOrder = sanitizeLayerOrder(input.layerOrder, texts, images, draws),
        image = images[1]
    }
end

-- Publishing broadcasts to every player, so it is ACE-gated unless the server
-- explicitly opts out via Config.OpenPublish (testing/creative servers only).
local function canPublishDesign(sourceId)
    if Config.OpenPublish then return true end
    local sourceKey = tostring(sourceId)
    return IsPlayerAceAllowed(sourceKey, 'clothdesigner.publish')
        or IsPlayerAceAllowed(sourceKey, 'command.clothbuilder')
end

RegisterNetEvent('cr-clothes:publishDesign', function(design)
    local sourceId = source

    if not canPublishDesign(sourceId) then
        TriggerClientEvent(
            'cr-clothes:publishResult',
            sourceId,
            false,
            'You do not have permission to publish shared designs.'
        )
        return
    end

    local now = GetGameTimer()
    local lastPublish = lastPublishBySource[sourceId] or 0

    if lastPublish > 0 and now - lastPublish < Config.PublishCooldownMs then
        TriggerClientEvent(
            'cr-clothes:publishResult',
            sourceId,
            false,
            'Please wait a moment before publishing again.'
        )
        return
    end

    local clean = sanitizeDesign(design)
    if not clean then
        TriggerClientEvent(
            'cr-clothes:publishResult',
            sourceId,
            false,
            'The server rejected the design data.'
        )
        return
    end

    lastPublishBySource[sourceId] = now
    publishedDesign = clean
    publishedRevision = publishedRevision + 1

    local publisherName = GetPlayerName(sourceId) or ('Player %d'):format(sourceId)

    TriggerLatentClientEvent(
        'cr-clothes:applyPublishedDesign',
        -1,
        256000,
        publishedDesign,
        publisherName,
        publishedRevision
    )

    TriggerClientEvent(
        'cr-clothes:publishResult',
        sourceId,
        true,
        ('Published shared design revision %d.'):format(publishedRevision),
        publishedRevision
    )
end)

RegisterNetEvent('cr-clothes:requestPublishedDesign', function()
    if publishedDesign then
        TriggerLatentClientEvent(
            'cr-clothes:applyPublishedDesign',
            source,
            256000,
            publishedDesign,
            nil,
            publishedRevision
        )
    end
end)

AddEventHandler('playerDropped', function()
    lastPublishBySource[source] = nil
end)
