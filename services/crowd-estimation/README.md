# Crowdy crowd estimation

An independent Python 3.12 / FastAPI service that estimates crowd size in still
images and sampled live-camera frames. The default ZIP-N density model estimates
large, wide-view crowds; an explicit YOLO26n mode returns individual detected
people. It has its own dependencies, process, Docker
image, Azure Container App, and server-to-server token. It has no dependency on
JuPedSim, floor-plan extraction providers, or workspace storage.

## Run locally

From this directory, with [uv](https://docs.astral.sh/uv/) installed:

```sh
uv sync --frozen
uv run python -m app.download_model
cp -n .env.example .env
# Replace the example token in .env with a random secret, then:
uv run uvicorn app.main:create_app --factory --env-file .env --host 127.0.0.1 --port 8001 --workers 1
```

Keep an existing `.env` file. Model downloads happen only
during the explicit setup step. Runtime startup fails if weights are missing,
loads one selected model and warms it before
readiness succeeds. The default setup downloads an author-published ZIP-N
checkpoint pinned by revision, size and SHA-256. It never executes downloaded
Python, uses a fixed reviewed architecture and `torch.load(weights_only=True)`,
and strictly validates the tensor state. Weights and local credentials are ignored by Git.
Explicit YOLO mode verifies that COCO class 0 is `person`.
Ultralytics dependency auto-installation is disabled for every service entry
point, including local runs. Install dependencies with `uv sync`; the explicit
model setup command downloads only the requested weights.

Set these **server-only** values in `frontend/.env.local`, then restart Next.js:

```dotenv
CROWDY_CROWD_ESTIMATION_URL=http://127.0.0.1:8001
CROWDY_CROWD_ESTIMATION_TOKEN=the-same-secret-as-the-service
```

The browser submits prepared PNG/JPEG/WebP images to `/api/crowd-estimates`.
Next.js forwards multipart bytes and the bearer token to this service. The
browser preparation limits the image to 3 MiB and 4096 pixels on the longest side
to fit Vercel. The service independently checks the stream, file size, actual
image format, animation, decompression size, and EXIF orientation. It never
stores original uploads or annotated images. Live sessions retain only their
latest estimate and a small JPEG preview in memory. The workspace source-storage
flow remains responsible for saved images.
Upload decoding keeps Pillow's original PNG/JPEG/WebP decoder, so importing
Ultralytics cannot activate its optional HEIF plugin fallback for corrupt input.
Unreadable images return 422 after the model has loaded as well as before.

## API

`POST /v1/estimates` takes exactly one multipart file field named `image`, with
`Content-Type` `image/png`, `image/jpeg`, or `image/webp`. Supply
`Authorization: Bearer <service token>`. No URL, path, or video-file inputs
are accepted. Maximum file size is 10 MiB; maximum decoded area is 30 million
pixels. The request stream has a separate 64 KiB multipart allowance.

Set `CROWDY_CROWD_ESTIMATION_TOKEN` in the client terminal to the same secret
configured in the server's `.env` before making this request:

```sh
curl --fail-with-body http://127.0.0.1:8001/v1/estimates \
  -H "Authorization: Bearer $CROWDY_CROWD_ESTIMATION_TOKEN" \
  -F 'image=@crowd.jpg;type=image/jpeg'
```

Default response (illustrative density estimate):

```json
{
  "estimate_id": "2f529b8ec69a47b39bd9adf5d75d2cbb",
  "method": "density",
  "count": 6052,
  "density_count": 6052.25,
  "detections": [],
  "image": {"width": 2560, "height": 1920},
  "model": "zip-n-nwpu.pth",
  "processing_ms": 560.0,
  "warnings": ["Density estimates are not verified attendance counts."],
  "inference": {"strategy": "whole", "tiles_processed": 1, "tiles_planned": 1,
    "max_detections": 10000, "truncated": false, "complete": true}
}
```

`method: "density"` returns the raw nonnegative model density sum in
`density_count`. `count` is `floor(density_count + 0.5)`, capped at the configured
10000 limit. There are no individual person boxes, and none are fabricated.
The model's original density cells are summed directly; interpolating a display
map or summing overlapping density tiles would change mass and is not used.
The whole view is aspect-preserved, enlarged to a minimum 896-pixel edge when
needed, and bounded to 4096 pixels on the longest edge / 10 million pixels for
inference. Original image dimensions remain the API coordinate frame.

Explicit detection mode uses `CROWDY_COUNT_METHOD=detections` and requires
`uv run python -m app.download_model --model yolo26n.pt`. Example response:

```json
{
  "estimate_id": "2f529b8ec69a47b39bd9adf5d75d2cbb",
  "count": 1,
  "method": "detections",
  "detections": [{"confidence": 0.91, "bbox": [10.0, 12.0, 100.0, 220.0]}],
  "image": {"width": 640, "height": 480},
  "model": "yolo26n.pt",
  "processing_ms": 148.2,
  "warnings": ["Counts include visible detected people only; occluded or small people may be missed."],
  "inference": {"strategy": "whole", "tiles_processed": 1, "tiles_planned": 1,
    "max_detections": 10000, "truncated": false, "complete": true}
}
```

`bbox` contains `[x1, y1, x2, y2]` in pixels of the EXIF-oriented input, measured
from the top-left. For `method: "detections"` (also the meaning when older
responses omit `method`), `count` equals the number of returned person detections;
zero is valid. `confidence` describes a detection, not the statistical
confidence of the total count. Density mode has no per-person confidence.
`processing_ms` measures inference and result
conversion, excluding upload and decoding. `/docs` and `/openapi.json` describe
the contract and bearer authentication.

`inference.complete` is false if the time budget prevents a full scan or a
tile/output count cap is reached. Such counts must not automatically set forecast
occupancy. `truncated` specifically indicates a detection cap. `tiles_planned`
includes the overview pass when tiled inference is used. Older compatible
clients may omit `inference`; this service includes it in every actual result.
`complete: true` means processing completed within configured limits; it is
not a confidence interval or an accuracy guarantee. Density can overcount or
undercount even when the image was fully processed.

Errors use `{"error": "message"}`: 400 for malformed uploads, 401 for missing or
invalid credentials, 413 for oversized uploads, 415 for unsupported media,
422 for unreadable/mismatched/animated/overlarge decoded images or excessive tile
requirements, 500 for failed
inference, and 503 with `Retry-After` while not ready or busy. One request at a
time is admitted per process, including decoding. Excess requests fail promptly;
they do not accumulate an unbounded inference queue. `/healthz` is an anonymous
liveness check and `/readyz` confirms that weights have loaded and warmed.

### Live camera sessions

Live mode samples images from the phone's browser camera. It does not accept or
record a continuous video stream. The trusted Next.js server creates a session
and proxies its requests; the service bearer must never reach the phone/browser.
Phone camera access requires a secure HTTPS origin (localhost is the browser's
local exception). An iPhone cannot reach the developer computer through a
`localhost` link; use the application's reachable HTTPS URL.

All endpoints below require the same service `Authorization` header. Every
session operation also requires `X-Crowdy-Live-Token` with the role shown:

| Method and path | Live token | Result |
| --- | --- | --- |
| `POST /v1/live-sessions` | None | 201, `{session_id, viewer_token, camera_token, expires_at}`. |
| `GET /v1/live-sessions/{id}` | Viewer | Current snapshot. |
| `DELETE /v1/live-sessions/{id}` | Viewer | 204, immediately revokes both capabilities and discards state. |
| `POST /v1/live-sessions/{id}/frames` | Camera | One multipart `image`, returning the updated snapshot. |
| `POST /v1/live-sessions/{id}/pause` | Camera | Marks the session paused, keeping its last completed estimate. |

Session IDs are random 32-character hexadecimal strings. Viewer and camera
tokens are separate random 256-bit capabilities; keep them private and send them
in the header, never in a query string. The service retains their SHA-256 digests
and compares them in constant time. A camera token cannot read/delete a session;
a viewer token cannot submit/pause frames. Missing/wrong capabilities return 401.
Missing, deleted, or expired sessions return 404, and every response uses
`Cache-Control: no-store`. Credentials are returned only by creation.

A snapshot contains:

```json
{
  "session_id": "2f529b8ec69a47b39bd9adf5d75d2cbb",
  "expires_at": "2026-01-01T00:30:00Z",
  "sequence": 0,
  "updated_at": null,
  "estimate": null,
  "preview": null,
  "status": "waiting"
}
```

The first successful frame sets `status` to `live`, fills `estimate` with the
same result as `/v1/estimates`, and fills `preview` with a JPEG data URL.
`sequence` increases on each accepted frame and pause. `updated_at` is the server
admission time of the latest accepted frame, so slow inference does not make
an old image appear newly captured. A pause invalidates frames already
in flight; their completion returns the unchanged paused snapshot. A newly
submitted frame resumes live status. Deletion or expiry during inference causes
that frame to return 404 and never recreates the session. Counts are per-frame
visible detections; successive counts must never be summed as unique attendees.

Live and still-image requests share one inference slot, including upload,
decoding, and preview preparation. A busy caller receives 503 / `Retry-After: 2`
without queueing. The phone should submit at most one frame at a time and respect
backpressure. Frames use the same format, upload, pixel, EXIF, and animation
checks as the still-image endpoint. The retained preview has a maximum 640-pixel
edge, JPEG quality 70, no source metadata, and at most 256 KiB before base64;
high-detail frames are further resized if needed. Only the latest result is
retained; there are no recordings, image history, or persisted frame files.

At most 16 sessions may be active. Creation at capacity returns 503 with
`Retry-After: 30`. Each session expires exactly 30 minutes after creation;
polling, frames, and pauses do not extend its lifetime. Expired sessions are
lazily removed when the next session operation occurs. Shutdown clears all
session state, and a process restart requires new camera links.

**Live sessions require one Uvicorn worker and exactly one service replica.**
Session capabilities and previews are held in that process's memory; requests
routed to another process cannot find them. Set
`crowd_estimation_min_replicas = 1` and `crowd_estimation_max_replicas = 1` before
deploying live mode. Horizontal scaling requires a shared session store and
coordinated inference/session lifecycle first. The service bearer remains a
server-to-server credential, not per-user authentication; the frontend must
restrict who may create sessions according to its application access model.

## Inference settings

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `CROWDY_CROWD_ESTIMATION_TOKEN` | Required | Separate secret shared only with Next.js. |
| `CROWDY_COUNT_METHOD` | `density` | Explicit `density` (ZIP-N wide-crowd estimates) or `detections` (YOLO boxes); no silent fallback. |
| `CROWDY_DENSITY_MODEL` | `models/zip-n-nwpu.pth` | Pinned official NWPU ZIP-N checkpoint; startup verifies SHA-256. |
| `CROWDY_DENSITY_MIN_SIZE` | `896` | Minimum density input edge, 320–1024. Author's NWPU checkpoint uses 896. |
| `CROWDY_DENSITY_MAX_SIZE` | `4096` | Maximum density input edge, 1024–4096; 10MP tensor budget also applies. |
| `CROWDY_YOLO_MODEL` | `models/yolo26n.pt` | Trusted local COCO-compatible detection weights. |
| `CROWDY_YOLO_DEVICE` | `cpu` | Device passed to Ultralytics; the container installs CPU PyTorch. |
| `CROWDY_YOLO_THREADS` | `2` | PyTorch and OpenCV CPU threads. |
| `CROWDY_YOLO_CONFIDENCE` | `0.25` | Minimum person confidence. |
| `CROWDY_YOLO_IOU` | `0.45` | Person NMS IoU within each model pass. |
| `CROWDY_YOLO_IMAGE_SIZE` | `1280` | Network inference size per tile, multiple of 32 between 320 and 2048. |
| `CROWDY_YOLO_MAX_DETECTIONS` | `10000` | Response count limit for either method, configurable 1–10000. Density retains the raw sum above this cap. Capacity is not measured recall. |
| `CROWDY_YOLO_TILE_SIZE` | `640` | Source-pixel crop edge, multiple of 32 between 320 and 2048. |
| `CROWDY_YOLO_TILE_OVERLAP` | `0.2` | Adjacent tile overlap, 0.1–0.5. |
| `CROWDY_YOLO_MAX_TILES` | `128` | Total inference passes including overview, configurable 1–256; excessive requests return 422 before inference. |
| `CROWDY_YOLO_INFERENCE_SECONDS` | `25` | Frame time budget, checked between native model calls; unfinished scans return explicit partial results. |
| `CROWDY_MAX_IMAGE_BYTES` | `10485760` | Maximum upload bytes; may be lowered. |
| `CROWDY_MAX_IMAGE_PIXELS` | `30000000` | Maximum decoded image pixels; may be lowered. |

The lockfile pins dependencies. Linux uses the PyTorch CPU wheel index so the
Azure image does not install CUDA runtimes. The Dockerfile bakes the default
weights into `/srv/crowdy/models/`, runs as an unprivileged user, and starts one
Uvicorn worker. Do not increase worker count or replica count while using live
sessions. Still-only deployments can scale separately, budgeting another model's
memory for each worker/replica.

In explicit YOLO mode, dense views use overlapping source-pixel tiles rather than shrinking the entire
crowd into one model input. Each source position belongs to one tile core;
cross-tile IoU suppression removes duplicate boxes from seam jitter without
merging same-tile people. A full-image overview preserves close-up people larger
than a tile. The model uses its one-to-many/NMS head explicitly, avoiding the
NMS-free one-to-one head's typical 300-output budget. Each pass is capped at
1000 detections and the merged response at 10000. Reaching either cap marks the
result incomplete. A native inference call already running can finish after the
time budget; calls are not interrupted unsafely. Smaller tiles improve detail
at the cost of more passes, latency, and seams. Tiling cannot recover details
absent from a wide-view camera image.

```sh
docker build --platform linux/amd64 -t crowdy-crowd-estimation:local .
docker run --rm -p 8001:8001 \
  --env-file .env crowdy-crowd-estimation:local
```

See [Azure infrastructure](../../infra/README.md) for the separate opt-in deploy
script, probes, scaling, frontend environment outputs, and credentials.

## Validation and limits

```sh
uv run python -m unittest discover -s tests -v
```

Tests use fake model outputs to exercise HTTP validation, concurrency,
live-session roles/lifecycle/expiry, bounded previews, and count/coordinate
conversion without downloading weights. Validate actual
accuracy separately against labeled photos from the deployment's cameras,
lighting, angles, and crowd densities. Dense crowds, occlusion, tiny people,
reflections, and repeated views can cause undercounts or false positives.
Neither method measures people outside the frame or provides calibrated
population intervals. Review the estimate
before using it for a simulation. The UI applies the largest usable count across
current photos, never their sum. Venue capacity is a separately configured
operating limit, not an inferred count or a detector accuracy guarantee.

Actual model validation is recorded in [the benchmark report](benchmarks/README.md),
including all six selected UCF-QNRF scenes with 5387–12865 labeled people. ZIP-N
estimated 6337 for 6052 labeled people and 7101 for 7930; other selected scenes
showed errors as large as 49.5%. These are illustrative cross-dataset tests,
not a deployment-wide accuracy claim. Low resolution, extreme congestion and
new camera domains remain material limitations. A wide camera view should use
the highest available source detail; digital enlargement cannot restore missing
head detail. Validate labeled frames from the actual venue before treating
estimates as operational attendance.

Run actual local evaluation without uploading images:

```sh
uv run --env-file .env python -m app.benchmark /path/to/crowd.jpg
uv run --env-file .env python -m app.benchmark --ucf-labels /path/to/img_0727.jpg
```

`CrowdEstimator.estimate(frame)` accepts a decoded PIL frame independently of
HTTP and storage. Live sessions reuse it with bounded sampling and backpressure.
Tracking/line-crossing counts, temporal smoothing, and unique attendees require
their own state and semantics; adding per-frame totals would count the same
people repeatedly. The phone streams sampled frames through its browser; this
service does not open camera connections or implement a media-stream protocol.

Implementation references: [Ultralytics predict API](https://docs.ultralytics.com/modes/predict/)
and [shared-model thread safety](https://docs.ultralytics.com/guides/yolo-thread-safe-inference/),
[YOLO26 heads](https://docs.ultralytics.com/models/yolo26/), and
[sliced inference](https://docs.ultralytics.com/guides/sahi-tiled-inference/).
Ultralytics distributes its package and weights under its
[AGPL-3.0 / Enterprise licensing options](https://www.ultralytics.com/license).
ZIP-N is provided by the authors under MIT; see
[third-party notices](THIRD_PARTY_NOTICES.md) for attribution, source revision,
checkpoint provenance, and the license text.
