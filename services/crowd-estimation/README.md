# Crowdy crowd estimation

An independent Python 3.12 / FastAPI service that counts detected people in still
images using Ultralytics YOLO26n. It has its own dependencies, process, Docker
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
stores uploads or annotated images. The workspace source-storage flow remains
responsible for saved images.

## API

`POST /v1/estimates` takes exactly one multipart file field named `image`, with
`Content-Type` `image/png`, `image/jpeg`, or `image/webp`. Supply
`Authorization: Bearer <service token>`. No URL, path, camera, or video inputs
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
Uvicorn worker. Do not increase worker count without budgeting another model's
memory. Scale the independent service using Container Apps replicas.

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

Tests use fake model outputs to exercise HTTP validation, concurrency, and
count/coordinate conversion without downloading weights. Validate actual
accuracy separately against labeled photos from the deployment's cameras,
lighting, angles, and crowd densities. Dense crowds, occlusion, tiny people,
reflections, and repeated views can cause undercounts or false positives.
This is a visible-person detection baseline; it does not infer people outside
the frame or provide calibrated population intervals. Review the estimate
before using it for a simulation. The UI applies the largest count across
current photos, never their sum; zero and counts above its 200-person simulation
limit remain visible and require manual adjustment.

`CrowdEstimator.estimate(frame)` accepts a decoded PIL frame independently of
HTTP and storage. A later video worker can reuse it with frame timestamps,
bounded sampling/backpressure, and temporal smoothing. Tracking/line-crossing
counts and unique attendees require their own state and semantics; adding
per-frame totals would count the same people repeatedly. No streaming endpoint
or camera connection is implemented in this still-image version.

Implementation references: [Ultralytics predict API](https://docs.ultralytics.com/modes/predict/)
and [shared-model thread safety](https://docs.ultralytics.com/guides/yolo-thread-safe-inference/).
Ultralytics distributes its package and weights under its
[AGPL-3.0 / Enterprise licensing options](https://www.ultralytics.com/license).
