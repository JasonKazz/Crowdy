"""Build a standalone browser playback from a saved simulation result."""

import argparse
import json
from pathlib import Path

from shapely.geometry import Polygon
from shapely.ops import unary_union

from app.schemas.scenario import Scenario
from app.simulation.geometry import build_geometry, region_to_polygon


HTML = r'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Crowdy · Simulation playback</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f3f5f8; color: #172339;
      font-family: system-ui, sans-serif; }
    main { max-width: 1080px; margin: 32px auto; padding: 0 20px; }
    .brand { color: #335cce; font-weight: 750; letter-spacing: .04em; }
    h1 { margin: 12px 0 8px; font-size: clamp(22px, 4vw, 30px); }
    .muted { color: #58677c; font-size: 14px; }
    .card { margin-top: 24px; overflow: hidden; border: 1px solid #dbe1ea;
      border-radius: 16px; background: white; }
    .stats { display: flex; justify-content: space-between; gap: 12px;
      padding: 18px 22px; border-bottom: 1px solid #e7ebf0; flex-wrap: wrap; }
    canvas { display: block; width: 100%; aspect-ratio: 16 / 10; }
    .controls { display: flex; align-items: center; gap: 12px;
      padding: 18px; border-top: 1px solid #e7ebf0; flex-wrap: wrap; }
    button, select { font: inherit; padding: 9px 13px; border-radius: 8px;
      border: 1px solid #cbd4e1; background: white; cursor: pointer; }
    #play { background: #335cce; border-color: #335cce; color: white;
      min-width: 76px; }
    input { flex: 1; min-width: 140px; accent-color: #335cce; }
    .legend { padding: 0 20px 18px; line-height: 1.8; }
    #clock { font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
<main>
  <div class="brand">CROWDY</div>
  <h1 id="title"></h1>
  <div class="muted">Recorded evacuation · one floor</div>
  <section class="card" aria-label="Simulation playback">
    <div class="stats">
      <strong id="counts"></strong>
      <span id="clock"></span>
      <span id="outcome" class="muted"></span>
    </div>
    <canvas id="plan" aria-label="Floor plan and moving occupants"></canvas>
    <div class="controls">
      <button id="play">Play</button>
      <button id="restart">Restart</button>
      <input id="timeline" type="range" min="0" max="10000" value="0"
        step="1" aria-label="Playback timeline">
      <label for="speed">Speed</label>
      <select id="speed">
        <option value="0.25">0.25×</option>
        <option value="0.5">0.5×</option>
        <option value="1" selected>1×</option>
        <option value="2">2×</option>
        <option value="4">4×</option>
      </select>
    </div>
    <div id="exit-counts" class="legend muted"></div>
    <div class="legend muted">Blue: people &nbsp; · &nbsp; Gray: furniture
      &nbsp; · &nbsp; Green: available exit &nbsp; · &nbsp; Red: blocked exit
      &nbsp; · &nbsp; Distances in meters</div>
  </section>
</main>
<script id="simulation-data" type="application/json">__DATA__</script>
<script>
const data = JSON.parse(document.getElementById('simulation-data').textContent);
const scenario = data.scenario;
const blockedExits = new Set(scenario.settings.blocked_exit_ids || []);
const frames = data.frames;
const duration = frames[frames.length - 1].time;
const exitedAt = new Map(data.evacuations.map(e => [e.agent_id, e.time]));
const canvas = document.getElementById('plan');
const ctx = canvas.getContext('2d');
const play = document.getElementById('play');
const timeline = document.getElementById('timeline');
const counts = document.getElementById('counts');
const clock = document.getElementById('clock');
let time = 0;
let playing = false;
let rate = 1;
let lastStamp = null;

document.getElementById('title').textContent = scenario.name;
document.getElementById('outcome').textContent = data.status === 'completed'
  ? 'Run completed' : 'Time limit reached · evacuation incomplete';

function lowerFrame(t) {
  let low = 0, high = frames.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (frames[mid].time <= t) low = mid;
    else high = mid - 1;
  }
  return low;
}

function positionsAt(t) {
  const index = lowerFrame(t);
  const left = frames[index];
  const right = frames[Math.min(index + 1, frames.length - 1)];
  const next = new Map(right.agents.map(a => [a.id, a]));
  const span = right.time - left.time;
  const fraction = span > 0 ? Math.min(1, Math.max(0, (t - left.time) / span)) : 0;
  return left.agents
    .filter(a => !exitedAt.has(a.id) || t < exitedAt.get(a.id))
    .map(a => {
      const b = next.get(a.id) || a;
      return {id: a.id, x: a.x + (b.x - a.x) * fraction,
        y: a.y + (b.y - a.y) * fraction};
    });
}

function render() {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const pixelRatio = window.devicePixelRatio || 1;
  const wantedWidth = Math.round(width * pixelRatio);
  const wantedHeight = Math.round(height * pixelRatio);
  if (canvas.width !== wantedWidth || canvas.height !== wantedHeight) {
    canvas.width = wantedWidth;
    canvas.height = wantedHeight;
  }
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  const boundary = data.geometry.boundary;
  const visiblePoints = boundary.concat(scenario.exits.flatMap(exit => exit.polygon));
  const xs = visiblePoints.map(p => p[0]), ys = visiblePoints.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const padding = 30;
  const scale = Math.min((width - 2 * padding) / (maxX - minX),
    (height - 2 * padding) / (maxY - minY));
  const offsetX = (width - (maxX - minX) * scale) / 2;
  const offsetY = (height - (maxY - minY) * scale) / 2;
  const screen = (x, y) => [offsetX + (x - minX) * scale,
    height - offsetY - (y - minY) * scale];

  function ring(points) {
    points.forEach(([x, y], i) => {
      const p = screen(x, y);
      if (i === 0) ctx.moveTo(...p);
      else ctx.lineTo(...p);
    });
    ctx.closePath();
  }
  function polygon(points, fill, stroke) {
    ctx.beginPath(); ring(points);
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke();
  }

  ctx.beginPath();
  ring(boundary);
  data.geometry.holes.forEach(ring);
  ctx.fillStyle = '#fff'; ctx.fill('evenodd');
  ctx.strokeStyle = '#46556b'; ctx.lineWidth = 2; ctx.stroke();
  scenario.obstacles.forEach(o => polygon(o.polygon, '#b7c2d2', '#70829a'));
  (scenario.exit_boundaries || []).forEach(door => {
    ctx.beginPath(); ctx.moveTo(...screen(...door.start)); ctx.lineTo(...screen(...door.end));
    ctx.strokeStyle = blockedExits.has(door.id) ? '#dc2626' : '#b9e4ff';
    ctx.lineWidth = Math.max(3, .08 * scale); ctx.stroke();
  });
  scenario.exits.forEach(e => polygon(e.polygon,
    blockedExits.has(e.id) ? '#fecaca' : '#b4efcf',
    blockedExits.has(e.id) ? '#b42318' : '#248258'));

  for (const agent of positionsAt(time)) {
    const [x, y] = screen(agent.x, agent.y);
    const radius = scenario.agent_defaults.radius * scale;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#335cce'; ctx.fill();
    ctx.strokeStyle = '#193e9a'; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillStyle = '#334155'; ctx.fillText(agent.id, x, y - radius - 6);
  }

  const exited = data.evacuations.filter(e => e.time <= time).length;
  counts.textContent = `${scenario.occupants.length - exited} remaining · ${exited} exited`;
  document.getElementById('exit-counts').textContent = scenario.exits.map(e => {
    const count = data.evacuations.filter(event => event.exit_id === e.id && event.time <= time).length;
    const label = blockedExits.has(e.id) ? ' (blocked)' : '';
    return `${e.id}${label}: ${count} exited`;
  }).join(' · ');
  clock.textContent = `${time.toFixed(2)} / ${duration.toFixed(2)} s`;
  timeline.value = duration > 0 ? Math.round(time / duration * 10000) : 0;
  play.textContent = playing ? 'Pause' : 'Play';
}

play.addEventListener('click', () => {
  if (time >= duration) time = 0;
  playing = !playing;
  lastStamp = null;
  render();
});
document.getElementById('restart').addEventListener('click', () => {
  time = 0; playing = false; lastStamp = null; render();
});
timeline.addEventListener('input', () => {
  time = Number(timeline.value) / 10000 * duration;
  playing = false; render();
});
document.getElementById('speed').addEventListener('change', event => {
  rate = Number(event.target.value);
});
document.addEventListener('visibilitychange', () => { lastStamp = null; });
new ResizeObserver(render).observe(canvas);

function tick(stamp) {
  if (playing && lastStamp !== null) {
    time = Math.min(duration, time + (stamp - lastStamp) / 1000 * rate);
    if (time >= duration) playing = false;
    render();
  }
  lastStamp = stamp;
  requestAnimationFrame(tick);
}
render();
requestAnimationFrame(tick);
</script>
</body>
</html>'''


def render_html(result: dict) -> str:
    """Render either saved or in-memory results without changing the caller's data."""
    if not result.get("frames"):
        raise ValueError("The result must contain at least one frame")
    scenario = Scenario.model_validate(result["scenario"])
    geometry = build_geometry(scenario)
    # Outside clearance geometry supports the routing/body checks. It is not
    # another hall to draw: people leave at the strip beside the actual door.
    generated_aprons = {f"exit-apron:{boundary.id}" for boundary in scenario.exit_boundaries}
    if generated_aprons:
        interior = unary_union([region_to_polygon(region) for region in scenario.walkable_areas
                                if region.id not in generated_aprons]).intersection(geometry)
        if isinstance(interior, Polygon) and not interior.is_empty:
            geometry = interior
    payload = dict(result)
    payload["geometry"] = {
        "boundary": list(geometry.exterior.coords),
        "holes": [list(ring.coords) for ring in geometry.interiors],
    }
    encoded = json.dumps(payload, separators=(",", ":"), allow_nan=False)
    return HTML.replace("__DATA__", encoded.replace("<", "\\u003c"))


def main():
    repo_root = Path(__file__).resolve().parents[3]
    data_dir = repo_root / "backend" / "data"
    parser = argparse.ArgumentParser(description="Build HTML playback from a Crowdy result")
    parser.add_argument(
        "result", nargs="?", type=Path,
        default=data_dir / "simple_room_result.json",
    )
    args = parser.parse_args()
    input_path = args.result.resolve()

    if not input_path.exists():
        raise SystemExit(
            "Missing simulation results. Run python -m app.simulation.run_example first."
        )

    result = json.loads(input_path.read_text(encoding="utf-8"))
    stem = input_path.stem.removesuffix("_result")
    output_path = data_dir / f"{stem}_animation.html"
    output_path.write_text(render_html(result), encoding="utf-8")
    print(f"Saved animation: {output_path}")


if __name__ == "__main__":
    main()
