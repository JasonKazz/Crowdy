# Crowdy
Interactive evacuation planning from furnished floor plans, with editable layouts, scenario-based occupancy, crowd simulation, and before-and-after comparisons. Built at Cal Hacks 13.0.

## Frontend

Live demo: https://crowdy-calhacks13.vercel.app

The Next.js app lives in `frontend/` and uses TypeScript, Tailwind CSS, ESLint, and the App Router. Use Node.js 20.9 or newer.

Auth0 provides sign-in, account creation, and sign-out. For local setup, configure the ignored `frontend/.env.local` using `frontend/.env.example` and the instructions in [frontend/README.md](frontend/README.md). Keep an existing onboarding-generated environment file.

The home page uses one workspace list. Berkeley studio appears for everyone with a **Sample** tag, alongside personal workspaces for signed-in users. Personal workspaces are saved per account in the current browser; the shared sample always opens with its original layout. Workspaces include furniture editing, scenario controls, playback, density overlays, and baseline comparisons. The simulation is an illustrative browser-local model; backend analysis and image/PDF interpretation are not connected yet.

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:3000. Run `npm run lint` to check the code and `npm run build` to create a production build.

## Backend structure

```text
backend/app/
├── api/
├── schemas/
├── services/
│   ├── floorplans/
│   ├── population/
│   ├── scenarios/
│   └── analysis/
├── simulation/
├── worker/
└── storage/
examples/
docs/
```

The backend directories currently contain `.gitkeep` placeholders.

## Local configuration

Copy `.env.example` to `.env` in the repository root and update it locally. `.env` files, credentials, uploads, local databases, and generated results are ignored by Git. Commit only placeholder values in `.env.example`.

The environment variables are proposed configuration for the backend; configuration loading is not implemented yet. Data paths are relative to `backend/`. The future backend must explicitly load the root `.env` or receive these values through its deployment environment.
