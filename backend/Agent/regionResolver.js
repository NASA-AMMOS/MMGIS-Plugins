const TerraformerWKT = require("@terraformer/wkt");
const { normalizeName, scoreCandidate } = require("./utils/text");

const MARINE_REGIONS_SEARCH =
  "https://www.marineregions.org/rest/getGazetteerRecordsByNamesJSON.php";
const MARINE_REGIONS_POLYGON =
  "https://www.marineregions.org/rest/getGazetteerPolygonsByMRGID.php";

const REGION_CACHE = new Map();
const DEFAULT_NEAR_BUFFER_KM = 250;

const SPECIAL_REGIONS = {
  "northern hemisphere": {
    label: "Northern Hemisphere",
    bbox: [-180, 0, 180, 90],
    source: "Computed hemisphere extent",
  },
  "southern hemisphere": {
    label: "Southern Hemisphere",
    bbox: [-180, -90, 180, 0],
    source: "Computed hemisphere extent",
  },
  "eastern hemisphere": {
    label: "Eastern Hemisphere",
    bbox: [0, -90, 180, 90],
    source: "Computed hemisphere extent",
  },
  "western hemisphere": {
    label: "Western Hemisphere",
    bbox: [-180, -90, 0, 90],
    source: "Computed hemisphere extent",
  },
  "arctic circle": {
    label: "Arctic Circle",
    bbox: [-180, 66.5622, 180, 90],
    source: "Defined latitude 66°33′48″ N",
  },
  "antarctic circle": {
    label: "Antarctic Circle",
    bbox: [-180, -90, 180, -66.5622],
    source: "Defined latitude 66°33′48″ S",
  },
};

function clampLatitude(value) {
  if (!Number.isFinite(value)) return value;
  if (value > 90) return 90;
  if (value < -90) return -90;
  return value;
}

function normalizeLongitude(value) {
  if (!Number.isFinite(value)) return value;
  let lon = value;
  while (lon > 180) lon -= 360;
  while (lon < -180) lon += 360;
  return lon;
}

function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [minLonRaw, minLatRaw, maxLonRaw, maxLatRaw] = bbox.map((value) =>
    Number(value),
  );
  if (
    [minLonRaw, minLatRaw, maxLonRaw, maxLatRaw].some(
      (value) => Number.isNaN(value) || !Number.isFinite(value),
    )
  ) {
    return null;
  }
  const minLat = clampLatitude(minLatRaw);
  const maxLat = clampLatitude(maxLatRaw);
  let minLon = normalizeLongitude(minLonRaw);
  let maxLon = normalizeLongitude(maxLonRaw);
  if (maxLon - minLon >= 360) {
    minLon = -180;
    maxLon = 180;
  }
  if (minLon <= maxLon) {
    return {
      primary: [minLon, minLat, maxLon, maxLat],
      parts: [[minLon, minLat, maxLon, maxLat]],
      crossesDateline: false,
    };
  }
  // Dateline crossing: split into two parts.
  const partA = [minLon, minLat, 180, maxLat];
  const partB = [-180, minLat, maxLon, maxLat];
  return {
    primary: partA,
    parts: [partA, partB],
    crossesDateline: true,
  };
}

function expandBbox(bbox, bufferKm) {
  if (!bufferKm || bufferKm <= 0 || !Array.isArray(bbox) || bbox.length !== 4) {
    return bbox;
  }
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const latDelta = bufferKm / 111;
  const avgLat = clampLatitude((minLat + maxLat) / 2);
  const lonScale = Math.cos((avgLat * Math.PI) / 180);
  const safeScale = Math.max(Math.abs(lonScale), 0.15);
  const lonDelta = bufferKm / (111 * safeScale);
  return [
    minLon - lonDelta,
    minLat - latDelta,
    maxLon + lonDelta,
    maxLat + latDelta,
  ];
}

function geometryCoordinateCount(geometry) {
  if (!geometry) return 0;
  const { type, coordinates } = geometry;
  if (!type || !coordinates) return 0;
  const stack = [coordinates];
  let count = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (typeof node[0] === "number") {
      count += 1;
    } else if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
    }
    if (count > 16000) break;
  }
  return count;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(options.timeout || 10000),
    headers: options.headers || {},
  });
  if (!res.ok) {
    const err = new Error(`Request failed (${res.status}) for ${url}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function lookupMarineRegions(name) {
  const url = `${MARINE_REGIONS_SEARCH}?name=${encodeURIComponent(name)}`;
  const payload = await fetchJson(url);
  if (!Array.isArray(payload) || !payload.length) return null;

  const normalized = normalizeName(name);
  let best = null;
  let bestScore = 0;
  for (const entry of payload) {
    const label =
      entry?.preferredGazetteerName ||
      entry?.preferredGazetteerNameLang ||
      entry?.preferred ||
      entry?.name;
    if (!label) continue;
    const score = scoreCandidate(normalized, label);
    if (score > bestScore) {
      const minLat =
        Number(entry.minLatitude ?? entry.minlat ?? entry.min_latitude) ??
        null;
      const maxLat =
        Number(entry.maxLatitude ?? entry.maxlat ?? entry.max_latitude) ??
        null;
      const minLon =
        Number(entry.minLongitude ?? entry.minlon ?? entry.min_longitude) ??
        null;
      const maxLon =
        Number(entry.maxLongitude ?? entry.maxlon ?? entry.max_longitude) ??
        null;
      if (
        [minLat, maxLat, minLon, maxLon].every(
          (value) => typeof value === "number" && Number.isFinite(value),
        )
      ) {
        bestScore = score;
        best = {
          label,
          bbox: [minLon, minLat, maxLon, maxLat],
          mrgid: entry.MRGID || entry.mrgid || entry.id || null,
          source: "MarineRegions.org",
          sourceUrl: entry?.MRGID
            ? `https://www.marineregions.org/gazetteer.php?p=details&id=${entry.MRGID}`
            : "https://www.marineregions.org/",
        };
      }
    }
  }
  return best;
}

function parseWktGeometry(wkt) {
  if (!wkt || typeof wkt !== "string") return null;
  try {
    return TerraformerWKT.parse(wkt);
  } catch {
    return null;
  }
}

async function fetchMarinePolygon(mrgid) {
  if (!mrgid) return null;
  const url = `${MARINE_REGIONS_POLYGON}?mrgid=${encodeURIComponent(mrgid)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    const wkt = entry?.polygon || entry?.wkt || entry?.geom;
    if (typeof wkt === "string") return parseWktGeometry(wkt);
    return null;
  } catch {
    return parseWktGeometry(text);
  }
}

function parseRegionQuery(raw) {
  const original = String(raw || "").trim();
  if (!original) return null;
  let working = original;
  let bufferKm = null;
  const bufferMatch = working.match(
    /\((\d+(?:\.\d+)?)\s*(?:km|kilometers?)\)/i,
  );
  if (bufferMatch) {
    bufferKm = Number(bufferMatch[1]);
    working = working.replace(bufferMatch[0], "").trim();
  }
  let near = false;
  working = working.replace(
    /\b(near|around|surrounding|proximal to)\b/gi,
    () => {
      near = true;
      return " ";
    },
  );
  working = working.replace(/\s+/g, " ").trim();
  if (!working) working = original;
  return {
    label: original,
    query: working,
    near,
    bufferKm: bufferKm || (near ? DEFAULT_NEAR_BUFFER_KM : null),
  };
}

function geometryToBbox(geometry) {
  if (!geometry || !geometry.type) return null;
  const coords = [];
  const walker = (node) => {
    if (!node) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      coords.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child) => walker(child));
    }
  };
  if (geometry.type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    geometry.geometries.forEach((geom) => walker(geom.coordinates));
  } else {
    walker(geometry.coordinates);
  }
  if (!coords.length) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  coords.forEach(([lon, lat]) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  });
  if (minLon === Infinity) return null;
  return [minLon, minLat, maxLon, maxLat];
}

async function resolveRegion(raw, options = {}) {
  const parsed = parseRegionQuery(raw);
  if (!parsed) return null;
  const key = JSON.stringify({ q: parsed.query, buffer: parsed.bufferKm });
  if (REGION_CACHE.has(key)) {
    return REGION_CACHE.get(key);
  }

  const normalized = normalizeName(parsed.query);
  if (SPECIAL_REGIONS[normalized]) {
    const preset = SPECIAL_REGIONS[normalized];
    const bboxWithBuffer = expandBbox(
      preset.bbox,
      options.bufferKm ?? parsed.bufferKm,
    );
    const normalizedBbox = normalizeBbox(bboxWithBuffer);
    const response = {
      label: preset.label,
      bbox: normalizedBbox?.primary || preset.bbox,
      bboxParts: normalizedBbox?.parts || [preset.bbox],
      sourceDomain: preset.source,
      geometryType: "bbox",
      bufferKm: options.bufferKm ?? parsed.bufferKm,
      method: "preset",
    };
    REGION_CACHE.set(key, response);
    return response;
  }

  let resolved = null;
  try {
    resolved = await lookupMarineRegions(parsed.query);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("MarineRegions lookup failed:", error?.message || error);
  }
  if (!resolved) {
    return null;
  }

  let geometry = null;
  try {
    geometry = await fetchMarinePolygon(resolved.mrgid);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("Polygon fetch failed:", error?.message || error);
  }
  const geometryBbox = geometryToBbox(geometry);
  const bboxSource = geometryBbox || resolved.bbox;
  const buffered = expandBbox(
    bboxSource,
    options.bufferKm ?? parsed.bufferKm,
  );
  const normalizedBbox = normalizeBbox(buffered || bboxSource);

  const usableGeometry =
    geometry && geometryCoordinateCount(geometry) <= 16000 ? geometry : null;

  const response = {
    label: resolved.label || parsed.query,
    bbox: normalizedBbox?.primary || resolved.bbox,
    bboxParts: normalizedBbox?.parts || [resolved.bbox],
    sourceDomain: resolved.source,
    sourceUrl: resolved.sourceUrl,
    geometry: usableGeometry,
    geometryType: usableGeometry ? usableGeometry.type : "bbox",
    method: usableGeometry ? "polygon" : "bbox",
    bufferKm: options.bufferKm ?? parsed.bufferKm,
  };
  REGION_CACHE.set(key, response);
  return response;
}

module.exports = {
  resolveRegion,
};
