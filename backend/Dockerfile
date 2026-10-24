# Build for linux/amd64: JuPedSim 1.4.2 publishes its Linux wheel for x86-64.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /srv/crowdy

# JuPedSim's native wheel needs the C++ runtime; no compiler is required.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --only-binary=:all: -r requirements.txt

COPY app ./app
RUN useradd --create-home --uid 10001 crowdy \
    && mkdir -p /srv/crowdy/data/editor \
    && chown -R crowdy:crowdy /srv/crowdy/data
USER crowdy

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn app.api:app --host 0.0.0.0 --port \"${PORT:-8000}\""]
