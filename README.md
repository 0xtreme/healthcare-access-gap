# Healthcare Access Gap (Australia)

Australia-wide interactive map to identify potential healthcare service opportunity areas using public data.

## Data Sources (official/public)

- Department of Health and Aged Care: General Practitioner Catchments (GPC) 2023
- Department of Health and Aged Care: Distribution Priority Area (DPA) for GPs 2025
- ABS Data API: Census 2021 G02 SA2 medians (age and incomes)
- ABS Data API: Annual ERP (population and growth by SA2)
- ABS Data API: SEIFA 2021 SA2 (IRSD)
- ABS Geo API: ASGS 2021 SA2 boundaries

## Build

```bash
npm install
npm run build
```

Outputs are written to:

- `data/processed/`
- `public/data/`
- `docs/data/` (for GitHub Pages)

## Local Preview

```bash
python3 -m http.server 8080
```

Then open: `http://127.0.0.1:8080/public/`
