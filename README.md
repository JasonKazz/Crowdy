# Crowdy
Interactive evacuation planning from furnished floor plans, with editable layouts, scenario-based occupancy, crowd simulation, and before-and-after comparisons. Built at Cal Hacks 13.0.

## Frontend

Live demo: https://crowdy-calhacks13.vercel.app

The Next.js app lives in `frontend/` and uses TypeScript, Tailwind CSS, ESLint, and the App Router. Use Node.js 20.9 or newer.

Auth0 provides sign-in, account creation, and sign-out. For local setup, configure the ignored `frontend/.env.local` using `frontend/.env.example` and the instructions in [frontend/README.md](frontend/README.md). Keep an existing onboarding-generated environment file.

The home page uses one workspace list. Berkeley studio appears for everyone with a **Sample** tag, alongside personal workspaces for signed-in users. Personal workspaces are saved per account in the current browser; the shared sample always opens with its original layout. Workspaces include furniture editing, scenario controls, playback, density overlays, and baseline comparisons. Runs use the Python JuPedSim backend through a same-origin Next.js API. Image/PDF floor-plan interpretation is not connected.

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:3000. Run `npm run lint` to check the code and `npm run build` to create a production build.

## Backend

Use Python 3.12. From the repository root, create a local environment and start the FastAPI service:

```sh
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cd backend
.venv/bin/python -m uvicorn app.api:app --host 127.0.0.1 --port 8000
```

Run the frontend in a second terminal. During development, its API defaults to `http://127.0.0.1:8000`. Override this with `CROWDY_BACKEND_URL` in `frontend/.env.local` when needed. Both processes must be running for simulations.

| Frontend endpoint | Backend endpoint | Purpose |
| --- | --- | --- |
| `GET /api/simulations` | `GET /health` | Check the simulation service |
| `POST /api/simulations` | `POST /api/simulations` | Run an editor `{ plan, scenario }` snapshot |

The frontend proxy validates the editor request and forwards it to FastAPI. The backend converts canvas geometry to meters, generates the population, and runs JuPedSim's Collision Free Speed Model. Playback uses returned trajectory timestamps and evacuation events. A time-limited run reports people remaining and no clearance time; it is not a completed evacuation. These model results are not a safety assessment.

```text
backend/app/
├── api/
├── schemas/
├── services/
│   └── population/
└── simulation/
examples/
docs/
```

## Local configuration

Next.js loads `frontend/.env.local`. The Python service reads its process environment; it does not automatically load the repository's `.env`. The root `.env.example` is a template for container or hosting configuration. An optional `CROWDY_BACKEND_TOKEN` must have the same value on the Python service and the Next.js server; the proxy sends it as a bearer token. Keep this token and `CROWDY_BACKEND_URL` server-side, without a `NEXT_PUBLIC_` prefix.

Environment files, credentials, uploads, local databases, and generated results are ignored by Git. Commit only placeholders.

## Local simulation

From `backend/`, with its Python 3.12 environment activated:

```bash
python -m app.simulation.run_example ../examples/two_exit_room.json
python -m app.simulation.animate data/two_exit_room_result.json
open data/two_exit_room_animation.html
python -m unittest discover -s tests -v
```

The original `simple_room.json` and commands without arguments still work. Results and HTML are written to the ignored `backend/data/` directory, with names based on the input file.

A scenario supplies either explicit `occupants` or `population` settings. The latter contains `count`, `seed`, and `spawn_area_ids` referencing walkable-area IDs. Placement is uniform within the selected connected area, excluding furniture and exit zones, with clearance between bodies and boundaries. It does not infer activities or seating. The saved result includes the resolved starting positions and the generation settings.

Agents choose an exit once, by shortest routed distance to an interior target point in each exit zone. This accounts for obstacles but does not optimize for congestion or dynamically change destinations. The result records initial `assignments`, departure `evacuations`, and `summary.per_exit_counts`. `clearance_time` is null if anyone remains at the time limit.

The example uses meters, with x increasing right and y increasing up. The current geometry validator requires one connected walkable polygon; population placement also requires one connected spawn polygon.

## Deployment

The frontend is deployed separately to Vercel; see [frontend/README.md](frontend/README.md#deploy-to-vercel). A hosted backend URL has not been configured by this change. Production simulations require a reachable Python service and the server-only `CROWDY_BACKEND_URL` setting in Vercel. Set the same optional `CROWDY_BACKEND_TOKEN` on both services.

The backend includes a Python 3.12 Docker image using published native wheels. Use Linux x86-64: [JuPedSim 1.4.2](https://pypi.org/project/jupedsim/1.4.2/#files) publishes a CPython 3.12 Linux wheel for that architecture. From the repository root:

```sh
docker build --platform linux/amd64 -t crowdy-backend backend
docker run --platform linux/amd64 --rm -p 8000:8000 crowdy-backend
```

The container listens on `0.0.0.0:${PORT:-8000}` and supports `--env-file .env` for local configuration. A Python web-service host can instead install `backend/requirements.txt` and run `uvicorn app.api:app --host 0.0.0.0 --port "$PORT"` from `backend/` ([Render's FastAPI guide](https://render.com/docs/deploy-fastapi)). Keep the backend private or configure its shared token when exposing it publicly. The browser communicates with the Next.js origin, so a separate browser CORS allowlist is not required for this proxy setup.
