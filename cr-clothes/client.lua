local resourceName = GetCurrentResourceName()
local duiObject
local runtimeTxd
local textureReady = false
local editorOpen = false
local uiMode = 'designer'
local previewCamera
local originalHeading
local pendingPublish = false
local debugTextureUntil = 0
local resolvedCollection
local sendDesignToRenderer
local destroyBrowserPreview
local generatedSlots = {}
local exportUploads = {}
local activeGarment = Config.Garment
local browserPed
local browserCamera
local browserPedHeading = 180.0
local browserItemsCache
local currentDesign = {
    background = '#1d4ed8',
    texts = {},
    text = '',
    textColor = '#ffffff',
    x = 512,
    y = 512,
    size = 190,
    rotation = 0,
    image = nil,
    images = {},
    draws = {},
    layerOrder = {}
}

local function notify(message)
    BeginTextCommandThefeedPost('STRING')
    AddTextComponentSubstringPlayerName(('[Clothing] %s'):format(message))
    EndTextCommandThefeedPostTicker(false, false)
end

local function isRequiredPed()
    return GetEntityModel(PlayerPedId()) == joaat(activeGarment.requiredPedModel)
end


local function textureCollectionName(collection, gender, kind)
    local value = tostring(collection or '')
    if value == '' then return value end

    local shortPrefix = gender == 'male' and 'mp_m_' or 'mp_f_'
    local componentFullPrefix = gender == 'male'
        and 'mp_m_freemode_01_mp_m_'
        or 'mp_f_freemode_01_mp_f_'
    local propFullPrefix = gender == 'male'
        and 'mp_m_freemode_01_p_mp_m_'
        or 'mp_f_freemode_01_p_mp_f_'
    local fullPrefix = kind == 'prop' and propFullPrefix or componentFullPrefix

    if value:sub(1, #componentFullPrefix) == componentFullPrefix
        or value:sub(1, #propFullPrefix) == propFullPrefix
    then
        return value
    end

    if value:sub(1, #shortPrefix) == shortPrefix then
        return fullPrefix .. value:sub(#shortPrefix + 1)
    end

    return value
end

local function loadGeneratedSlots()
    generatedSlots = {}
    local raw = LoadResourceFile(resourceName, 'generated/registry.json')

    if not raw then
        activeGarment = Config.Garment
        return
    end

    local ok, registry = pcall(json.decode, raw)

    if not ok or type(registry) ~= 'table' or type(registry.slots) ~= 'table' then
        activeGarment = Config.Garment
        return
    end

    for _, slot in ipairs(registry.slots) do
        if type(slot) == 'table'
            and (slot.kind == 'component' or slot.kind == 'prop')
            and type(slot.sourceTextureDictionary) == 'string'
        then
            local gender = slot.gender == 'male' and 'male' or 'female'
            local genderPrefix = gender == 'male' and 'mp_m_' or 'mp_f_'
            local runtimeCollection = slot.fullCollection or (genderPrefix .. tostring(slot.collection))
            local textureCollection = slot.textureCollection
                or textureCollectionName(runtimeCollection, gender, slot.kind)
            local sourceTextureName = slot.sourceTextureName
            local sourceTextureDictionary = slot.sourceTextureDictionary

            -- Older generated registries incorrectly used FiveM's short runtime
            -- collection (for example mp_f_2023_02) as the TXD prefix. Repair
            -- those entries in memory so existing prepared garments keep working.
            if type(sourceTextureName) == 'string' then
                sourceTextureDictionary = textureCollection .. '\\' .. sourceTextureName
            end

            generatedSlots[#generatedSlots + 1] = {
                id = slot.id,
                label = slot.displayName or slot.id,
                assetMode = slot.assetMode,
                gender = gender,
                kind = slot.kind,
                requiredPedModel = slot.gender == 'male'
                    and 'mp_m_freemode_01'
                    or 'mp_f_freemode_01',
                componentId = slot.componentId,
                propId = slot.anchorId or slot.propId,
                collection = runtimeCollection,
                textureCollection = textureCollection,
                collectionHint = tostring(slot.collection),
                drawableId = tonumber(slot.drawableId) or 0,
                globalDrawableId = tonumber(slot.globalDrawableId),
                textureId = tonumber(slot.textureId) or 0,
                textureCount = tonumber(slot.textureCount) or 1,
                paletteId = tonumber(slot.paletteId) or 0,
                sourceTextureDictionary = sourceTextureDictionary,
                sourceTextureName = slot.sourceTextureName,
                sourceTextureAliases = slot.sourceTextureAliases,
                textureFiles = slot.textureFiles,
                bakedVariants = slot.bakedVariants,
                category = slot.category,
                prefix = slot.prefix,
                modelFile = slot.modelFile,
                preview = slot.preview
            }
        end
    end

    if #generatedSlots > 0 then
        local preferredIndex = registry.assetMode == 'existing' and 1 or #generatedSlots
        activeGarment = generatedSlots[preferredIndex]
        print(('[cr-clothes] Selected garment slot %s (%s).'):format(
            activeGarment.id or '?',
            activeGarment.sourceTextureDictionary
        ))
    else
        activeGarment = Config.Garment
    end
end

local function resolveGarmentCollection()
    if resolvedCollection then
        return resolvedCollection
    end

    local ped = PlayerPedId()
    local count = GetPedCollectionsCount(ped)
    -- A prepared garment is on record under its folder name
    -- (mp_f_freemode_01_mp_f_mypack) while the game lists the collection by
    -- its dlc name (mp_f_mypack), so the comparison with
    -- activeGarment.collection does not match it. The dlc name is the hint,
    -- with or without the gender prefix. A name that merely contains the hint
    -- counts only when neither is listed: a short hint ('cd', 'a1') is also
    -- found inside the name of an installed export, mp_f_cd_<12 hex digits>.
    local hint = activeGarment.collectionHint and tostring(activeGarment.collectionHint):lower() or nil
    local genderPrefix = activeGarment.requiredPedModel == 'mp_m_freemode_01' and 'mp_m_' or 'mp_f_'
    local namedCollection
    local hintedCollection

    for index = 0, count - 1 do
        local name = GetPedCollectionName(ped, index)

        if name == activeGarment.collection then
            resolvedCollection = name
            return resolvedCollection
        end

        if hint and name then
            local lowered = name:lower()
            if lowered == hint or lowered == genderPrefix .. hint then
                namedCollection = name
            elseif lowered:find(hint, 1, true) then
                hintedCollection = name
            end
        end
    end

    resolvedCollection = namedCollection or hintedCollection
    return resolvedCollection
end

local function textureReplacementTargets(garment)
    local targets = {}
    local seen = {}

    local function addTarget(textureName)
        if type(textureName) ~= 'string' or textureName == '' then return end
        local dictionary = garment.sourceTextureDictionary
        if garment.assetMode == 'generated' and type(garment.textureFiles) == 'table' and #garment.textureFiles > 0 then
            local textureIndex = math.max(1, math.min(#garment.textureFiles, math.floor(tonumber(garment.textureId) or 0) + 1))
            local textureFile = tostring(garment.textureFiles[textureIndex] or '')
            local textureDictionary = textureFile:gsub('%.ytd$', '')
            if textureDictionary ~= '' and type(garment.textureCollection) == 'string' then
                dictionary = garment.textureCollection .. '\\' .. textureDictionary
            end
        elseif type(garment.textureCollection) == 'string' then
            dictionary = garment.textureCollection .. '\\' .. textureName
        end
        local key = dictionary .. '|' .. textureName
        if seen[key] then return end
        seen[key] = true
        targets[#targets + 1] = {
            dictionary = dictionary,
            name = textureName
        }
    end

    addTarget(garment.sourceTextureName)
    if type(garment.sourceTextureAliases) == 'table' then
        for _, alias in ipairs(garment.sourceTextureAliases) do
            addTarget(alias)
        end
    end

    return targets
end

local function removeTextureReplacements(garment)
    if type(garment) ~= 'table' then return end
    for _, target in ipairs(textureReplacementTargets(garment)) do
        RemoveReplaceTexture(target.dictionary, target.name)
    end
end

local function applyTextureReplacement()
    if not textureReady then
        return false
    end

    -- Re-registering after the drawable has streamed is intentional.
    -- AddReplaceTexture can otherwise appear to succeed while the target DLC
    -- texture dictionary was not resident when the replacement was added.
    for _, target in ipairs(textureReplacementTargets(activeGarment)) do
        RemoveReplaceTexture(target.dictionary, target.name)
        AddReplaceTexture(
            target.dictionary,
            target.name,
            Config.RuntimeTextureDictionary,
            Config.RuntimeTextureName
        )
    end

    return true
end

local function isGlobalComponentVariationValid(ped, componentId, drawableId, textureId)
    if type(drawableId) ~= 'number' or drawableId < 0 then
        return false
    end

    local drawableCount = GetNumberOfPedDrawableVariations(ped, componentId)
    if drawableId >= drawableCount then
        return false
    end

    local textureCount = GetNumberOfPedTextureVariations(ped, componentId, drawableId)
    return textureCount <= 0 or textureId < textureCount
end

local function wearProofGarment()
    if not isRequiredPed() then
        local message = ('Use the %s ped model for the configured proof garment.'):format(
            activeGarment.requiredPedModel
        )
        notify(message)
        return false, message
    end

    local ped = PlayerPedId()
    local collection = resolveGarmentCollection()

    if activeGarment.kind == 'prop' then
        if not collection then
            local message = ('Could not find the %s clothing collection on this game build.'):format(
                activeGarment.collectionHint or activeGarment.collection
            )
            notify(message)
            return false, message
        end

        SetPedCollectionPropIndex(
            ped,
            activeGarment.propId,
            collection,
            activeGarment.drawableId,
            activeGarment.textureId,
            true
        )
    else
        local equipped = false

        if collection then
            local valid = IsPedCollectionComponentVariationValid(
                ped,
                activeGarment.componentId,
                collection,
                activeGarment.drawableId,
                activeGarment.textureId,
                activeGarment.paletteId
            )

            if valid then
                SetPedCollectionComponentVariation(
                    ped,
                    activeGarment.componentId,
                    collection,
                    activeGarment.drawableId,
                    activeGarment.textureId,
                    activeGarment.paletteId
                )
                equipped = true
            end
        end

        -- Some older vanilla freemode pieces, especially Heists masks, show up
        -- in public databases as a DLC-relative drawable and a global drawable.
        -- If FiveM's collection validation rejects the relative form, equip the
        -- normal global component index while still replacing the same TXD.
        if not equipped
            and activeGarment.globalDrawableId
            and isGlobalComponentVariationValid(
                ped,
                activeGarment.componentId,
                activeGarment.globalDrawableId,
                activeGarment.textureId
            )
        then
            SetPedComponentVariation(
                ped,
                activeGarment.componentId,
                activeGarment.globalDrawableId,
                activeGarment.textureId,
                activeGarment.paletteId
            )
            equipped = true
        end

        if not equipped then
            local message = collection
                and ('Configured garment is unavailable: collection=%s drawable=%s texture=%s.'):format(
                    collection,
                    activeGarment.drawableId,
                    activeGarment.textureId
                )
                or ('Could not find the %s clothing collection on this game build.'):format(
                    activeGarment.collectionHint or activeGarment.collection
                )
            notify(message)
            return false, message
        end
    end

    -- Give the DLC drawable time to stream, then bind the runtime texture to
    -- the now-loaded source material.
    CreateThread(function()
        Wait(300)
        applyTextureReplacement()
        sendDesignToRenderer(currentDesign)
    end)

    return true
end

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

local function sanitizeImage(input, fallback)
    if input == false then
        return nil
    end

    if type(input) ~= 'table' then
        return fallback
    end

    local src = input.src
    if type(src) ~= 'string' and fallback then
        src = fallback.src
    end

    if type(src) ~= 'string' then
        return nil
    end

    local allowedHttpsUrl = src:match('^https://')
        and #src <= Config.MaxImageUrlLength

    if not allowedHttpsUrl then
        return nil
    end

    return {
        src = src,
        name = tostring(input.name or (fallback and fallback.name) or 'Image'):sub(1, 80),
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


local function sanitizeImages(input, fallback)
    local output = {}
    local source = input
    if type(source) ~= 'table' then source = fallback end
    if type(source) ~= 'table' then return output end
    for i = 1, math.min(#source, 20) do
        local clean = sanitizeImage(source[i], nil)
        if clean then
            clean.id = tostring(source[i].id or ('image-' .. i)):sub(1, 80)
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
    local valid = {}
    for _, layer in ipairs(texts or {}) do valid[layer.id] = true end
    for _, layer in ipairs(images or {}) do valid[layer.id] = true end
    for _, layer in ipairs(draws or {}) do valid[layer.id] = true end
    local output, seen = {}, {}
    if type(input) == 'table' then
        for i = 1, math.min(#input, 40) do
            local id = tostring(input[i] or ''):sub(1, 80)
            if valid[id] and not seen[id] then
                output[#output + 1] = id
                seen[id] = true
            end
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

local function sanitizeDesign(input, fallbackImages)
    if type(input) ~= 'table' then
        return nil
    end

    local text = tostring(input.text or ''):sub(1, Config.MaxTextLength)
    local background = tostring(input.background or '#1d4ed8')
    local textColor = tostring(input.textColor or '#ffffff')

    if not background:match('^#%x%x%x%x%x%x$') then
        background = '#1d4ed8'
    end

    if not textColor:match('^#%x%x%x%x%x%x$') then
        textColor = '#ffffff'
    end

    local texts = sanitizeTexts(input.texts)
    local images = sanitizeImages(input.images, fallbackImages)
    local draws = sanitizeDraws(input.draws)
    if #images == 0 and input.image then
        local legacy = sanitizeImage(input.image, nil)
        if legacy then legacy.id = tostring(input.image.id or 'image-legacy'):sub(1, 80); images[1] = legacy end
    end
    local clean = {
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

    return clean
end

sendDesignToRenderer = function(design)
    if not duiObject then
        return
    end

    SendDuiMessage(duiObject, json.encode({
        action = 'render',
        design = design
    }))
end

local function startPreviewCamera()
    if not Config.UsePreviewCamera then
        return
    end

    local ped = PlayerPedId()
    local pedCoords = GetEntityCoords(ped)
    local cameraCoords = GetOffsetFromEntityInWorldCoords(ped, 0.0, 2.45, 0.72)

    originalHeading = GetEntityHeading(ped)
    previewCamera = CreateCam('DEFAULT_SCRIPTED_CAMERA', true)
    SetCamCoord(previewCamera, cameraCoords.x, cameraCoords.y, cameraCoords.z)
    PointCamAtCoord(previewCamera, pedCoords.x, pedCoords.y, pedCoords.z + 0.62)
    SetCamFov(previewCamera, 33.0)
    SetCamActive(previewCamera, true)
    RenderScriptCams(true, true, 350, true, true)
end

local function stopPreviewCamera()
    if not previewCamera then
        return
    end

    RenderScriptCams(false, true, 250, true, true)
    DestroyCam(previewCamera, false)
    previewCamera = nil

    if originalHeading then
        SetEntityHeading(PlayerPedId(), originalHeading)
        originalHeading = nil
    end
end

local function initializeRuntimeTexture()
    local rendererUrl = ('https://cfx-nui-%s/web/renderer.html'):format(resourceName)
    duiObject = CreateDui(rendererUrl, Config.CanvasSize, Config.CanvasSize)

    CreateThread(function()
        local timeoutAt = GetGameTimer() + 10000

        while not IsDuiAvailable(duiObject) and GetGameTimer() < timeoutAt do
            Wait(50)
        end

        if not IsDuiAvailable(duiObject) then
            print('[cr-clothes] DUI renderer did not become available.')
            return
        end

        runtimeTxd = CreateRuntimeTxd(Config.RuntimeTextureDictionary)
        CreateRuntimeTextureFromDuiHandle(
            runtimeTxd,
            Config.RuntimeTextureName,
            GetDuiHandle(duiObject)
        )

        textureReady = true
        applyTextureReplacement()
        sendDesignToRenderer(currentDesign)
        TriggerServerEvent('cr-clothes:requestPublishedDesign')
        print('[cr-clothes] Runtime texture replacement is ready.')
    end)
end

local function openEditor()
    if not textureReady then
        notify('Runtime texture is still loading. Try again in a moment.')
        return
    end

    -- Reload the generated registry every time the editor opens so newly
    -- extracted garments appear without falling back to Config.Garment.
    local previousId = activeGarment and activeGarment.id
    loadGeneratedSlots()
    if previousId then
        for _, garment in ipairs(generatedSlots) do
            if garment.id == previousId then
                activeGarment = garment
                break
            end
        end
    end

    if #generatedSlots > 0 and activeGarment then
        wearProofGarment()
    else
        activeGarment = nil
    end
    -- The NUI WebGL pane renders the prepared exact garment mesh.
    stopPreviewCamera()
    destroyBrowserPreview()
    editorOpen = true
    uiMode = 'designer'
    SetNuiFocus(true, true)
    SendNUIMessage({
        action = 'open',
        design = currentDesign,
        canvasSize = Config.CanvasSize,
        garments = generatedSlots,
        activeGarmentId = activeGarment and activeGarment.id or nil
    })
end


local browserCategories = {
    { id = 'masks', label = 'Masks', kind = 'component', componentId = 1, prefix = 'berd' },
    { id = 'pants', label = 'Pants', kind = 'component', componentId = 4, prefix = 'lowr' },
    { id = 'bags', label = 'Bags', kind = 'component', componentId = 5, prefix = 'hand' },
    { id = 'shoes', label = 'Shoes', kind = 'component', componentId = 6, prefix = 'feet' },
    { id = 'accessories', label = 'Accessories', kind = 'component', componentId = 7, prefix = 'teef' },
    { id = 'undershirts', label = 'Undershirts', kind = 'component', componentId = 8, prefix = 'accs' },
    { id = 'tops', label = 'Shirts / Jackets', kind = 'component', componentId = 11, prefix = 'jbib' },
    { id = 'hats', label = 'Hats', kind = 'prop', propId = 0, prefix = 'p_head' },
    { id = 'glasses', label = 'Glasses', kind = 'prop', propId = 1, prefix = 'p_eyes' }
}

local function loadModel(modelName)
    local model = joaat(modelName)
    RequestModel(model)
    local timeout = GetGameTimer() + 10000
    while not HasModelLoaded(model) and GetGameTimer() < timeout do Wait(0) end
    return HasModelLoaded(model), model
end

destroyBrowserPreview = function()
    if browserCamera then
        RenderScriptCams(false, true, 200, true, true)
        DestroyCam(browserCamera, false)
        browserCamera = nil
    end
    if browserPed and DoesEntityExist(browserPed) then
        DeleteEntity(browserPed)
        browserPed = nil
    end
    SetEntityVisible(PlayerPedId(), true, false)
end

local function resetBrowserCamera()
    if not browserPed or not DoesEntityExist(browserPed) then return end
    if browserCamera then DestroyCam(browserCamera, false) end
    local coords = GetEntityCoords(browserPed)
    local cameraCoords = GetOffsetFromEntityInWorldCoords(browserPed, 0.0, 2.6, 0.72)
    browserCamera = CreateCam('DEFAULT_SCRIPTED_CAMERA', true)
    SetCamCoord(browserCamera, cameraCoords.x, cameraCoords.y, cameraCoords.z)
    PointCamAtCoord(browserCamera, coords.x, coords.y, coords.z + 0.65)
    SetCamFov(browserCamera, 34.0)
    SetCamActive(browserCamera, true)
    RenderScriptCams(true, true, 250, true, true)
end

local function createBrowserPed(gender)
    local modelName = gender == 'male' and 'mp_m_freemode_01' or 'mp_f_freemode_01'
    local ok, model = loadModel(modelName)
    if not ok then return false end
    if browserPed and DoesEntityExist(browserPed) then DeleteEntity(browserPed) end
    local player = PlayerPedId()
    local coords = GetEntityCoords(player)
    browserPed = CreatePed(4, model, coords.x, coords.y, coords.z, browserPedHeading, false, false)
    SetEntityInvincible(browserPed, true)
    SetEntityVisible(browserPed, true, false)
    SetEntityAlpha(browserPed, 255, false)
    SetEntityCollision(browserPed, false, false)
    FreezeEntityPosition(browserPed, true)
    SetBlockingOfNonTemporaryEvents(browserPed, true)
    SetPedDefaultComponentVariation(browserPed)
    SetEntityVisible(player, false, false)
    SetModelAsNoLongerNeeded(model)
    resetBrowserCamera()
    return true
end

local function alphaTextureLetter(textureId)
    return string.char(97 + math.max(0, math.min(25, textureId)))
end

local function enumerateBrowserItemsForGender(gender)
    local modelName = gender == 'male' and 'mp_m_freemode_01' or 'mp_f_freemode_01'
    local ok, model = loadModel(modelName)
    if not ok then return {} end
    local coords = GetEntityCoords(PlayerPedId())
    local ped = CreatePed(4, model, coords.x, coords.y, coords.z - 20.0, 0.0, false, false)
    SetEntityVisible(ped, false, false)
    FreezeEntityPosition(ped, true)
    local items = {}
    local collectionCount = GetPedCollectionsCount(ped)
    for collectionIndex = 0, collectionCount - 1 do
        local collection = GetPedCollectionName(ped, collectionIndex)
        -- The empty collection is base-game clothing. The extractor currently
        -- targets named DLC collections, whose RPF path can be derived safely.
        if collection and collection ~= '' then
            for _, category in ipairs(browserCategories) do
                if category.kind == 'component' then
                    local count = GetNumberOfPedCollectionDrawableVariations(ped, category.componentId, collection)
                    for localIndex = 0, count - 1 do
                        local textureCount = GetNumberOfPedCollectionTextureVariations(ped, category.componentId, collection, localIndex)
                        items[#items + 1] = {
                            gender = gender, kind = 'component', category = category.id,
                            categoryLabel = category.label, componentId = category.componentId,
                            prefix = category.prefix, collection = collection,
                            drawableId = localIndex, textureCount = textureCount,
                            modelFile = ('%s_%03d_u.ydd'):format(category.prefix, localIndex),
                            textureFile = ('%s_diff_%03d_a_uni.ytd'):format(category.prefix, localIndex)
                        }
                    end
                else
                    local count = GetNumberOfPedCollectionPropDrawableVariations(ped, category.propId, collection)
                    for localIndex = 0, count - 1 do
                        local textureCount = GetNumberOfPedCollectionPropTextureVariations(ped, category.propId, collection, localIndex)
                        items[#items + 1] = {
                            gender = gender, kind = 'prop', category = category.id,
                            categoryLabel = category.label, propId = category.propId,
                            prefix = category.prefix, collection = collection,
                            drawableId = localIndex, textureCount = textureCount,
                            modelFile = ('%s_%03d.ydd'):format(category.prefix, localIndex),
                            textureFile = ('%s_diff_%03d_a.ytd'):format(category.prefix, localIndex)
                        }
                    end
                end
            end
        end
    end
    DeleteEntity(ped)
    SetModelAsNoLongerNeeded(model)
    return items
end

local function buildBrowserPayload()
    if browserItemsCache then return browserItemsCache end
    local items = enumerateBrowserItemsForGender('female')
    local maleItems = enumerateBrowserItemsForGender('male')
    for _, item in ipairs(maleItems) do items[#items + 1] = item end
    browserItemsCache = { categories = browserCategories, items = items }
    return browserItemsCache
end

local function textureFileForItem(item, textureId)
    local letter = alphaTextureLetter(textureId)
    if item.kind == 'prop' then
        return ('%s_diff_%03d_%s.ytd'):format(item.prefix, item.drawableId, letter)
    end
    return ('%s_diff_%03d_%s_uni.ytd'):format(item.prefix, item.drawableId, letter)
end

local function openBuilder(payload)
    stopPreviewCamera()
    destroyBrowserPreview()
    loadGeneratedSlots()
    editorOpen = true
    uiMode = 'builder'
    SetNuiFocus(true, true)
    SendNUIMessage({
        action = 'openBuilder',
        garments = generatedSlots,
        activeGarmentId = activeGarment and activeGarment.id or nil,
        message = payload.message
    })
end

local function closeEditor()
    editorOpen = false
    stopPreviewCamera()
    destroyBrowserPreview()
    SetNuiFocus(false, false)
    SendNUIMessage({ action = 'close' })
end

RegisterCommand(Config.Command, openEditor, false)

RegisterCommand('clothtex', function()
    if not textureReady then
        notify('Runtime texture is not ready.')
        return
    end

    debugTextureUntil = GetGameTimer() + 8000
    notify('Showing the raw runtime texture for 8 seconds.')
end, false)

RegisterCommand('clothinfo', function()
    if not isRequiredPed() then
        notify(('Switch to %s, then run /clothinfo again.'):format(
            activeGarment.requiredPedModel
        ))
        return
    end

    resolvedCollection = nil
    local collection = resolveGarmentCollection()

    if not collection then
        notify(('No collection containing "%s" was found.'):format(
            activeGarment.collectionHint or activeGarment.collection
        ))
        return
    end

    local valid = activeGarment.kind == 'prop' or IsPedCollectionComponentVariationValid(
        PlayerPedId(),
        activeGarment.componentId,
        collection,
        activeGarment.drawableId,
        activeGarment.textureId,
        activeGarment.paletteId
    )

    print(('[cr-clothes] collection=%s valid=%s txd=%s txn=%s'):format(
        collection,
        tostring(valid),
        activeGarment.sourceTextureDictionary,
        activeGarment.sourceTextureName
    ))
    for _, target in ipairs(textureReplacementTargets(activeGarment)) do
        print(('[cr-clothes] replacement-target txd=%s txn=%s'):format(
            target.dictionary,
            target.name
        ))
    end

    notify(('Collection: %s | drawable valid: %s'):format(
        collection,
        tostring(valid)
    ))
end, false)

RegisterCommand('clothslots', function()
    if #generatedSlots == 0 then
        notify('No generated slots were loaded from generated/registry.json.')
        return
    end

    for index, garment in ipairs(generatedSlots) do
        print(('[cr-clothes] slot=%d id=%s label=%s collection=%s drawable=%d'):format(
            index,
            garment.id or '?',
            garment.label or '?',
            garment.collection,
            garment.drawableId
        ))
    end

    notify(('%d generated slots printed to F8. Use /clothslot [number].'):format(#generatedSlots))
end, false)

RegisterCommand('clothslot', function(_, args)
    local index = math.floor(tonumber(args[1]) or 0)
    local garment = generatedSlots[index]

    if not garment then
        notify(('Choose a generated slot from 1 to %d.'):format(#generatedSlots))
        return
    end

    if textureReady then
        removeTextureReplacements(activeGarment)
    end

    activeGarment = garment
    resolvedCollection = nil
    applyTextureReplacement()
    wearProofGarment()
    notify(('Selected slot %d: %s'):format(index, garment.label or garment.id))
end, false)

RegisterNUICallback('preview', function(data, callback)
    local design = sanitizeDesign(data, currentDesign.images)

    if design then
        currentDesign = design
        sendDesignToRenderer(currentDesign)
    end

    callback({ ok = design ~= nil })
end)

RegisterNUICallback('setImage', function(data, callback)
    local images = sanitizeImages(data.images, {})
    if type(data.images) == 'table' and #data.images > 0 and #images == 0 then
        callback({ ok = false, message = 'Image source was rejected.' })
        return
    end
    currentDesign.images = images
    currentDesign.image = images[1]
    currentDesign.layerOrder = sanitizeLayerOrder(data.layerOrder, currentDesign.texts or {}, images, currentDesign.draws or {})
    sendDesignToRenderer(currentDesign)
    callback({ ok = true })
end)

RegisterNUICallback('publish', function(data, callback)
    local design = sanitizeDesign(data, currentDesign.images)

    if not design then
        callback({ ok = false, message = 'Invalid design data.' })
        return
    end

    if pendingPublish then
        callback({ ok = false, message = 'A publish request is already pending.' })
        return
    end

    currentDesign = design
    sendDesignToRenderer(currentDesign)
    applyTextureReplacement()
    pendingPublish = true
    TriggerLatentServerEvent(
        'cr-clothes:publishDesign',
        256000,
        currentDesign
    )
    callback({ ok = true, pending = true })
end)

RegisterNUICallback('exportBegin', function(data, callback)
    data = data or {}
    local uploadId = tostring(data.uploadId or ''):sub(1, 80)
    local totalChunks = math.floor(tonumber(data.totalChunks) or 0)

    if uploadId == '' or totalChunks < 1 or totalChunks > 1000 then
        callback({ ok = false, message = 'Invalid export upload request.' })
        return
    end

    exportUploads[uploadId] = {
        startedAt = GetGameTimer(),
        totalChunks = totalChunks,
        received = 0,
        chunks = {},
        meta = data.meta or {}
    }

    callback({ ok = true, pending = true })
end)

RegisterNUICallback('exportChunk', function(data, callback)
    data = data or {}
    local uploadId = tostring(data.uploadId or ''):sub(1, 80)
    local upload = exportUploads[uploadId]

    if not upload then
        callback({ ok = false, message = 'Export upload was not started.' })
        return
    end

    local index = math.floor(tonumber(data.index) or -1)
    local chunk = tostring(data.chunk or '')

    if index < 0 or index >= upload.totalChunks or #chunk > 80000 then
        exportUploads[uploadId] = nil
        callback({ ok = false, message = 'Invalid export chunk. Upload cancelled.' })
        return
    end

    local slot = index + 1
    if upload.chunks[slot] == nil then
        upload.received = upload.received + 1
    end
    upload.chunks[slot] = chunk

    callback({ ok = true })
end)

RegisterNUICallback('exportFinish', function(data, callback)
    data = data or {}
    local uploadId = tostring(data.uploadId or ''):sub(1, 80)
    local upload = exportUploads[uploadId]

    if not upload then
        callback({ ok = false, message = 'Export upload was not found.' })
        return
    end

    if GetGameTimer() - upload.startedAt > 10 * 60 * 1000 then
        exportUploads[uploadId] = nil
        callback({ ok = false, message = 'Export upload expired. Try exporting again.' })
        return
    end

    if upload.received ~= upload.totalChunks then
        callback({ ok = false, message = ('Upload incomplete: received %d/%d chunks.'):format(upload.received, upload.totalChunks) })
        return
    end

    for index = 1, upload.totalChunks do
        if not upload.chunks[index] then
            callback({ ok = false, message = ('Upload chunk %d is missing.'):format(index - 1) })
            return
        end
    end

    TriggerLatentServerEvent(
        'cr-clothes:exportPayload',
        256000,
        {
            uploadId = uploadId,
            totalChunks = upload.totalChunks,
            chunks = upload.chunks,
            meta = upload.meta
        }
    )
    exportUploads[uploadId] = nil
    callback({ ok = true, pending = true })
end)

RegisterNUICallback('setTextureVariant', function(data, callback)
    local textureId = math.max(0, math.min(25, math.floor(tonumber(data.textureId) or 0)))

    if not activeGarment then
        callback({ ok = false, message = 'No active garment.' })
        return
    end

    if textureReady then
        removeTextureReplacements(activeGarment)
    end

    activeGarment.textureId = textureId
    for _, garment in ipairs(generatedSlots) do
        if garment.id == activeGarment.id then
            garment.textureId = textureId
            break
        end
    end

    local equipped, message = wearProofGarment()
    callback({ ok = equipped, message = message, textureId = textureId })
end)

local function switchToGarment(garment)
    if not garment then
        return false, 'Selected GTA garment was not found.'
    end

    if textureReady and activeGarment then
        removeTextureReplacements(activeGarment)
    end

    activeGarment = garment
    resolvedCollection = nil

    local requiredModel = joaat(activeGarment.requiredPedModel)
    if GetEntityModel(PlayerPedId()) ~= requiredModel then
        RequestModel(requiredModel)
        local timeout = GetGameTimer() + 10000
        while not HasModelLoaded(requiredModel) and GetGameTimer() < timeout do
            Wait(0)
        end

        if not HasModelLoaded(requiredModel) then
            return false, ('Could not load %s.'):format(activeGarment.requiredPedModel)
        end

        SetPlayerModel(PlayerId(), requiredModel)
        SetModelAsNoLongerNeeded(requiredModel)
        SetPedDefaultComponentVariation(PlayerPedId())
    end

    applyTextureReplacement()
    local equipped, equipMessage = wearProofGarment()
    if not equipped then
        return false, equipMessage or 'The selected GTA garment could not be equipped.'
    end

    return true, activeGarment.label or activeGarment.id
end

RegisterNUICallback('selectGarment', function(data, callback)
    local requestedId = tostring(data.id or '')
    local selected

    -- The editor uses the NUI WebGL OBJ renderer. Make sure no older scripted
    -- camera/browser preview remains active behind the designer pane.
    stopPreviewCamera()
    destroyBrowserPreview()

    -- Reload here too, which lets the editor pick up a freshly generated
    -- registry after a resource restart without relying on a fixed built-in slot.
    loadGeneratedSlots()
    for _, garment in ipairs(generatedSlots) do
        if garment.id == requestedId then
            selected = garment
            break
        end
    end

    local ok, message = switchToGarment(selected)
    callback({
        ok = ok,
        message = message,
        activeGarmentId = ok and activeGarment.id or nil
    })
end)

RegisterNUICallback('wear', function(_, callback)
    callback({ ok = wearProofGarment() })
end)

RegisterNUICallback('rotatePed', function(data, callback)
    local direction = tonumber(data.direction) or 0
    local ped = PlayerPedId()
    SetEntityHeading(ped, GetEntityHeading(ped) + (direction * 15.0))
    callback({ ok = true })
end)

RegisterNUICallback('openGarmentBrowser', function(_, callback)
    loadGeneratedSlots()
    destroyBrowserPreview()
    callback({
        ok = true,
        garments = generatedSlots,
        activeGarmentId = activeGarment and activeGarment.id or nil
    })
end)

RegisterNUICallback('builderPreviewGarment', function(data, callback)
    local item = data.item
    if type(item) ~= 'table' then callback({ ok = false }); return end
    if not browserPed or not DoesEntityExist(browserPed) or GetEntityModel(browserPed) ~= joaat(item.gender == 'male' and 'mp_m_freemode_01' or 'mp_f_freemode_01') then
        createBrowserPed(item.gender)
    end
    local textureId = math.max(0, math.floor(tonumber(data.textureId) or 0))
    if item.kind == 'prop' then
        ClearPedProp(browserPed, tonumber(item.propId) or 0)
        SetPedCollectionPropIndex(browserPed, tonumber(item.propId) or 0, item.collection, tonumber(item.drawableId) or 0, textureId, true)
    else
        SetPedCollectionComponentVariation(browserPed, tonumber(item.componentId) or 11, item.collection, tonumber(item.drawableId) or 0, textureId, 0)
    end
    callback({ ok = true, textureCount = tonumber(item.textureCount) or 1, textureFile = textureFileForItem(item, textureId) })
end)

RegisterNUICallback('builderRotatePed', function(data, callback)
    if browserPed and DoesEntityExist(browserPed) then
        browserPedHeading = browserPedHeading + ((tonumber(data.direction) or 0) * 15.0)
        SetEntityHeading(browserPed, browserPedHeading)
    end
    callback({ ok = true })
end)

RegisterNUICallback('builderResetCamera', function(_, callback)
    browserPedHeading = 180.0
    if browserPed and DoesEntityExist(browserPed) then SetEntityHeading(browserPed, browserPedHeading) end
    resetBrowserCamera()
    callback({ ok = true })
end)

RegisterNUICallback('builderSaveSelections', function(data, callback)
    TriggerServerEvent('cr-clothes:builderSaveSelections', {
        selections = data.selections or {},
        slotCount = tonumber(data.slotCount) or 1,
        textureVariantCount = tonumber(data.textureVariantCount) or 20,
        collectionName = tostring(data.collectionName or 'cdauto')
    })
    callback({ ok = true, pending = true })
end)

RegisterNUICallback('builderExtractSelections', function(data, callback)
    TriggerServerEvent('cr-clothes:builderExtractSelections', {
        selections = data.selections or {},
        slotCount = tonumber(data.slotCount) or 1,
        textureVariantCount = tonumber(data.textureVariantCount) or 20,
        collectionName = tostring(data.collectionName or 'cdauto')
    })
    callback({ ok = true, pending = true })
end)

-- "Preview on server" hides the interface so the player can look at the design
-- on their own ped in the world, then press ESC (or BACKSPACE) to come back to
-- exactly where they left off. The design is already live on the ped via the
-- runtime texture, so this only has to get the UI out of the way.
local peeking = false

local function endPeek()
    if not peeking then return end
    peeking = false
    SetNuiFocus(true, true)
    SendNUIMessage({ action = 'endPeek' })
end

RegisterNUICallback('peekInWorld', function(_, callback)
    if not editorOpen then
        callback({ ok = false, message = 'The designer is not open.' })
        return
    end

    peeking = true
    SetNuiFocus(false, false)
    SendNUIMessage({ action = 'beginPeek' })

    CreateThread(function()
        while peeking do
            Wait(0)
            -- On-screen hint so the way back is never a mystery.
            SetTextFont(4)
            SetTextScale(0.42, 0.42)
            SetTextColour(235, 242, 255, 235)
            SetTextOutline()
            SetTextEntry('STRING')
            AddTextComponentString('Viewing your design  ~y~ESC~w~ or ~y~BACKSPACE~w~ to keep editing')
            DrawText(0.5 - 0.13, 0.93)

            -- 200 = ESC, 177 = BACKSPACE/cancel
            if IsControlJustPressed(0, 200) or IsControlJustPressed(0, 177) then
                endPeek()
            end
        end
    end)

    callback({ ok = true })
end)

RegisterNUICallback('close', function(_, callback)
    closeEditor()
    callback({ ok = true })
end)

RegisterNetEvent('cr-clothes:applyPublishedDesign', function(design, publisherName, revision)
    local clean = sanitizeDesign(design)

    if not clean then
        return
    end

    currentDesign = clean
    sendDesignToRenderer(currentDesign)
    applyTextureReplacement()

    if publisherName then
        notify(('%s published shared design r%s.'):format(
            publisherName,
            tostring(revision or '?')
        ))
    end
end)

RegisterNetEvent('cr-clothes:publishResult', function(ok, message, revision)
    pendingPublish = false

    SendNUIMessage({
        action = 'publishResult',
        ok = ok == true,
        message = tostring(message or ''),
        revision = revision
    })

    notify(tostring(message or (ok and 'Design published.' or 'Publish failed.')))

    if ok then
        wearProofGarment()
        debugTextureUntil = GetGameTimer() + 5000

        SetTimeout(350, function()
            if editorOpen then
                closeEditor()
            end
        end)
    end
end)

RegisterNetEvent('cr-clothes:exportResult', function(payload)
    if payload and payload.ok == true then
        loadGeneratedSlots()
    end

    SendNUIMessage({
        action = 'exportResult',
        ok = payload and payload.ok == true,
        message = payload and payload.message or 'Export failed.',
        restartRequired = payload and payload.restartRequired == true,
        sidecarPath = payload and payload.sidecarPath,
        bakedTextureFile = payload and payload.bakedTextureFile,
        bakedTextureIndex = payload and payload.bakedTextureIndex,
        bakedSlotId = payload and payload.bakedSlotId,
        registry = payload and payload.registry
    })

    notify(payload and payload.message or 'Export failed.')
end)

RegisterNetEvent('cr-clothes:builderOpen', function(payload)
    openBuilder(payload or {})
end)

RegisterNetEvent('cr-clothes:builderResult', function(payload)
    if payload and payload.ok == true then
        loadGeneratedSlots()
    end

    SendNUIMessage({
        action = 'builderResult',
        ok = payload and payload.ok == true,
        message = payload and payload.message or 'Builder failed.',
        restartRequired = payload and payload.restartRequired == true,
        catalog = payload and payload.catalog,
        registry = payload and payload.registry
    })

    notify(payload and payload.message or 'Builder failed.')
end)

CreateThread(function()
    loadGeneratedSlots()
    initializeRuntimeTexture()
end)

CreateThread(function()
    while true do
        local showingDebugTexture = textureReady and GetGameTimer() < debugTextureUntil

        if showingDebugTexture then
            DrawRect(0.85, 0.5, 0.23, 0.43, 4, 7, 12, 225)
            DrawSprite(
                Config.RuntimeTextureDictionary,
                Config.RuntimeTextureName,
                0.85,
                0.5,
                0.2,
                0.355,
                0.0,
                255,
                255,
                255,
                255
            )
        end

        if editorOpen then
            DisableControlAction(0, 21, true)
            DisableControlAction(0, 22, true)
            DisableControlAction(0, 1, true)
            DisableControlAction(0, 2, true)
            DisableControlAction(0, 24, true)
            DisableControlAction(0, 25, true)
            DisableControlAction(0, 30, true)
            DisableControlAction(0, 31, true)
            DisableControlAction(0, 36, true)
            DisableControlAction(0, 200, true)
            Wait(0)
        elseif showingDebugTexture then
            Wait(0)
        else
            Wait(500)
        end
    end
end)

AddEventHandler('onResourceStop', function(stoppedResource)
    if stoppedResource ~= resourceName then
        return
    end

    SetNuiFocus(false, false)
    stopPreviewCamera()

    if duiObject then
        removeTextureReplacements(activeGarment)
        DestroyDui(duiObject)
    end
end)
