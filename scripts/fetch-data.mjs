import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const rawDir = path.join(projectRoot, 'data', 'raw');

const SOURCES = [
  {
    id: 'gpc_2023',
    publisher: 'Department of Health and Aged Care (data.gov.au)',
    description: 'General Practitioner Catchments (GPC) 2023 boundaries.',
    url: 'https://data.gov.au/data/dataset/cc26a27b-3b37-4922-a8a1-700857eb4888/resource/341f53c7-9344-4575-9467-2422df765bd4/download/gpc_2023.zip',
    filename: 'gpc_2023.zip',
    official_release_date: '2023-01-01',
  },
  {
    id: 'dpa_gps_2025a',
    publisher: 'Department of Health and Aged Care (data.gov.au)',
    description: 'Distribution Priority Area (DPA) for GPs 2025 boundaries.',
    url: 'https://data.gov.au/data/dataset/7d889af7-9506-4eb5-930e-cefe6b5f39c1/resource/b08c23ce-5db4-4cc7-a473-d9db7d491464/download/dpa_gps_2025a.zip',
    filename: 'dpa_gps_2025a.zip',
    official_release_date: '2025-01-01',
  },
  {
    id: 'abs_census_2021_g02_sa2',
    publisher: 'ABS Data API',
    description: 'Census 2021 selected medians and averages for SA2 and above.',
    url: 'https://data.api.abs.gov.au/rest/data/C21_G02_SA2?format=csvfile',
    filename: 'census_2021_g02_sa2.csv',
    official_release_date: '2022-06-28',
  },
  {
    id: 'abs_annual_erp_asgs2021',
    publisher: 'ABS Data API',
    description: 'Estimated Resident Population by ASGS 2021 geographies.',
    url: 'https://data.api.abs.gov.au/rest/data/ABS_ANNUAL_ERP_ASGS2021?format=csvfile',
    filename: 'annual_erp_asgs2021.csv',
    official_release_date: '2025-03-20',
  },
  {
    id: 'abs_seifa_2021_sa2',
    publisher: 'ABS Data API',
    description: 'SEIFA 2021 by SA2 (IRSD/IRSAD/IEO/IER and related ranks).',
    url: 'https://data.api.abs.gov.au/rest/data/ABS_SEIFA2021_SA2?format=csvfile',
    filename: 'seifa_2021_sa2.csv',
    official_release_date: '2023-04-27',
  },
];

const SA2_BOUNDARY_SOURCE = {
  id: 'abs_asgs2021_sa2_boundaries',
  publisher: 'ABS Geo API',
  description: 'ASGS 2021 SA2 boundaries (GeoJSON, paginated ArcGIS query).',
  official_release_date: '2021-01-01',
};

const SA2_QUERY_URL =
  'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SA2/MapServer/0/query?where=1%3D1&outFields=sa2_code_2021,sa2_name_2021,state_code_2021,state_name_2021,area_albers_sqkm&outSR=4326&f=geojson';

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function downloadToFile(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }

    const request = https.get(
      url,
      {
        headers: {
          'user-agent': 'healthcare-access-gap/1.0 (+https://github.com/0xtreme)',
          accept: '*/*',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400 && location) {
          response.resume();
          const nextUrl = new URL(location, url).toString();
          downloadToFile(nextUrl, destination, redirects + 1).then(resolve).catch(reject);
          return;
        }

        if (status < 200 || status >= 300) {
          reject(new Error(`Failed download ${url}: HTTP ${status}`));
          return;
        }

        const fileStream = fs.createWriteStream(destination);
        response.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve({
              contentLength: response.headers['content-length'] ? Number(response.headers['content-length']) : null,
              contentType: response.headers['content-type'] ?? null,
            });
          });
        });

        fileStream.on('error', (error) => {
          fileStream.close(() => reject(error));
        });
      },
    );

    request.on('error', reject);
    request.setTimeout(240000, () => {
      request.destroy(new Error(`Timeout downloading ${url}`));
    });
  });
}

function downloadJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) {
      reject(new Error(`Too many redirects for ${url}`));
      return;
    }

    const request = https.get(
      url,
      {
        headers: {
          'user-agent': 'healthcare-access-gap/1.0 (+https://github.com/0xtreme)',
          accept: 'application/json,*/*',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400 && location) {
          response.resume();
          const nextUrl = new URL(location, url).toString();
          downloadJson(nextUrl, redirects + 1).then(resolve).catch(reject);
          return;
        }

        if (status < 200 || status >= 300) {
          reject(new Error(`Failed download ${url}: HTTP ${status}`));
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Invalid JSON from ${url}: ${error.message}`));
          }
        });
      },
    );

    request.on('error', reject);
    request.setTimeout(240000, () => {
      request.destroy(new Error(`Timeout downloading ${url}`));
    });
  });
}

async function fetchSa2Boundaries(force) {
  const destination = path.join(rawDir, 'sa2_boundaries_2021.geojson');

  if (!force && fs.existsSync(destination)) {
    const stats = await fsp.stat(destination);
    return {
      path: path.relative(projectRoot, destination),
      bytes: stats.size,
      reused_existing_file: true,
      feature_count: null,
    };
  }

  const pageSize = 1000;
  let offset = 0;
  const allFeatures = [];

  while (true) {
    const url = `${SA2_QUERY_URL}&resultOffset=${offset}&resultRecordCount=${pageSize}`;
    // eslint-disable-next-line no-await-in-loop
    const payload = await downloadJson(url);

    if (payload.error) {
      throw new Error(`SA2 boundary query error: ${payload.error.message || 'Unknown error'}`);
    }

    const features = Array.isArray(payload.features) ? payload.features : [];
    allFeatures.push(...features);

    console.log(`[sa2] fetched ${features.length} features (offset ${offset})`);

    if (!features.length || (!payload.exceededTransferLimit && features.length < pageSize)) {
      break;
    }

    offset += features.length;
  }

  const geojson = {
    type: 'FeatureCollection',
    features: allFeatures,
    properties: {
      fetched_at: new Date().toISOString(),
      source: SA2_BOUNDARY_SOURCE.id,
    },
  };

  await fsp.writeFile(destination, JSON.stringify(geojson));
  const stats = await fsp.stat(destination);

  return {
    path: path.relative(projectRoot, destination),
    bytes: stats.size,
    reused_existing_file: false,
    feature_count: allFeatures.length,
  };
}

async function main() {
  ensureDirectory(rawDir);
  const force = process.argv.includes('--force');
  const fetchedAt = new Date().toISOString();

  const manifest = {
    fetched_at: fetchedAt,
    sources: [],
  };

  for (const source of SOURCES) {
    const destination = path.join(rawDir, source.filename);
    const exists = fs.existsSync(destination);

    if (exists && !force) {
      const stats = await fsp.stat(destination);
      manifest.sources.push({
        ...source,
        path: path.relative(projectRoot, destination),
        fetched_at: fetchedAt,
        bytes: stats.size,
        reused_existing_file: true,
      });
      console.log(`[skip] ${source.id} -> ${source.filename} (${stats.size} bytes)`);
      continue;
    }

    console.log(`[download] ${source.id}`);
    const responseMeta = await downloadToFile(source.url, destination);
    const stats = await fsp.stat(destination);

    manifest.sources.push({
      ...source,
      path: path.relative(projectRoot, destination),
      fetched_at: fetchedAt,
      bytes: stats.size,
      content_type: responseMeta.contentType,
      content_length_header: responseMeta.contentLength,
      reused_existing_file: false,
    });

    console.log(`[ok] ${source.filename} (${stats.size} bytes)`);
  }

  console.log('[download] abs_asgs2021_sa2_boundaries');
  const sa2File = await fetchSa2Boundaries(force);
  manifest.sources.push({
    ...SA2_BOUNDARY_SOURCE,
    path: sa2File.path,
    fetched_at: fetchedAt,
    bytes: sa2File.bytes,
    reused_existing_file: sa2File.reused_existing_file,
    feature_count: sa2File.feature_count,
  });
  console.log(`[ok] ${path.basename(sa2File.path)} (${sa2File.bytes} bytes)`);

  const manifestPath = path.join(rawDir, 'sources-manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nWrote ${path.relative(projectRoot, manifestPath)}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
