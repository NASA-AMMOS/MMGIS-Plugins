"use strict";

const MAX_HISTORY_ITEMS = 16;
const MAX_HISTORY_TEXT = 1400;
const MAX_TOOL_NAMES = 48;

function text(value, max = 240) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function finite(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) &&
    number >= minimum &&
    number <= maximum
    ? number
    : undefined;
}

function coordinatePair(value) {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const lon = finite(value[0], -180, 180);
  const lat = finite(value[1], -90, 90);
  return lon === undefined || lat === undefined ? undefined : [lon, lat];
}

function bounds(value) {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const values = [
    finite(value[0], -180, 180),
    finite(value[1], -90, 90),
    finite(value[2], -180, 180),
    finite(value[3], -90, 90),
  ];
  return values.every((entry) => entry !== undefined) &&
    values[0] < values[2] &&
    values[1] < values[3]
    ? values
    : undefined;
}

function spatialExtent(value) {
  if (Array.isArray(value)) {
    const bbox = bounds(value);
    return bbox ? { bbox } : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const bbox = bounds(value.bbox || value.bounds || value.extent);
  if (!bbox) return undefined;
  const name = text(value.name || value.label || value.title, 160);
  return {
    ...(name ? { name } : {}),
    bbox,
  };
}

function sanitizeConversationHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  const history = [];
  for (const raw of rawHistory.slice(-MAX_HISTORY_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const role =
      raw.role === "user" || raw.role === "assistant" ? raw.role : null;
    const message = text(
      raw.text || raw.message ||
        (typeof raw.content === "string" ? raw.content : ""),
      MAX_HISTORY_TEXT,
    );
    if (role && message) history.push({ role, text: message });
  }
  return history;
}

function sanitizeToolNames(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) =>
          text(
            typeof entry === "string"
              ? entry
              : entry?.name || entry?.id || "",
            80,
          ),
        )
        .filter((entry) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(entry)),
    ),
  ).slice(0, MAX_TOOL_NAMES);
}

function sanitizeRuntimeContext(rawContext = {}, rawHistory) {
  const context =
    rawContext && typeof rawContext === "object" ? rawContext : {};
  const mapSource =
    context.map && typeof context.map === "object"
      ? context.map
      : context.view && typeof context.view === "object"
        ? context.view
        : context;
  const center = coordinatePair(
    mapSource.center || mapSource.mapCenter || context.center,
  );
  const currentBounds = bounds(
    mapSource.bounds || mapSource.bbox || context.bounds || context.bbox,
  );
  const zoom = finite(
    mapSource.zoom ?? mapSource.zoomLevel ?? context.zoom,
    0,
    30,
  );
  const homeSource =
    mapSource.home && typeof mapSource.home === "object"
      ? mapSource.home
      : context.home && typeof context.home === "object"
        ? context.home
        : null;
  const home = homeSource
    ? {
        center: coordinatePair(homeSource.center),
        bounds: bounds(homeSource.bounds || homeSource.bbox),
        zoom: finite(homeSource.zoom, 0, 30),
      }
    : null;
  // AOI/selection extents are intentionally separate from map.bounds. A
  // viewport is not evidence that the user created or selected an AOI.
  const areaOfInterest = spatialExtent(
    context.areaOfInterest ||
      context.area_of_interest ||
      context.aoi ||
      mapSource.areaOfInterest ||
      mapSource.aoi,
  );
  const selectionExtent = spatialExtent(
    context.selectionExtent ||
      context.selection_extent ||
      context.selectedArea ||
      context.selection,
  );

  const timeSource =
    context.time && typeof context.time === "object"
      ? context.time
      : context.temporal && typeof context.temporal === "object"
        ? context.temporal
        : null;
  const temporal = timeSource
    ? {
        current: text(
          timeSource.current || timeSource.value || timeSource.currentTime,
          100,
        ) || undefined,
        start: text(timeSource.start || timeSource.min, 100) || undefined,
        end: text(timeSource.end || timeSource.max, 100) || undefined,
        playing:
          typeof timeSource.playing === "boolean"
            ? timeSource.playing
            : undefined,
        direction: text(timeSource.direction, 20) || undefined,
        step: text(timeSource.step || timeSource.interval, 60) || undefined,
      }
    : null;

  const activeLayerSource =
    context.activeLayer || context.active_layer || context.selectedLayer;
  const activeLayer =
    typeof activeLayerSource === "string"
      ? { name: text(activeLayerSource, 256) }
      : activeLayerSource && typeof activeLayerSource === "object"
        ? {
            name: text(
              activeLayerSource.name || activeLayerSource.display_name,
              256,
            ),
            type: text(activeLayerSource.type, 80) || undefined,
            visible:
              typeof activeLayerSource.visible === "boolean"
                ? activeLayerSource.visible
                : undefined,
          }
        : null;

  const featureSource =
    context.selectedFeature || context.activeFeature || context.feature;
  const feature =
    featureSource && typeof featureSource === "object"
      ? {
          layer: text(
            featureSource.layer || featureSource.layerName,
            256,
          ) || undefined,
          id: text(String(featureSource.id ?? ""), 120) || undefined,
          summary: text(
            featureSource.summary || featureSource.label,
            500,
          ) || undefined,
        }
      : null;

  const loadedTools = sanitizeToolNames(
    context.loadedTools || context.loaded_tools || context.availableTools,
  );
  const activeTools = sanitizeToolNames(
    context.activeTools || context.active_tools,
  );
  const history = sanitizeConversationHistory(
    rawHistory || context.history || context.messages,
  );

  return {
    history,
    runtime: {
      map: {
        center,
        bounds: currentBounds,
        zoom,
        home:
          home && Object.values(home).some((value) => value !== undefined)
            ? home
            : undefined,
      },
      temporal:
        temporal &&
        Object.values(temporal).some((value) => value !== undefined)
          ? temporal
          : undefined,
      activeLayer:
        activeLayer?.name ? activeLayer : undefined,
      selectedFeature:
        feature && Object.values(feature).some((value) => value !== undefined)
          ? feature
          : undefined,
      areaOfInterest,
      selectionExtent,
      loadedTools,
      activeTools,
    },
  };
}

module.exports = {
  MAX_HISTORY_ITEMS,
  sanitizeConversationHistory,
  sanitizeRuntimeContext,
  spatialExtent,
};
