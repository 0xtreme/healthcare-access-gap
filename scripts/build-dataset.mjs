import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import shapefile from 'shapefile';
import { simplify } from '@turf/simplify';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const RAW_DIR = path.join(projectRoot, 'data', 'raw');
const PROCESSED_DIR = path.join(projectRoot, 'data', 'processed');
const PUBLIC_DATA_DIR = path.join(projectRoot, 'public', 'data');
const DOCS_DATA_DIR = path.join(projectRoot, 'docs', 'data');
const TMP_DIR = path.join(projectRoot, '.tmp', 'build');

const RAW_FILES = {
  gpcZip: path.join(RAW_DIR, 'gpc_2023.zip'),
  dpaZip: path.join(RAW_DIR, 'dpa_gps_2025a.zip'),
  censusG02: path.join(RAW_DIR, 'census_2021_g02_sa2.csv'),
  erp: path.join(RAW_DIR, 'annual_erp_asgs2021.csv'),
  seifa: path.join(RAW_DIR, 'seifa_2021_sa2.csv'),
  sa2Boundaries: path.join(RAW_DIR, 'sa2_boundaries_2021.geojson'),
  sourceManifest: path.join(RAW_DIR, 'sources-manifest.json'),
};

const STATE_ORDER = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT', 'OT'];
const SIMPLIFY_TOLERANCE = 0.02;

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanText(value) {
  return (value ?? '').toString().replace(/\u00a0/g, ' ').trim();
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields;
}

function parseNumber(value) {
  const text = cleanText(value)
    .replace(/,/g, '')
    .replace(/\s+/g, '');

  if (!text) {
    return null;
  }

  const lowered = text.toLowerCase();
  if (['na', 'n/a', 'np', '..', '-', '--'].includes(lowered)) {
    return null;
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCode(value) {
  const text = cleanText(value);
  if (!text) {
    return null;
  }
  if (/^\d+$/.test(text)) {
    return text;
  }
  const asNumber = Number(text);
  if (Number.isFinite(asNumber)) {
    return Math.round(asNumber).toString();
  }
  return text;
}

function normalizeName(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|region|catchment|district|zone)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function percentileFromSorted(value, sortedArray) {
  if (!Number.isFinite(value) || !sortedArray.length) {
    return 0.5;
  }

  let low = 0;
  let high = sortedArray.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (sortedArray[mid] <= value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  if (sortedArray.length === 1) {
    return 1;
  }

  return (low - 1) / (sortedArray.length - 1);
}

function roundNum(value, digits = 4) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function forEachCsvRow(filePath, onRow) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headers = null;
  for await (const rawLine of rl) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) {
      continue;
    }

    const columns = parseCsvLine(line);
    if (!headers) {
      headers = columns;
      continue;
    }

    const row = {};
    headers.forEach((header, index) => {
      row[header] = columns[index] ?? '';
    });

    // eslint-disable-next-line no-await-in-loop
    await onRow(row);
  }
}

function ensureExtracted(zipPath, targetDir) {
  ensureDirectory(targetDir);
  const cmd = `unzip -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(targetDir)} >/dev/null`;
  execSync(cmd, { stdio: 'inherit' });
}

function listFilesRecursive(baseDir) {
  const output = [];

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.forEach((entry) => {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        output.push(fullPath);
      }
    });
  }

  walk(baseDir);
  return output;
}

function findFirstFile(baseDir, extension) {
  const files = listFilesRecursive(baseDir);
  return files.find((filePath) => filePath.toLowerCase().endsWith(extension.toLowerCase())) ?? null;
}

function countCoordinates(coords) {
  if (!Array.isArray(coords)) {
    return 0;
  }

  if (typeof coords[0] === 'number') {
    return 1;
  }

  return coords.reduce((sum, item) => sum + countCoordinates(item), 0);
}

function roundCoordinates(coords, precision = 5) {
  if (!Array.isArray(coords)) {
    return coords;
  }

  if (typeof coords[0] === 'number') {
    return [roundNum(coords[0], precision), roundNum(coords[1], precision)];
  }

  return coords.map((item) => roundCoordinates(item, precision));
}

function getGeometryBBox(geometry) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function walk(coords) {
    if (!Array.isArray(coords)) {
      return;
    }

    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }

    coords.forEach(walk);
  }

  walk(geometry?.coordinates);
  if (!Number.isFinite(minX)) {
    return null;
  }

  return [minX, minY, maxX, maxY];
}

function pointInRing(point, ring) {
  const x = point[0];
  const y = point[1];
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInPolygon(point, polygonCoords) {
  if (!Array.isArray(polygonCoords) || !polygonCoords.length) {
    return false;
  }

  if (!pointInRing(point, polygonCoords[0])) {
    return false;
  }

  for (let i = 1; i < polygonCoords.length; i += 1) {
    if (pointInRing(point, polygonCoords[i])) {
      return false;
    }
  }

  return true;
}

function pointInGeometry(point, geometry) {
  if (!geometry) {
    return false;
  }

  if (geometry.type === 'Polygon') {
    return pointInPolygon(point, geometry.coordinates);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((coords) => pointInPolygon(point, coords));
  }

  return false;
}

function centroidFromGeometry(geometry) {
  if (!geometry) {
    return null;
  }

  let sumX = 0;
  let sumY = 0;
  let count = 0;

  function addPoints(coords) {
    if (!Array.isArray(coords)) {
      return;
    }

    if (typeof coords[0] === 'number') {
      sumX += coords[0];
      sumY += coords[1];
      count += 1;
      return;
    }

    coords.forEach(addPoints);
  }

  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates?.[0])) {
    addPoints(geometry.coordinates[0]);
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach((polygon) => {
      if (Array.isArray(polygon?.[0])) {
        addPoints(polygon[0]);
      }
    });
  }

  if (!count) {
    return null;
  }

  return [sumX / count, sumY / count];
}

function pointInBBox(point, bbox) {
  return point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3];
}

function squaredDistance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

async function readShapefileFeatures(shpPath) {
  const source = await shapefile.open(shpPath);
  const features = [];

  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const result = await source.read();
    if (result.done) {
      break;
    }

    features.push(result.value);
  }

  return features;
}

async function extractCensusG02() {
  const bySa2 = new Map();

  await forEachCsvRow(RAW_FILES.censusG02, async (row) => {
    if (row.REGION_TYPE !== 'SA2') {
      return;
    }

    const sa2Code = normalizeCode(row.REGION);
    const metricCode = cleanText(row.MEDAVG);
    const value = parseNumber(row.OBS_VALUE);

    if (!sa2Code || !/^\d{9}$/.test(sa2Code)) {
      return;
    }

    if (!bySa2.has(sa2Code)) {
      bySa2.set(sa2Code, {
        median_age: null,
        median_personal_income_weekly: null,
        median_family_income_weekly: null,
        median_household_income_weekly: null,
      });
    }

    const metrics = bySa2.get(sa2Code);
    if (metricCode === '1') {
      metrics.median_age = value;
    } else if (metricCode === '2') {
      metrics.median_personal_income_weekly = value;
    } else if (metricCode === '3') {
      metrics.median_family_income_weekly = value;
    } else if (metricCode === '4') {
      metrics.median_household_income_weekly = value;
    }
  });

  return bySa2;
}

async function extractErpSeries() {
  const erpBySa2 = new Map();
  let latestYear = null;

  await forEachCsvRow(RAW_FILES.erp, async (row) => {
    if (row.REGION_TYPE !== 'SA2' || row.MEASURE !== 'ERP' || row.FREQ !== 'A') {
      return;
    }

    const sa2Code = normalizeCode(row.ASGS_2021);
    const year = parseNumber(row.TIME_PERIOD);
    const value = parseNumber(row.OBS_VALUE);

    if (!sa2Code || !/^\d{9}$/.test(sa2Code) || !Number.isFinite(year) || !Number.isFinite(value)) {
      return;
    }

    if (!erpBySa2.has(sa2Code)) {
      erpBySa2.set(sa2Code, new Map());
    }

    erpBySa2.get(sa2Code).set(year, value);
    latestYear = latestYear === null ? year : Math.max(latestYear, year);
  });

  return { erpBySa2, latestYear };
}

async function extractSeifaIrsd() {
  const irsdBySa2 = new Map();

  await forEachCsvRow(RAW_FILES.seifa, async (row) => {
    const sa2Code = normalizeCode(row.ASGS_2021);
    if (!sa2Code || !/^\d{9}$/.test(sa2Code)) {
      return;
    }

    if (row.SEIFAINDEXTYPE !== 'IRSD' || row.SEIFA_MEASURE !== 'SCORE' || row.UNIT_MEASURE !== 'SCORE') {
      return;
    }

    const score = parseNumber(row.OBS_VALUE);
    if (Number.isFinite(score)) {
      irsdBySa2.set(sa2Code, score);
    }
  });

  return irsdBySa2;
}

function buildDpaStatusMap(dpaFeatures) {
  const statusByName = new Map();

  dpaFeatures.forEach((feature) => {
    const name = normalizeName(feature.properties?.DPA_Ctch);
    if (!name) {
      return;
    }

    if (!statusByName.has(name)) {
      statusByName.set(name, { Y: 0, N: 0 });
    }

    const status = cleanText(feature.properties?.DPA_MM2).toUpperCase();
    if (status === 'Y' || status === 'N') {
      statusByName.get(name)[status] += 1;
    }
  });

  return statusByName;
}

function parseSa2Boundaries() {
  const geojson = JSON.parse(fs.readFileSync(RAW_FILES.sa2Boundaries, 'utf8'));
  const features = Array.isArray(geojson.features) ? geojson.features : [];

  return features
    .map((feature) => {
      const props = feature.properties ?? {};
      const sa2Code = normalizeCode(props.sa2_code_2021);
      if (!sa2Code || !/^\d{9}$/.test(sa2Code)) {
        return null;
      }

      const geometry = feature.geometry;
      const bbox = getGeometryBBox(geometry);
      const centroid = centroidFromGeometry(geometry);
      if (!bbox || !centroid) {
        return null;
      }

      return {
        sa2_code: sa2Code,
        sa2_name: cleanText(props.sa2_name_2021),
        state_code: cleanText(props.state_code_2021),
        state_name: cleanText(props.state_name_2021),
        area_sqkm: parseNumber(props.area_albers_sqkm),
        geometry,
        bbox,
        centroid,
      };
    })
    .filter(Boolean);
}

function writeCsv(filePath, headers, rows) {
  const escapeCell = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    if (text.includes('"') || text.includes(',') || text.includes('\n')) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((header) => escapeCell(row[header])).join(','));
  });

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

async function main() {
  ensureDirectory(PROCESSED_DIR);
  ensureDirectory(PUBLIC_DATA_DIR);
  ensureDirectory(DOCS_DATA_DIR);
  ensureDirectory(TMP_DIR);

  Object.entries(RAW_FILES).forEach(([key, filePath]) => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing raw file (${key}): ${path.relative(projectRoot, filePath)}. Run npm run fetch:data first.`);
    }
  });

  const gpcExtractDir = path.join(TMP_DIR, 'gpc');
  const dpaExtractDir = path.join(TMP_DIR, 'dpa');
  ensureExtracted(RAW_FILES.gpcZip, gpcExtractDir);
  ensureExtracted(RAW_FILES.dpaZip, dpaExtractDir);

  const gpcShp = findFirstFile(gpcExtractDir, '.shp');
  const dpaShp = findFirstFile(dpaExtractDir, '.shp');
  if (!gpcShp || !dpaShp) {
    throw new Error('Could not locate required shapefiles after unzip.');
  }

  console.log('Loading GPC boundaries...');
  const gpcRawFeatures = await readShapefileFeatures(gpcShp);

  console.log('Loading DPA boundaries...');
  const dpaRawFeatures = await readShapefileFeatures(dpaShp);
  const dpaStatusByName = buildDpaStatusMap(dpaRawFeatures);

  console.log('Loading ABS SA2 boundaries...');
  const sa2Features = parseSa2Boundaries();
  const sa2ByState = new Map();
  sa2Features.forEach((item) => {
    const key = item.state_code;
    if (!sa2ByState.has(key)) {
      sa2ByState.set(key, []);
    }
    sa2ByState.get(key).push(item);
  });

  console.log('Loading Census, ERP and SEIFA metrics...');
  const [censusG02BySa2, erpResult, irsdBySa2] = await Promise.all([
    extractCensusG02(),
    extractErpSeries(),
    extractSeifaIrsd(),
  ]);

  const { erpBySa2, latestYear: latestErpYear } = erpResult;

  const metricArrays = {
    medianAge: [],
    growthPct: [],
    householdIncome: [],
    irsd: [],
  };

  const byStateFeatures = new Map();
  const centroidRows = [];
  const matchingStats = {
    exact_sa2_match: 0,
    nearest_sa2_fallback: 0,
    dpa_named_match: 0,
    dpa_missing_match: 0,
  };

  gpcRawFeatures.forEach((feature) => {
    const props = feature.properties ?? {};
    const catchmentCode = cleanText(props.GPC_CODE23);
    const catchmentName = cleanText(props.GPC_NAME23);
    const stateAbbr = cleanText(props.STE_ABBR21);
    const stateName = cleanText(props.STE_NAME21);
    const stateCode = cleanText(props.STE_CODE21);

    const centroid = [Number(props.CENT_LONG), Number(props.CENT_LAT)];
    if (!Number.isFinite(centroid[0]) || !Number.isFinite(centroid[1])) {
      return;
    }

    const stateCandidates = sa2ByState.get(stateCode) ?? sa2Features;
    const candidatesInBBox = stateCandidates.filter((candidate) => pointInBBox(centroid, candidate.bbox));

    let matchedSa2 = candidatesInBBox.find((candidate) => pointInGeometry(centroid, candidate.geometry)) ?? null;

    if (matchedSa2) {
      matchingStats.exact_sa2_match += 1;
    } else {
      let nearest = null;
      let nearestDist = Infinity;
      stateCandidates.forEach((candidate) => {
        const dist = squaredDistance(centroid, candidate.centroid);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = candidate;
        }
      });
      matchedSa2 = nearest;
      if (matchedSa2) {
        matchingStats.nearest_sa2_fallback += 1;
      }
    }

    const sa2Code = matchedSa2?.sa2_code ?? null;
    const g02 = sa2Code ? censusG02BySa2.get(sa2Code) : null;
    const erpSeries = sa2Code ? erpBySa2.get(sa2Code) : null;
    const populationLatest = erpSeries?.get(latestErpYear) ?? null;
    const populationPrevious = erpSeries?.get(latestErpYear - 1) ?? null;
    const populationGrowthPct =
      Number.isFinite(populationLatest) && Number.isFinite(populationPrevious) && populationPrevious > 0
        ? ((populationLatest - populationPrevious) / populationPrevious) * 100
        : null;

    const medianAge = g02?.median_age ?? null;
    const medianHouseholdIncome = g02?.median_household_income_weekly ?? null;
    const irsdScore = sa2Code ? irsdBySa2.get(sa2Code) ?? null : null;

    if (Number.isFinite(medianAge)) metricArrays.medianAge.push(medianAge);
    if (Number.isFinite(populationGrowthPct)) metricArrays.growthPct.push(populationGrowthPct);
    if (Number.isFinite(medianHouseholdIncome)) metricArrays.householdIncome.push(medianHouseholdIncome);
    if (Number.isFinite(irsdScore)) metricArrays.irsd.push(irsdScore);

    const dpaKey = normalizeName(catchmentName);
    const dpaCounts = dpaStatusByName.get(dpaKey) ?? null;
    const dpaStatus = dpaCounts ? (dpaCounts.Y > 0 ? 'Y' : 'N') : null;
    if (dpaCounts) {
      matchingStats.dpa_named_match += 1;
    } else {
      matchingStats.dpa_missing_match += 1;
    }

    const baseFeature = {
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        catchment_code: catchmentCode,
        catchment_name: catchmentName,
        state: stateAbbr,
        state_name: stateName,
        state_code: stateCode,
        area_sqkm: roundNum(parseNumber(props.GPC_SQKM23), 3),
        centroid_longitude: roundNum(centroid[0], 6),
        centroid_latitude: roundNum(centroid[1], 6),
        sa2_code: sa2Code,
        sa2_name: matchedSa2?.sa2_name ?? null,
        sa2_state_name: matchedSa2?.state_name ?? null,
        population_latest: populationLatest,
        population_growth_1y_pct: roundNum(populationGrowthPct, 3),
        median_age: medianAge,
        median_household_income_weekly: medianHouseholdIncome,
        seifa_irsd_score_2021: irsdScore,
        dpa_gp_status_2025: dpaStatus,
      },
    };

    if (!byStateFeatures.has(stateAbbr)) {
      byStateFeatures.set(stateAbbr, []);
    }
    byStateFeatures.get(stateAbbr).push(baseFeature);
    centroidRows.push(baseFeature.properties);
  });

  metricArrays.medianAge.sort((a, b) => a - b);
  metricArrays.growthPct.sort((a, b) => a - b);
  metricArrays.householdIncome.sort((a, b) => a - b);
  metricArrays.irsd.sort((a, b) => a - b);

  const allRows = [];
  const centroidGeojsonFeatures = [];

  for (const stateAbbr of STATE_ORDER) {
    const stateFeatures = byStateFeatures.get(stateAbbr) ?? [];
    if (!stateFeatures.length) {
      continue;
    }

    const simplifiedFeatures = stateFeatures.map((feature) => {
      const properties = feature.properties;

      const agePct = percentileFromSorted(properties.median_age, metricArrays.medianAge);
      const growthPctile = percentileFromSorted(properties.population_growth_1y_pct, metricArrays.growthPct);
      const incomePct = percentileFromSorted(properties.median_household_income_weekly, metricArrays.householdIncome);
      const irsdPct = percentileFromSorted(properties.seifa_irsd_score_2021, metricArrays.irsd);

      const lowIncomePct = 1 - incomePct;
      const disadvantagePct = 1 - irsdPct;
      const needIndex = 0.3 * agePct + 0.25 * growthPctile + 0.2 * lowIncomePct + 0.25 * disadvantagePct;
      const dpaBinary = properties.dpa_gp_status_2025 === 'Y' ? 1 : 0;
      const opportunityScore = 100 * (0.55 * dpaBinary + 0.45 * needIndex);

      const enrichedProperties = {
        ...properties,
        need_index: roundNum(needIndex, 4),
        dpa_binary: dpaBinary,
        opportunity_score: roundNum(opportunityScore, 2),
        component_percentiles: {
          age_pctile: roundNum(agePct, 4),
          growth_pctile: roundNum(growthPctile, 4),
          low_income_pctile: roundNum(lowIncomePct, 4),
          disadvantage_pctile: roundNum(disadvantagePct, 4),
        },
      };

      const rawCoordCount = countCoordinates(feature.geometry.coordinates);
      const simplified = simplify(
        {
          type: 'Feature',
          geometry: feature.geometry,
          properties: enrichedProperties,
        },
        {
          tolerance: SIMPLIFY_TOLERANCE,
          highQuality: false,
          mutate: false,
        },
      );

      const simpleGeometry = {
        type: simplified.geometry.type,
        coordinates: roundCoordinates(simplified.geometry.coordinates, 5),
      };

      const simpleCoordCount = countCoordinates(simpleGeometry.coordinates);
      enrichedProperties.geometry_point_count_raw = rawCoordCount;
      enrichedProperties.geometry_point_count_simplified = simpleCoordCount;

      const featureOut = {
        type: 'Feature',
        geometry: simpleGeometry,
        properties: enrichedProperties,
      };

      allRows.push(enrichedProperties);
      centroidGeojsonFeatures.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [enrichedProperties.centroid_longitude, enrichedProperties.centroid_latitude],
        },
        properties: enrichedProperties,
      });

      return featureOut;
    });

    const stateGeojson = {
      type: 'FeatureCollection',
      features: simplifiedFeatures,
    };

    const statePathProcessed = path.join(PROCESSED_DIR, 'catchments', `${stateAbbr}.geojson`);
    const statePathPublic = path.join(PUBLIC_DATA_DIR, 'catchments', `${stateAbbr}.geojson`);
    const statePathDocs = path.join(DOCS_DATA_DIR, 'catchments', `${stateAbbr}.geojson`);

    ensureDirectory(path.dirname(statePathProcessed));
    ensureDirectory(path.dirname(statePathPublic));
    ensureDirectory(path.dirname(statePathDocs));

    await fsp.writeFile(statePathProcessed, JSON.stringify(stateGeojson));
    await fsp.writeFile(statePathPublic, JSON.stringify(stateGeojson));
    await fsp.writeFile(statePathDocs, JSON.stringify(stateGeojson));
  }

  allRows.sort((a, b) => (b.opportunity_score ?? 0) - (a.opportunity_score ?? 0));

  const topRows = allRows.slice(0, 200).map((row, index) => ({
    rank: index + 1,
    catchment_code: row.catchment_code,
    catchment_name: row.catchment_name,
    state: row.state,
    dpa_gp_status_2025: row.dpa_gp_status_2025,
    opportunity_score: row.opportunity_score,
    need_index: row.need_index,
    population_latest: row.population_latest,
    population_growth_1y_pct: row.population_growth_1y_pct,
    median_age: row.median_age,
    median_household_income_weekly: row.median_household_income_weekly,
    seifa_irsd_score_2021: row.seifa_irsd_score_2021,
    sa2_code: row.sa2_code,
    sa2_name: row.sa2_name,
  }));

  const metadata = {
    generated_at: new Date().toISOString(),
    reference: {
      latest_erp_year: latestErpYear,
      dpa_dataset: 'DPA GPs 2025',
      gpc_dataset: 'GPC 2023',
      seifa_dataset: 'SEIFA 2021 SA2 (IRSD)',
      census_dataset: 'Census 2021 G02 SA2',
    },
    method: {
      score_formula:
        'opportunity_score = 100 * (0.55 * dpa_binary + 0.45 * need_index). need_index = 0.30*age_pctile + 0.25*growth_pctile + 0.20*low_income_pctile + 0.25*disadvantage_pctile',
      details: [
        'dpa_binary is 1 when the catchment is marked Y in the official DPA GPs 2025 dataset, else 0.',
        'age_pctile is the national percentile of SA2 median age for the matched SA2.',
        'growth_pctile is the national percentile of one-year SA2 ERP population growth.',
        'low_income_pctile is inverse percentile of SA2 median household income.',
        'disadvantage_pctile is inverse percentile of SA2 IRSD score (SEIFA 2021).',
      ],
      matching: {
        sa2_match_strategy:
          'Use official GPC centroid -> SA2 point-in-polygon within same state; fallback to nearest SA2 centroid when no containing polygon is found.',
        stats: matchingStats,
      },
      simplify_tolerance: SIMPLIFY_TOLERANCE,
    },
    coverage: {
      catchments_total: allRows.length,
      by_state: STATE_ORDER.map((state) => ({
        state,
        catchments: allRows.filter((row) => row.state === state).length,
        dpa_yes: allRows.filter((row) => row.state === state && row.dpa_gp_status_2025 === 'Y').length,
      })).filter((row) => row.catchments > 0),
    },
    source_manifest: JSON.parse(fs.readFileSync(RAW_FILES.sourceManifest, 'utf8')),
  };

  const datasetOutput = {
    metadata,
    catchments: allRows,
    top_recommendations: topRows,
  };

  const centroidsGeojson = {
    type: 'FeatureCollection',
    features: centroidGeojsonFeatures,
  };

  const datasetPathProcessed = path.join(PROCESSED_DIR, 'healthcare-access-dataset.json');
  const datasetPathPublic = path.join(PUBLIC_DATA_DIR, 'healthcare-access-dataset.json');
  const datasetPathDocs = path.join(DOCS_DATA_DIR, 'healthcare-access-dataset.json');

  const centroidsPathProcessed = path.join(PROCESSED_DIR, 'catchment-centroids.geojson');
  const centroidsPathPublic = path.join(PUBLIC_DATA_DIR, 'catchment-centroids.geojson');
  const centroidsPathDocs = path.join(DOCS_DATA_DIR, 'catchment-centroids.geojson');

  ensureDirectory(path.dirname(datasetPathProcessed));
  ensureDirectory(path.dirname(datasetPathPublic));
  ensureDirectory(path.dirname(datasetPathDocs));

  ensureDirectory(path.dirname(centroidsPathProcessed));
  ensureDirectory(path.dirname(centroidsPathPublic));
  ensureDirectory(path.dirname(centroidsPathDocs));

  await fsp.writeFile(datasetPathProcessed, JSON.stringify(datasetOutput));
  await fsp.writeFile(datasetPathPublic, JSON.stringify(datasetOutput));
  await fsp.writeFile(datasetPathDocs, JSON.stringify(datasetOutput));

  await fsp.writeFile(centroidsPathProcessed, JSON.stringify(centroidsGeojson));
  await fsp.writeFile(centroidsPathPublic, JSON.stringify(centroidsGeojson));
  await fsp.writeFile(centroidsPathDocs, JSON.stringify(centroidsGeojson));

  const csvHeaders = [
    'rank',
    'catchment_code',
    'catchment_name',
    'state',
    'dpa_gp_status_2025',
    'opportunity_score',
    'need_index',
    'population_latest',
    'population_growth_1y_pct',
    'median_age',
    'median_household_income_weekly',
    'seifa_irsd_score_2021',
    'sa2_code',
    'sa2_name',
  ];

  const csvPathProcessed = path.join(PROCESSED_DIR, 'top-healthcare-opportunities.csv');
  const csvPathPublic = path.join(PUBLIC_DATA_DIR, 'top-healthcare-opportunities.csv');
  const csvPathDocs = path.join(DOCS_DATA_DIR, 'top-healthcare-opportunities.csv');

  writeCsv(csvPathProcessed, csvHeaders, topRows);
  writeCsv(csvPathPublic, csvHeaders, topRows);
  writeCsv(csvPathDocs, csvHeaders, topRows);

  console.log(`Catchments processed: ${allRows.length}`);
  console.log(`Top recommendation: ${topRows[0]?.catchment_name || 'N/A'} (${topRows[0]?.state || 'N/A'})`);
  console.log(`Dataset written: ${path.relative(projectRoot, datasetPathProcessed)}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
