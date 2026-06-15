const db = require("@saltcorn/data/db");

const ewkbToWKT = (hex) => {
  if (!hex || hex.length < 10 || !/^[0-9A-Fa-f]+$/i.test(hex)) return null;
  try {
    const buf = Buffer.from(hex, "hex");
    let p = 0;
    function readGeom() {
      const le = buf[p++] === 1;
      const ru = () => {
        const v = le ? buf.readUInt32LE(p) : buf.readUInt32BE(p);
        p += 4;
        return v;
      };
      const rd = () => {
        const v = le ? buf.readDoubleLE(p) : buf.readDoubleBE(p);
        p += 8;
        return v;
      };
      const typeVal = ru();
      const hasZ = !!(typeVal & 0x80000000);
      const hasSRID = !!(typeVal & 0x20000000);
      const gt = typeVal & 0xff;
      if (hasSRID) ru();
      const xy = () => {
        const x = rd(),
          y = rd();
        if (hasZ) rd();
        return `${x} ${y}`;
      };
      const ring = () => {
        const n = ru();
        return `(${Array.from({ length: n }, xy).join(", ")})`;
      };
      const poly = () => {
        const n = ru();
        return `(${Array.from({ length: n }, ring).join(", ")})`;
      };
      const subs = (n) => Array.from({ length: n }, readGeom);
      if (gt === 1) return `POINT(${xy()})`;
      if (gt === 2) {
        const n = ru();
        return `LINESTRING(${Array.from({ length: n }, xy).join(", ")})`;
      }
      if (gt === 3) return `POLYGON${poly()}`;
      if (gt === 4) {
        const gs = subs(ru());
        return `MULTIPOINT(${gs.map((g) => (g ? g.replace(/^POINT/, "") : "(0 0)")).join(", ")})`;
      }
      if (gt === 5) {
        const gs = subs(ru());
        return `MULTILINESTRING(${gs.map((g) => (g ? g.replace(/^LINESTRING/, "") : "()")).join(", ")})`;
      }
      if (gt === 6) {
        const gs = subs(ru());
        return `MULTIPOLYGON(${gs.map((g) => (g ? g.replace(/^POLYGON/, "") : "(())")).join(", ")})`;
      }
      if (gt === 7) {
        const gs = subs(ru());
        return `GEOMETRYCOLLECTION(${gs.filter(Boolean).join(", ")})`;
      }
      return null;
    }
    return readGeom();
  } catch (e) {
    return null;
  }
};

const parseCoordPairs = (s) =>
  s
    .trim()
    .split(",")
    .map((pair) => pair.trim().split(/\s+/).map(Number));

// Split a string by top-level commas (ignoring commas inside parentheses).
const splitTopLevel = (s) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts;
};

// Extract all `(coord pairs)` groups from a string (non-nested).
const extractRings = (s) => {
  const rings = [];
  const re = /\(([^()]+)\)/g;
  let m;
  while ((m = re.exec(s)) !== null) rings.push(parseCoordPairs(m[1]));
  return rings;
};

const wktToGeoJSON = (wkt) => {
  if (!wkt) return null;
  const s = wkt.trim();
  let m;

  m = s.match(
    /^POINT\s*\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)(?:\s+[-\d.eE+]+)?\s*\)$/i,
  );
  if (m) return { type: "Point", coordinates: [+m[1], +m[2]] };

  m = s.match(/^LINESTRING\s*\(([^)]+)\)$/i);
  if (m) return { type: "LineString", coordinates: parseCoordPairs(m[1]) };

  m = s.match(/^POLYGON\s*\(([\s\S]+)\)$/i);
  if (m) return { type: "Polygon", coordinates: extractRings(m[1]) };

  m = s.match(/^MULTIPOINT\s*\(([\s\S]+)\)$/i);
  if (m) {
    const inner = m[1].replace(/[()]/g, "");
    return { type: "MultiPoint", coordinates: parseCoordPairs(inner) };
  }

  m = s.match(/^MULTILINESTRING\s*\(([\s\S]+)\)$/i);
  if (m) return { type: "MultiLineString", coordinates: extractRings(m[1]) };

  m = s.match(/^MULTIPOLYGON\s*\(([\s\S]+)\)$/i);
  if (m) {
    const polygons = splitTopLevel(m[1]).map((polyStr) =>
      extractRings(polyStr.trim().slice(1, -1)),
    );
    return { type: "MultiPolygon", coordinates: polygons };
  }

  return null;
};

const fetchGeoJSON = async (table, geomField, rowIds) => {
  if (!rowIds || rowIds.length === 0) return {};
  const pk = table.pk_name || "id";
  try {
    const placeholders = rowIds.map((_, i) => `$${i + 1}`).join(", ");
    const res = await db.query(
      `SELECT "${pk}", "${geomField}" AS __geom
       FROM "${table.name}"
       WHERE "${pk}" IN (${placeholders})`,
      rowIds,
    );
    const result = {};
    for (const r of res.rows || []) {
      if (r.__geom == null) continue;
      const raw = String(r.__geom).trim();
      const wkt = /^(POINT|LINESTRING|POLYGON|MULTI|GEOMETRYCOLLECTION)/i.test(
        raw,
      )
        ? raw
        : ewkbToWKT(raw);
      if (!wkt) continue;
      const geojson = wktToGeoJSON(wkt);
      if (geojson?.type) result[r[pk]] = geojson;
    }
    return result;
  } catch (e) {
    console.error("fetchGeoJSON error:", e.message);
    return {};
  }
};

const extractPointCoords = (geom) => {
  try {
    const g = typeof geom === "string" ? JSON.parse(geom) : geom;
    if (!g) return null;
    let coord;
    switch (g.type) {
      case "Point":
        coord = g.coordinates;
        break;
      case "LineString":
      case "MultiPoint":
        coord = g.coordinates[0];
        break;
      case "Polygon":
      case "MultiLineString":
        coord = g.coordinates[0][0];
        break;
      case "MultiPolygon":
        coord = g.coordinates[0][0][0];
        break;
      default:
        return null;
    }
    if (Array.isArray(coord) && coord.length >= 2) return [coord[1], coord[0]];
  } catch {}
  return null;
};

const radiusFilter = async (
  table,
  geomField,
  latField,
  lngField,
  rows,
  refLat,
  refLng,
  radiusKm,
) => {
  if (!rows.length) return rows;
  const pk = table.pk_name || "id";
  const radiusM = radiusKm * 1000;

  if (geomField) {
    try {
      const ids = rows.map((r) => r[pk]);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
      const res = await db.query(
        `SELECT "${pk}" FROM "${table.name}"
         WHERE "${pk}" IN (${placeholders})
           AND ST_DWithin(
             "${geomField}"::geography,
             ST_SetSRID(ST_MakePoint($${ids.length + 1}, $${ids.length + 2}), 4326)::geography,
             $${ids.length + 3}
           )`,
        [...ids, refLng, refLat, radiusM],
      );
      const kept = new Set(res.rows.map((r) => r[pk]));
      return rows.filter((r) => kept.has(r[pk]));
    } catch (e) {
      console.error("radiusFilter ST_DWithin error:", e.message);
      return rows;
    }
  }

  if (latField && lngField) {
    const dLat = radiusKm / 111.32;
    const dLng = radiusKm / (111.32 * Math.cos((refLat * Math.PI) / 180));
    return rows.filter((row) => {
      const lat = parseFloat(row[latField]);
      const lng = parseFloat(row[lngField]);
      return (
        !isNaN(lat) &&
        !isNaN(lng) &&
        lat >= refLat - dLat &&
        lat <= refLat + dLat &&
        lng >= refLng - dLng &&
        lng <= refLng + dLng
      );
    });
  }

  return rows;
};

const bboxFilter = async (
  table,
  geomField,
  latField,
  lngField,
  rows,
  swLat,
  swLng,
  neLat,
  neLng,
) => {
  if (!rows.length) return rows;
  const pk = table.pk_name || "id";

  if (geomField) {
    try {
      const ids = rows.map((r) => r[pk]);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
      const res = await db.query(
        `SELECT "${pk}" FROM "${table.name}"
         WHERE "${pk}" IN (${placeholders})
           AND ST_Intersects(
             "${geomField}"::geometry,
             ST_MakeEnvelope($${ids.length + 1}, $${ids.length + 2}, $${ids.length + 3}, $${ids.length + 4}, 4326)
           )`,
        [...ids, swLng, swLat, neLng, neLat],
      );
      const kept = new Set(res.rows.map((r) => r[pk]));
      return rows.filter((r) => kept.has(r[pk]));
    } catch (e) {
      console.error("bboxFilter ST_Intersects error:", e.message);
      return rows;
    }
  }

  if (latField && lngField) {
    return rows.filter((row) => {
      const lat = parseFloat(row[latField]);
      const lng = parseFloat(row[lngField]);
      return (
        !isNaN(lat) &&
        !isNaN(lng) &&
        lat >= swLat &&
        lat <= neLat &&
        lng >= swLng &&
        lng <= neLng
      );
    });
  }

  return rows;
};

module.exports = {
  wktToGeoJSON,
  ewkbToWKT,
  fetchGeoJSON,
  extractPointCoords,
  radiusFilter,
  bboxFilter,
};
