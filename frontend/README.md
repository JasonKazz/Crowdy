# Crowdy frontend

An editable floor-plan workspace built with Next.js 16.4.3, TypeScript, and Tailwind CSS. Requires Node.js 20.9 or newer.

## Run locally

From `frontend/`:

```sh
npm ci
npm run dev
```

Open http://localhost:3000. Check the code and production build with:

```sh
npm run lint
npm run build
```

## Workspace

Start with the sample studio or import a Crowdy JSON floor plan on a 900 × 600 canvas. Download the sample JSON in the upload dialog for the supported geometry format. Export workspace saves the current layout, scenario, and available result summary as JSON.

Select furniture to drag it, move it with the arrow keys, or edit its coordinates. Adjust occupancy, walking profile, and distribution before running. Inspect playback, routes, and density; pin a run as a baseline to compare a subsequent change.

The illustrative grid model runs in the browser. It uses simplified movement, reaction delays, and exit queues; no backend analysis or image/PDF floor-plan interpretation is connected. Results describe the shown model assumptions and are not a safety assessment.

Layout and scenario persist in browser storage. Runs and baselines remain for the current session. Export the workspace to keep a separate copy.

The model checks run with Node.js 22 or newer:

```sh
npm run test:simulation
```

## Deploy to Vercel

From `frontend/`, with the Vercel CLI authenticated:

```sh
vercel --prod
```

Use the Next.js framework defaults when linking or creating a Vercel project.
