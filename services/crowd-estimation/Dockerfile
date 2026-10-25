# Build with linux/amd64 for the Azure Consumption deployment.
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/srv/crowdy/.venv/bin:$PATH" \
    PORT=8001 \
    CROWDY_YOLO_MODEL=/srv/crowdy/models/yolo26n.pt \
    CROWDY_YOLO_DEVICE=cpu \
    CROWDY_COUNT_METHOD=density \
    CROWDY_DENSITY_MODEL=/srv/crowdy/models/zip-n-nwpu.pth \
    YOLO_AUTOINSTALL=false \
    YOLO_CONFIG_DIR=/tmp/ultralytics \
    MPLCONFIGDIR=/tmp/matplotlib

WORKDIR /srv/crowdy
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9.22@sha256:2320e6c239737dc73cccce393a8bb89eba2383d17018ee91a59773df802c20e6 /uv /uvx /bin/
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,id=crowdy-estimation-uv,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY app ./app
COPY THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
# Bake weights into the image. Startup and inference need no model downloads.
RUN chmod -R u=rwX,go=rX app \
    && python -m app.download_model --output models \
    && python -m app.download_model --model yolo26n.pt --output models \
    && chmod -R u=rwX,go=rX models \
    && useradd --create-home --uid 10001 crowdy \
    && rm -rf /tmp/ultralytics /tmp/matplotlib
USER crowdy
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=3s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/readyz', timeout=2)"
CMD ["sh", "-c", "exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port \"${PORT:-8001}\" --workers 1"]
