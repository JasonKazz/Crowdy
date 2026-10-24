# Build for linux/amd64: JuPedSim 1.4.2 publishes its Linux wheel for x86-64.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/srv/crowdy/.venv/bin:$PATH" \
    PORT=8000

WORKDIR /srv/crowdy

# JuPedSim's native wheel needs the C++ runtime; no compiler is required.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.22 /uv /uvx /bin/
COPY pyproject.toml uv.lock ./
# The lock excludes JuPedSim's desktop-only Qt/VTK dependencies.
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app
RUN useradd --create-home --uid 10001 crowdy \
    && mkdir -p /srv/crowdy/data/editor \
    && chown -R crowdy:crowdy /srv/crowdy/data
USER crowdy

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn app.api:app --host 0.0.0.0 --port \"${PORT:-8000}\""]
