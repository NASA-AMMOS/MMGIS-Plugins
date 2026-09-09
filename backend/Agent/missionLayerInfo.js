"use strict";

const fs = require("fs");
const path = require("path");
const Utils = require(path.join(process.cwd(), "API/utils"));

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_SIZE = 32;

function sanitizeMissionName(value) {
  if (typeof value !== "string") return "";
  const mission = value.trim();
  if (!mission || mission.length > 128) return "";
  const sanitized = Utils.forceAlphaNumUnder(mission, ["-"]);
  return sanitized === mission ? mission : "";
}

function resolveMissionPath(missionsRoot, mission) {
  const safeMission = sanitizeMissionName(mission);
  if (!safeMission) return null;
  const root = path.resolve(missionsRoot);
  const candidate = path.resolve(root, safeMission);
  if (candidate === root || !candidate.startsWith(root + path.sep)) return null;
  return candidate;
}

function setBoundedCache(cache, key, value, maxEntries) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function createLayerInfoMiddleware({
  loadDynamic,
  loadStatic,
  missionsRoot = path.join(process.cwd(), "Missions"),
  mainMission = process.env.MAIN_MISSION || "",
  mainLayerInfoPath = null,
  cache = new Map(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxCacheEntries = DEFAULT_CACHE_SIZE,
  now = () => Date.now(),
} = {}) {
  return function agentLayerInfo(req, res, next) {
    const rawMission =
      req.query?.mission || req.body?.mission || mainMission || "";
    const mission = sanitizeMissionName(rawMission);
    if (!mission) {
      res.status(400).json({
        error: "A valid mission query parameter is required.",
        code: "InvalidMission",
      });
      return;
    }

    const cached = cache.get(mission);
    let store =
      cached && now() - cached.cachedAt <= cacheTtlMs
        ? cached.store
        : null;
    if (!store) {
      const missionPath = resolveMissionPath(missionsRoot, mission);
      if (missionPath && fs.existsSync(missionPath)) {
        store = loadDynamic(missionPath);
      } else if (
        mission === mainMission &&
        mainLayerInfoPath &&
        fs.existsSync(mainLayerInfoPath)
      ) {
        store = loadStatic(mainLayerInfoPath);
      } else {
        store = {
          items: [],
          index: [],
          loadedAt: new Date(now()).toISOString(),
        };
      }
      setBoundedCache(
        cache,
        mission,
        { store, cachedAt: now() },
        maxCacheEntries,
      );
    }
    req.agentLayerInfo = store;
    next();
  };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_SIZE,
  sanitizeMissionName,
  resolveMissionPath,
  setBoundedCache,
  createLayerInfoMiddleware,
};
