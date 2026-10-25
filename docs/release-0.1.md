# Crowdy 0.1.0 — POFA demo

Release version: `0.1.0`; Git tag: `v0.1.0`. Application versions are independent
of the JuPedSim engine (`1.4.2`) and stored layout/schema versions.

## Demo flow

1. Open the deployed workspace, choose **Replace floor plan → Load verified POFA demo**.
   This uses the reviewed JSON, 15 mapped exits, saved calibration and a 24-person
   starting scenario. The saved 100 m reference is a demo measurement, not an
   independently surveyed building dimension. Fresh AI extraction remains a draft
   requiring geometry review.
2. POFA capacity is **5,000**. Analysis accepts **1–10,000** people and shows a
   separate capacity warning above 5,000. The count limit does not assert that
   10,000 bodies physically fit this floor plan.
3. Open **Live analytics**, connect the iPhone with its private QR link, allow the
   rear camera, and keep the phone page visible. Use an elevated, stable, wide
   view of the whole crowd, as planned for this demo. A partial view cannot
   represent the venue's total occupancy. Links expire after 30 minutes; create
   a new link after a service restart or deployment.
4. The camera sends one still frame at a time, preserving up to 4K detail within
   the hosting upload budget. **Density** denotes a model estimate, with no
   fabricated individual boxes. Counts are per frame, never summed over time.
5. Automatic forecasts use fresh, complete camera estimates and the saved layout.
   A three-frame median reduces count jitter. Forecasts are serial, with changes
   queued at least 10 seconds apart. Paused, stale, partial and capped estimates
   cannot start a forecast. An unchanged count does not trigger duplicate work.

## Dense counting evidence

The default is the author's pretrained **ZIP-N NWPU** density model; the
[model source](https://github.com/Yiming-M/ZIP) and
[official checkpoint](https://huggingface.co/Yiming-M/ZIP-N) are pinned, with
SHA-256 verified at build and startup. No external model code is executed.
YOLO remains an explicit alternative for person boxes, not an automatic fallback.

Actual CPU inference on six selected, originally labeled UCF-QNRF images:

| Labeled people | Raw rounded estimate | Relative error |
| ---: | ---: | ---: |
| 5,387 | 2,722 | −49.5% |
| 6,052 | 6,337 | +4.7% |
| 7,930 | 7,101 | −10.5% |
| 10,274 | 8,297 | −19.2% |
| 12,672 | 14,001 | +10.5% |
| 12,865 | 8,072 | −37.3% |

These selected scenes establish real dense-crowd operation above 5,000 people,
not a representative accuracy study or an exact 10,000-person guarantee.
Camera domain, lighting, occlusion and image detail matter substantially.
The 14,001 estimate returns public count 10,000 with `truncated: true` and
`complete: false`; the raw density estimate is retained and auto-forecast is
blocked. `complete: true` describes processing, not counting accuracy.
The supplied POFA photos have no labeled attendance, so their counts cannot
establish POFA accuracy. See the [full benchmark evidence and reproduction
instructions](../services/crowd-estimation/benchmarks/README.md).

## Forecast execution and limits

Native JuPedSim simulates every requested person. No population sampling or
clearance-time extrapolation is used. Large jobs return immediately and are
polled through the frontend; cancellation stops server work. Playback is
temporally thinned to fit the response budget, retaining all people, actual
first/final positions and departure events. Large playback begins paused.

Measured locally with the verified POFA layout, normal placement, seed 42 and
0.46 m body width:

| People | Wall time | Result |
| ---: | ---: | --- |
| 200 | 1.02 s | All evacuated; 29.59 simulated seconds |
| 500 | 3.37 s | All evacuated; 39.80 simulated seconds |
| 1,000 | 13.05 s | All evacuated; 65.46 simulated seconds |
| 5,000 | 120.13 s | Runtime limit; 1,248 evacuated, 3,752 still moving |

The 5,000-person run retained every person in a 2.30 MB response and used about
104 MB peak RSS. Its recorded duration was 29.56 simulated seconds, **not** a
complete evacuation time. The UI reports **Incomplete**, remaining people and
the time limit. Complete forecasts at this density need further engine/runtime
work. A continuous fresh camera feed is required while a long live job runs.

The actual Azure deployment was also tested through Vercel's public proxy.
The 24-person POFA run completed in 24.71 simulated seconds with 24 actual
door crossings. The 5,000-person job returned in 124.52 wall seconds, retaining
all 5,000 people in a 2.03 MB payload. It reached its 120-second processing
limit after 12.38 simulated seconds: 505 evacuated, 4,495 still moving,
zero trapped, and no complete clearance time. Deployment hardware is slower
than the local benchmark, so this production result is the relevant demo limit.

The backend has a 120-second native work budget; browser job transport has a
180-second deadline. A density inference call is not forcibly interrupted:
the 25-second service budget invalidates late results after the native call
returns. Input dimensions and one admission slot bound its work and memory.

## Infrastructure and release checks

Vercel serves the frontend; Azure Container Apps runs one warm backend process
and one warm density service process, each allocated 2 vCPU / 4 GiB. Workspace
records and source images persist in private Azure Blob Storage. Jobs and camera
sessions are in memory, so deployment interrupts them. Multiple workers or
replicas are unsupported until shared state is implemented.

The resource allocation is intended for the demo. At the rates recorded in the
[infrastructure guide](../infra/README.md), both apps project about $127/month
including ACR when entirely idle, or $433/month continuously active, before
additional storage/build/network charges. The existing $40 alerts do not cap
spending; reduce resources after the demo if this headroom is no longer needed.

Release checks:

```sh
python3 scripts/check-release.py
cd backend && .venv/bin/python -m unittest discover -s tests
cd ../services/crowd-estimation && uv run python -m unittest discover -s tests
cd ../../frontend && npm run build
```

Run frontend contract scripts, native HTTP integration, infrastructure checks,
and deployed health/auth/storage/live-frame smoke checks as well. A real iPhone
must still be paired at the venue to check its permissions, view and network;
browser/API smoke tests do not certify that physical camera setup.
