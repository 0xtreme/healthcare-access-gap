const METRICS = {
  opportunity_score: {
    label: 'Opportunity Score',
    type: 'number',
    digits: 1,
    plainMeaning: 'Higher values suggest stronger combined access pressure and growth opportunity.',
  },
  need_index: {
    label: 'Need Index',
    type: 'number',
    digits: 3,
    plainMeaning: 'Higher values indicate stronger demographic pressure signals.',
  },
  population_growth_1y_pct: {
    label: 'Population Growth 1Y (%)',
    type: 'percent',
    digits: 2,
    plainMeaning: 'Higher values indicate faster local population growth.',
  },
  median_age: {
    label: 'Median Age',
    type: 'number',
    digits: 1,
    plainMeaning: 'Higher values indicate an older local population profile.',
  },
  median_household_income_weekly: {
    label: 'Median Household Income (Weekly)',
    type: 'currency',
    digits: 0,
    plainMeaning: 'Higher values indicate higher reported weekly household income.',
  },
  seifa_irsd_score_2021: {
    label: 'SEIFA IRSD Score (2021)',
    type: 'number',
    digits: 0,
    plainMeaning: 'Higher values indicate relatively lower disadvantage in this index.',
  },
};

const state = {
  dataset: null,
  map: null,
  selectedState: 'ALL',
  selectedMetric: 'opportunity_score',
  dpaFilter: 'ALL',
  query: '',
  showPolygons: true,
  selectedCode: null,
  filteredRows: [],
  polygonCache: new Map(),
  polygonRequestSeq: 0,
};

const el = {
  loadChip: document.getElementById('loadChip'),
  loadProgress: document.getElementById('loadProgress'),
  coverageLine: document.getElementById('coverageLine'),
  stateSelect: document.getElementById('stateSelect'),
  metricSelect: document.getElementById('metricSelect'),
  dpaFilter: document.getElementById('dpaFilter'),
  searchInput: document.getElementById('searchInput'),
  showPolygons: document.getElementById('showPolygons'),
  resetView: document.getElementById('resetView'),
  selectedTitle: document.getElementById('selectedTitle'),
  selectedMeta: document.getElementById('selectedMeta'),
  selectedMetrics: document.getElementById('selectedMetrics'),
  topChart: document.getElementById('topChart'),
  tradeoffChart: document.getElementById('tradeoffChart'),
  sourceList: document.getElementById('sourceList'),
  legendMetricLine: document.getElementById('legendMetricLine'),
  legendLow: document.getElementById('legendLow'),
  legendHigh: document.getElementById('legendHigh'),
  statCatchments: document.getElementById('statCatchments'),
  statDpaShare: document.getElementById('statDpaShare'),
  statMedianScore: document.getElementById('statMedianScore'),
  statMetricRange: document.getElementById('statMetricRange'),
};

function setLoading(message, pct = null) {
  if (el.loadChip) {
    el.loadChip.textContent = message;
  }

  if (el.loadProgress && Number.isFinite(pct)) {
    const safe = Math.max(0, Math.min(100, pct));
    el.loadProgress.style.width = `${safe}%`;
  }
}

function num(value, digits = 0) {
  if (!Number.isFinite(value)) {
    return 'N/A';
  }

  return value.toLocaleString('en-AU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatMetricValue(metricKey, value) {
  const metric = METRICS[metricKey] ?? { type: 'number', digits: 0 };

  if (!Number.isFinite(value)) {
    return 'N/A';
  }

  if (metric.type === 'currency') {
    return `$${num(value, metric.digits)}`;
  }

  if (metric.type === 'percent') {
    return `${num(value, metric.digits)}%`;
  }

  return num(value, metric.digits);
}

function fetchJson(url) {
  return fetch(url).then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return response.json();
  });
}

function metricStops(metricKey, rows) {
  const values = rows
    .map((row) => Number(row[metricKey]))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!values.length) {
    return { low: 0, mid: 50, high: 100 };
  }

  const low = values[Math.floor(values.length * 0.1)] ?? values[0];
  const mid = values[Math.floor(values.length * 0.5)] ?? values[Math.floor(values.length / 2)];
  const high = values[Math.floor(values.length * 0.9)] ?? values[values.length - 1];

  return { low, mid, high: Math.max(high, low + 1e-6) };
}

function median(values) {
  if (!values.length) {
    return NaN;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}

function metricColorExpression(metricKey, rows) {
  const stops = metricStops(metricKey, rows);

  return [
    'case',
    ['!', ['has', metricKey]],
    '#c6d0ca',
    ['interpolate', ['linear'], ['to-number', ['get', metricKey]],
      stops.low, '#e25f35',
      stops.mid, '#f0c45d',
      stops.high, '#0a9170'],
  ];
}

function buildPointCollection(rows) {
  return {
    type: 'FeatureCollection',
    features: rows
      .filter((row) => Number.isFinite(row.centroid_longitude) && Number.isFinite(row.centroid_latitude))
      .map((row) => ({
        type: 'Feature',
        id: row.catchment_code,
        geometry: {
          type: 'Point',
          coordinates: [row.centroid_longitude, row.centroid_latitude],
        },
        properties: { ...row },
      })),
  };
}

function renderSourceList() {
  if (!el.sourceList || !state.dataset?.metadata?.source_manifest?.sources) {
    return;
  }

  const sources = state.dataset.metadata.source_manifest.sources;
  el.sourceList.innerHTML = sources
    .map((source) => {
      const release = source.official_release_date ? `release ${source.official_release_date}` : 'release date not provided';
      return `<li><strong>${source.publisher}</strong>: ${source.description} (${release})</li>`;
    })
    .join('');
}

function renderLegend() {
  const metricMeta = METRICS[state.selectedMetric] ?? { label: state.selectedMetric, plainMeaning: '' };
  const stops = metricStops(state.selectedMetric, state.filteredRows);

  if (el.legendMetricLine) {
    const suffix = metricMeta.plainMeaning ? ` ${metricMeta.plainMeaning}` : '';
    el.legendMetricLine.textContent =
      `${metricMeta.label}: red = lower values, green = higher values in the current filtered view.${suffix}`;
  }

  if (el.legendLow) {
    el.legendLow.textContent = `Low ${formatMetricValue(state.selectedMetric, stops.low)}`;
  }

  if (el.legendHigh) {
    el.legendHigh.textContent = `High ${formatMetricValue(state.selectedMetric, stops.high)}`;
  }
}

function renderSnapshot() {
  const rows = state.filteredRows;
  const count = rows.length;
  const dpaCount = rows.filter((row) => row.dpa_gp_status_2025 === 'Y').length;
  const scoreMedian = median(
    rows
      .map((row) => Number(row.opportunity_score))
      .filter((value) => Number.isFinite(value)),
  );
  const metricSpread = metricStops(state.selectedMetric, rows);

  if (el.statCatchments) {
    el.statCatchments.textContent = num(count, 0);
  }

  if (el.statDpaShare) {
    el.statDpaShare.textContent = count ? `${num((dpaCount / count) * 100, 1)}%` : 'N/A';
  }

  if (el.statMedianScore) {
    el.statMedianScore.textContent = Number.isFinite(scoreMedian) ? num(scoreMedian, 1) : 'N/A';
  }

  if (el.statMetricRange) {
    el.statMetricRange.textContent =
      `${formatMetricValue(state.selectedMetric, metricSpread.low)} - ${formatMetricValue(state.selectedMetric, metricSpread.high)}`;
  }
}

function initSelectors() {
  const rows = state.dataset.catchments;
  const states = ['ALL', ...new Set(rows.map((row) => row.state).filter(Boolean))];

  el.stateSelect.innerHTML = states
    .map((abbr) => (abbr === 'ALL' ? '<option value="ALL">All States / Territories</option>' : `<option value="${abbr}">${abbr}</option>`))
    .join('');

  el.metricSelect.innerHTML = Object.entries(METRICS)
    .map(([key, info]) => `<option value="${key}">${info.label}</option>`)
    .join('');

  el.metricSelect.value = state.selectedMetric;
  el.stateSelect.value = state.selectedState;
  el.dpaFilter.value = state.dpaFilter;
}

function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    center: [134.5, -25.7],
    zoom: 3.2,
    maxZoom: 11,
  });

  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  state.map.on('load', () => {
    state.map.addSource('catchment-centroids', {
      type: 'geojson',
      data: buildPointCollection(state.filteredRows),
    });

    state.map.addSource('catchment-polygons', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    state.map.addLayer({
      id: 'catchments-fill',
      type: 'fill',
      source: 'catchment-polygons',
      paint: {
        'fill-color': metricColorExpression(state.selectedMetric, state.filteredRows),
        'fill-opacity': 0.32,
      },
    });

    state.map.addLayer({
      id: 'catchments-line',
      type: 'line',
      source: 'catchment-polygons',
      paint: {
        'line-color': '#34584a',
        'line-width': 0.7,
        'line-opacity': 0.55,
      },
    });

    state.map.addLayer({
      id: 'centroids-circle',
      type: 'circle',
      source: 'catchment-centroids',
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['to-number', ['get', 'population_latest']],
          0,
          2.8,
          5000,
          4,
          20000,
          6.2,
          60000,
          9.6,
          120000,
          12,
        ],
        'circle-color': metricColorExpression(state.selectedMetric, state.filteredRows),
        'circle-stroke-width': 0.9,
        'circle-stroke-color': '#0d271e',
        'circle-opacity': 0.92,
      },
    });

    state.map.addLayer({
      id: 'centroids-selected',
      type: 'circle',
      source: 'catchment-centroids',
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['to-number', ['get', 'population_latest']],
          0,
          4.5,
          5000,
          6,
          20000,
          8.2,
          60000,
          11.6,
          120000,
          14,
        ],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#0d271e',
        'circle-stroke-width': 2.1,
      },
      filter: ['==', ['get', 'catchment_code'], ''],
    });

    state.map.on('mouseenter', 'centroids-circle', () => {
      state.map.getCanvas().style.cursor = 'pointer';
    });

    state.map.on('mouseleave', 'centroids-circle', () => {
      state.map.getCanvas().style.cursor = '';
    });

    state.map.on('click', 'centroids-circle', (event) => {
      const feature = event.features?.[0];
      if (!feature) {
        return;
      }

      const row = feature.properties || {};
      const catchmentCode = row.catchment_code;
      if (!catchmentCode) {
        return;
      }

      selectCatchment(catchmentCode);

      const popupHtml = [
        `<div class="map-pop"><strong>${row.catchment_name || 'Catchment'}</strong>`,
        `${row.state || ''} | DPA ${row.dpa_gp_status_2025 || 'N/A'}<br/>`,
        `Opportunity: ${formatMetricValue('opportunity_score', Number(row.opportunity_score))}<br/>`,
        `${METRICS[state.selectedMetric]?.label || 'Selected metric'}: ${formatMetricValue(state.selectedMetric, Number(row[state.selectedMetric]))}<br/>`,
        `Need Index: ${formatMetricValue('need_index', Number(row.need_index))}`,
        '</div>',
      ].join('');

      new maplibregl.Popup({ offset: 10 })
        .setLngLat(event.lngLat)
        .setHTML(popupHtml)
        .addTo(state.map);
    });

    updateMapData();
    setLoading('Data loaded. Ready.', 100);
  });
}

function applyFilters() {
  const query = state.query.trim().toLowerCase();

  state.filteredRows = state.dataset.catchments.filter((row) => {
    if (state.selectedState !== 'ALL' && row.state !== state.selectedState) {
      return false;
    }

    if (state.dpaFilter !== 'ALL' && row.dpa_gp_status_2025 !== state.dpaFilter) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = `${row.catchment_name || ''} ${row.sa2_name || ''} ${row.state || ''}`.toLowerCase();
    return haystack.includes(query);
  });

  if (el.coverageLine) {
    el.coverageLine.textContent = `Catchments shown: ${num(state.filteredRows.length)} across ${state.selectedState === 'ALL' ? 'Australia' : state.selectedState}`;
  }

  if (state.selectedCode && !state.filteredRows.some((row) => row.catchment_code === state.selectedCode)) {
    state.selectedCode = null;
  }
}

function updateColorStyling() {
  if (!state.map) {
    return;
  }

  const expression = metricColorExpression(state.selectedMetric, state.filteredRows);

  if (state.map.getLayer('centroids-circle')) {
    state.map.setPaintProperty('centroids-circle', 'circle-color', expression);
  }

  if (state.map.getLayer('catchments-fill')) {
    state.map.setPaintProperty('catchments-fill', 'fill-color', expression);
  }
}

function updateMapData() {
  if (!state.map || !state.map.getSource('catchment-centroids')) {
    return;
  }

  state.map.getSource('catchment-centroids').setData(buildPointCollection(state.filteredRows));
  updateColorStyling();

  if (state.map.getLayer('centroids-selected')) {
    state.map.setFilter('centroids-selected', ['==', ['get', 'catchment_code'], state.selectedCode || '']);
  }
}

async function updatePolygonLayer() {
  if (!state.map || !state.map.getSource('catchment-polygons')) {
    return;
  }

  const requestId = ++state.polygonRequestSeq;

  if (!state.showPolygons) {
    state.map.getSource('catchment-polygons').setData({ type: 'FeatureCollection', features: [] });
    setLoading('Polygon layer hidden. Using fast centroid mode.', 100);
    return;
  }

  if (state.selectedState === 'ALL') {
    state.map.getSource('catchment-polygons').setData({ type: 'FeatureCollection', features: [] });
    setLoading('Select a state to load detailed polygons.', 100);
    return;
  }

  try {
    let stateGeo = state.polygonCache.get(state.selectedState);

    if (!stateGeo) {
      setLoading(`Loading ${state.selectedState} polygons...`, 45);
      stateGeo = await fetchJson(`./data/catchments/${state.selectedState}.geojson`);
      state.polygonCache.set(state.selectedState, stateGeo);
    }

    if (requestId !== state.polygonRequestSeq) {
      return;
    }

    const keepCodes = new Set(state.filteredRows.map((row) => row.catchment_code));
    const filteredFeatures = (stateGeo.features || []).filter((feature) => keepCodes.has(feature.properties?.catchment_code));

    state.map.getSource('catchment-polygons').setData({
      type: 'FeatureCollection',
      features: filteredFeatures,
    });

    updateColorStyling();
    setLoading(`${state.selectedState} polygons ready (${num(filteredFeatures.length)} shown)`, 100);
  } catch (error) {
    if (requestId !== state.polygonRequestSeq) {
      return;
    }

    state.map.getSource('catchment-polygons').setData({ type: 'FeatureCollection', features: [] });
    setLoading(`Could not load ${state.selectedState} polygons: ${error.message}`, 100);
  }
}

function selectCatchment(code) {
  state.selectedCode = code;

  if (state.map && state.map.getLayer('centroids-selected')) {
    state.map.setFilter('centroids-selected', ['==', ['get', 'catchment_code'], code || '']);
  }

  renderSelectedCatchment();
}

function renderSelectedCatchment() {
  const row = state.filteredRows.find((item) => item.catchment_code === state.selectedCode) || null;

  if (!row) {
    el.selectedTitle.textContent = 'Click a map point';
    el.selectedMeta.textContent = 'Catchment details appear here.';
    el.selectedMetrics.innerHTML = '';
    return;
  }

  el.selectedTitle.textContent = row.catchment_name;
  el.selectedMeta.textContent = `${row.state} | SA2 ${row.sa2_name || 'N/A'} | DPA ${row.dpa_gp_status_2025 || 'N/A'}`;

  const cards = [
    { label: 'Opportunity Score', value: formatMetricValue('opportunity_score', row.opportunity_score) },
    { label: 'Need Index', value: formatMetricValue('need_index', row.need_index) },
    { label: 'Population (latest ERP)', value: num(row.population_latest, 0) },
    { label: 'Population Growth 1Y', value: formatMetricValue('population_growth_1y_pct', row.population_growth_1y_pct) },
    { label: 'Median Age', value: formatMetricValue('median_age', row.median_age) },
    {
      label: 'Median Household Income',
      value: formatMetricValue('median_household_income_weekly', row.median_household_income_weekly),
    },
    { label: 'SEIFA IRSD', value: formatMetricValue('seifa_irsd_score_2021', row.seifa_irsd_score_2021) },
    { label: 'DPA GP Status', value: row.dpa_gp_status_2025 || 'N/A' },
  ];

  el.selectedMetrics.innerHTML = cards
    .map(
      (card) =>
        `<div class="metric"><div class="label">${card.label}</div><div class="value">${card.value}</div></div>`,
    )
    .join('');
}

function renderCharts() {
  const rows = [...state.filteredRows];

  const top = rows
    .filter((row) => Number.isFinite(row.opportunity_score))
    .sort((a, b) => b.opportunity_score - a.opportunity_score)
    .slice(0, 12)
    .reverse();

  Plotly.newPlot(
    el.topChart,
    [
      {
        type: 'bar',
        orientation: 'h',
        y: top.map((row) => `${row.catchment_name} (${row.state})`),
        x: top.map((row) => row.opportunity_score),
        marker: {
          color: top.map((row) => (row.dpa_gp_status_2025 === 'Y' ? '#0d8f6f' : '#f16f3d')),
        },
        hovertemplate: '%{y}<br>Score %{x:.1f}<extra></extra>',
      },
    ],
    {
      title: { text: 'Top Catchments In Current View', font: { size: 13 } },
      margin: { t: 34, r: 16, b: 28, l: 150 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      xaxis: { title: 'Opportunity Score', gridcolor: '#e5ece8' },
      yaxis: { automargin: true },
      showlegend: false,
      font: { family: 'Source Sans 3, sans-serif', size: 11 },
    },
    { displayModeBar: false, responsive: true },
  );

  const scatter = rows.filter(
    (row) =>
      Number.isFinite(row.population_growth_1y_pct) &&
      Number.isFinite(row.median_household_income_weekly) &&
      Number.isFinite(row.opportunity_score),
  );

  Plotly.newPlot(
    el.tradeoffChart,
    [
      {
        type: 'scattergl',
        mode: 'markers',
        x: scatter.map((row) => row.population_growth_1y_pct),
        y: scatter.map((row) => row.median_household_income_weekly),
        text: scatter.map((row) => `${row.catchment_name} (${row.state})`),
        marker: {
          size: scatter.map((row) => Math.max(6, Math.min(18, (row.opportunity_score || 0) / 7))),
          color: scatter.map((row) => (row.dpa_gp_status_2025 === 'Y' ? '#0d8f6f' : '#f16f3d')),
          opacity: 0.72,
          line: { width: 0.5, color: '#1f2d26' },
        },
        hovertemplate:
          '%{text}<br>Growth %{x:.2f}%<br>Income $%{y:.0f}<br><extra></extra>',
      },
    ],
    {
      title: { text: 'Growth vs Income Distribution', font: { size: 13 } },
      margin: { t: 34, r: 16, b: 38, l: 52 },
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      xaxis: { title: 'Population Growth 1Y (%)', gridcolor: '#e5ece8' },
      yaxis: { title: 'Median Household Income ($/week)', gridcolor: '#e5ece8' },
      showlegend: false,
      font: { family: 'Source Sans 3, sans-serif', size: 11 },
    },
    { displayModeBar: false, responsive: true },
  );
}

function refresh() {
  applyFilters();
  updateMapData();
  updatePolygonLayer();
  renderLegend();
  renderSnapshot();
  renderSelectedCatchment();
  renderCharts();
}

function bindEvents() {
  el.stateSelect.addEventListener('change', () => {
    state.selectedState = el.stateSelect.value;
    refresh();
  });

  el.metricSelect.addEventListener('change', () => {
    state.selectedMetric = el.metricSelect.value;
    updateColorStyling();
    renderLegend();
    renderSnapshot();
    renderSelectedCatchment();
  });

  el.dpaFilter.addEventListener('change', () => {
    state.dpaFilter = el.dpaFilter.value;
    refresh();
  });

  el.searchInput.addEventListener('input', () => {
    state.query = el.searchInput.value;
    refresh();
  });

  el.showPolygons.addEventListener('change', () => {
    state.showPolygons = el.showPolygons.checked;
    updatePolygonLayer();
  });

  el.resetView.addEventListener('click', () => {
    state.selectedState = 'ALL';
    state.dpaFilter = 'ALL';
    state.query = '';
    el.stateSelect.value = 'ALL';
    el.dpaFilter.value = 'ALL';
    el.searchInput.value = '';

    if (state.map) {
      state.map.easeTo({ center: [134.5, -25.7], zoom: 3.2, duration: 700 });
    }

    refresh();
  });
}

async function init() {
  try {
    setLoading('Loading dataset...', 15);

    const [dataset] = await Promise.all([
      fetchJson('./data/healthcare-access-dataset.json'),
    ]);

    state.dataset = dataset;
    state.filteredRows = dataset.catchments;

    setLoading('Preparing controls and map...', 40);
    initSelectors();
    renderSourceList();
    bindEvents();
    initMap();

    applyFilters();
    renderLegend();
    renderSnapshot();
    renderSelectedCatchment();
    renderCharts();
    setLoading('Loading interactive map...', 65);
  } catch (error) {
    setLoading(`Failed to initialize app: ${error.message}`, 100);
    if (el.coverageLine) {
      el.coverageLine.textContent = 'Data load failed. Check console for details.';
    }
    // eslint-disable-next-line no-console
    console.error(error);
  }
}

init();
