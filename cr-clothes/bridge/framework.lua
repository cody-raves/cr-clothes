-- bridge/framework.lua
-- Framework adapter: turns a player into the "subjects" that may hold design
-- grants -- their job and their gang -- so grants.lua stays framework-agnostic.
--
-- Supported out of the box: qbx_core (Qbox), qb-core, es_extended. Anything
-- else falls back to standalone (player + ACE grants only). To support a
-- different framework, edit GetDesignSubjects below -- it is the only function
-- that needs to know what a "job" means on your server.

Bridge = Bridge or {}

local framework = 'standalone'

local function detect()
    if GetResourceState('qbx_core') == 'started' then return 'qbx' end
    if GetResourceState('qb-core') == 'started' then return 'qb' end
    if GetResourceState('es_extended') == 'started' then return 'esx' end
    return 'standalone'
end

-- Returns e.g. { 'job:police', 'gang:ballas' } for the given player.
-- Grade-gating (only bosses may design) is handled here too: set
-- Config.DesignRequiresBoss = true to restrict job/gang subjects to leaders.
function Bridge.GetDesignSubjects(source)
    local subjects = {}
    local requireBoss = Config and Config.DesignRequiresBoss == true

    local ok = pcall(function()
        if framework == 'qbx' or framework == 'qb' then
            local core = framework == 'qbx' and exports.qbx_core or exports['qb-core']:GetCoreObject()
            local player = framework == 'qbx' and core:GetPlayer(source) or core.Functions.GetPlayer(source)
            if not player then return end
            local data = player.PlayerData or {}

            if data.job and data.job.name then
                if not requireBoss or data.job.isboss or (data.job.grade and data.job.grade.level and data.job.grade.level >= 3) then
                    subjects[#subjects + 1] = ('job:%s'):format(data.job.name)
                end
            end
            if data.gang and data.gang.name then
                if not requireBoss or data.gang.isboss or (data.gang.grade and data.gang.grade.level and data.gang.grade.level >= 3) then
                    subjects[#subjects + 1] = ('gang:%s'):format(data.gang.name)
                end
            end
        elseif framework == 'esx' then
            local esx = exports['es_extended']:getSharedObject()
            local player = esx and esx.GetPlayerFromId(source)
            if not player then return end
            local job = player.getJob and player.getJob()
            if job and job.name then
                if not requireBoss or (job.grade and job.grade >= 3) then
                    subjects[#subjects + 1] = ('job:%s'):format(job.name)
                end
            end
        end
    end)

    if not ok then
        -- A framework hiccup must never block admin/player grants.
        return subjects
    end
    return subjects
end

-- Which framework was detected ('qbx' | 'qb' | 'esx' | 'standalone').
function Bridge.GetFramework()
    return framework
end

AddEventHandler('onResourceStart', function(resource)
    if resource ~= GetCurrentResourceName() then return end
    framework = detect()
    if GetConvar('clothdesigner_debug', 'false') == 'true' then print(('[cr-clothes:bridge] framework: %s'):format(framework)) end
end)
