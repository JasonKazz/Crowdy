# Crowdy crowd estimation

An independent Python 3.12 / FastAPI service that counts detected people in still
images and sampled live-camera frames using Ultralytics YOLO26n. It has its own dependencies, process, Docker
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
loads one model, verifies class 0 is `person`, and warms the predictor before
readiness succeeds. Weights and local credentials are ignored by Git.
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
existing browser preparation limits the image to 3 MiB and 3072 pixels per side
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

Example response (one illustrative detection):

```json
{
  "estimate_id": "2f529b8ec69a47b39bd9adf5d75d2cbb",
  "count": 1,
  "detections": [{"confidence": 0.91, "bbox": [10.0, 12.0, 100.0, 220.0]}],
  "image": {"width": 640, "height": 480},
  "model": "yolo26n.pt",
  "processing_ms": 148.2,
  "warnings": ["Counts include visible detected people only; occluded or small people may be missed."]
}
```

`bbox` contains `[x1, y1, x2, y2]` in pixels of the EXIF-oriented input, measured
from the top-left. `count` equals the number of returned person detections;
zero is valid. `confidence` describes a detection, not the statistical
confidence of the total count. `processing_ms` measures inference and result
conversion, excluding upload and decoding. `/docs` and `/openapi.json` describe
the contract and bearer authentication.

Errors use `{"error": "message"}`: 400 for malformed uploads, 401 for missing or
invalid credentials, 413 for oversized uploads, 415 for unsupported media,
422 for unreadable/mismatched/animated/overlarge decoded images, 500 for failed
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
completion time of the latest accepted frame. A pause invalidates frames already
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
| `CROWDY_YOLO_MODEL` | `models/yolo26n.pt` | Trusted local COCO-compatible detection weights. |
| `CROWDY_YOLO_DEVICE` | `cpu` | Device passed to Ultralytics; the container installs CPU PyTorch. |
| `CROWDY_YOLO_THREADS` | `2` | PyTorch and OpenCV CPU threads. |
| `CROWDY_YOLO_CONFIDENCE` | `0.25` | Minimum person confidence. |
| `CROWDY_YOLO_IOU` | `0.45` | NMS IoU for models that use NMS; end-to-end models may ignore it. |
| `CROWDY_YOLO_IMAGE_SIZE` | `1280` | Inference size, multiple of 32 between 320 and 2048. |
| `CROWDY_YOLO_MAX_DETECTIONS` | `1000` | Output limit; the model architecture can impose a lower limit. |
| `CROWDY_MAX_IMAGE_BYTES` | `10485760` | Maximum upload bytes; may be lowered. |
| `CROWDY_MAX_IMAGE_PIXELS` | `30000000` | Maximum decoded image pixels; may be lowered. |

The lockfile pins dependencies. Linux uses the PyTorch CPU wheel index so the
Azure image does not install CUDA runtimes. The Dockerfile bakes the default
weights into `/srv/crowdy/models/`, runs as an unprivileged user, and starts one
Uvicorn worker. Do not increase worker count or replica count while using live
sessions. Still-only deployments can scale separately, budgeting another model's
memory for each worker/replica.

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
This is a visible-person detection baseline; it does not infer people outside
the frame or provide calibrated population intervals. Review the estimate
before using it for a simulation. The UI applies the largest count across
current photos, never their sum; zero and counts above its 200-person simulation
limit remain visible and require manual adjustment.

`CrowdEstimator.estimate(frame)` accepts a decoded PIL frame independently of
HTTP and storage. Live sessions reuse it with bounded sampling and backpressure.
Tracking/line-crossing counts, temporal smoothing, and unique attendees require
their own state and semantics; adding per-frame totals would count the same
people repeatedly. The phone streams sampled frames through its browser; this
service does not open camera connections or implement a media-stream protocol.

Implementation references: [Ultralytics predict API](https://docs.ultralytics.com/modes/predict/)
and [shared-model thread safety](https://docs.ultralytics.com/guides/yolo-thread-safe-inference/).
Ultralytics distributes its package and weights under its
[AGPL-3.0 / Enterprise licensing options](https://www.ultralytics.com/license).
