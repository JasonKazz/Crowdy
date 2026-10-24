"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import FloorPlanView from "./floor-plan";
import Icon, { type IconName } from "./icon";
import {
  SAMPLE_PLAN,
  runSimulation,
  getEvacuatedCount,
  type FloorPlan,
  type PlanItem,
  type Scenario,
  type SimulationResult,
} from "@/lib/simulation";

type Mode = "layout" | "simulation" | "compare";
const DEFAULT_SCENARIO: Scenario = {
  occupancy: 80,
  mobility: "standard",
  distribution: "uniform",
};
const STORAGE_KEY = "crowdy-workspace-v1";
const signature = (plan: FloorPlan, scenario: Scenario) =>
  JSON.stringify({ plan, scenario });
const formatTime = (n: number) => `${n.toFixed(1)} s`;
const clonePlan = (plan: FloorPlan) =>
  JSON.parse(JSON.stringify(plan)) as FloorPlan;

function validatePlan(value: unknown): FloorPlan {
  if (!value || typeof value !== "object")
    throw new Error(
      "Choose a Crowdy JSON floor plan. Download the sample to see the format.",
    );
  const plan = value as FloorPlan;
  const finite = (...numbers: number[]) => numbers.every(Number.isFinite);
  if (
    typeof plan.id !== "string" ||
    !plan.id.trim() ||
    plan.id.length > 80 ||
    typeof plan.name !== "string" ||
    !plan.name.trim() ||
    plan.name.length > 80 ||
    plan.width !== 900 ||
    plan.height !== 600 ||
    !Number.isFinite(plan.area) ||
    plan.area <= 0 ||
    plan.area > 10000 ||
    !Array.isArray(plan.items) ||
    plan.items.length > 100 ||
    !Array.isArray(plan.walls) ||
    plan.walls.length > 100 ||
    !Array.isArray(plan.exits) ||
    plan.exits.length < 1 ||
    plan.exits.length > 12
  )
    throw new Error(
      "This plan needs a name, a 900 × 600 canvas, valid area, and at least one exit. Use the sample JSON as a template.",
    );
  const ids = new Set<string>();
  for (const item of plan.items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      ids.has(item.id) ||
      typeof item.label !== "string" ||
      item.label.length > 80 ||
      !["desk", "table", "shelf", "sofa", "plant", "obstacle"].includes(
        item.kind,
      ) ||
      !finite(item.x, item.y, item.width, item.height) ||
      item.width < 8 ||
      item.height < 8 ||
      item.x < 0 ||
      item.y < 0 ||
      item.x + item.width > 900 ||
      item.y + item.height > 600
    )
      throw new Error(
        "An object has invalid dimensions or a duplicate ID. Check its coordinates in the JSON and upload again.",
      );
    ids.add(item.id);
  }
  for (const wall of plan.walls)
    if (
      !wall ||
      !finite(wall.x1, wall.y1, wall.x2, wall.y2) ||
      Math.min(wall.x1, wall.x2) < 0 ||
      Math.max(wall.x1, wall.x2) > 900 ||
      Math.min(wall.y1, wall.y2) < 0 ||
      Math.max(wall.y1, wall.y2) > 600
    )
      throw new Error(
        "A wall is outside the 900 × 600 canvas. Correct its coordinates and upload again.",
      );
  const exitIds = new Set<string>();
  for (const exit of plan.exits) {
    if (
      !exit ||
      typeof exit.id !== "string" ||
      !exit.id.trim() ||
      exitIds.has(exit.id) ||
      typeof exit.label !== "string" ||
      exit.label.length > 80 ||
      !finite(exit.x, exit.y) ||
      exit.x < 0 ||
      exit.x > 900 ||
      exit.y < 0 ||
      exit.y > 600
    )
      throw new Error(
        "An exit has invalid coordinates or a duplicate ID. Correct it and upload again.",
      );
    exitIds.add(exit.id);
  }
  return clonePlan(plan);
}

function downloadJson(data: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Workspace() {
  const [plan, setPlan] = useState<FloorPlan>(SAMPLE_PLAN);
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [mode, setMode] = useState<Mode>("layout");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<FloorPlan[]>([]);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const preview = useMemo(
    () => runSimulation(plan, scenario),
    [plan, scenario],
  );
  const [baseline, setBaseline] = useState<SimulationResult | null>(null);
  const [runCount, setRunCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [layers, setLayers] = useState({
    people: true,
    routes: false,
    density: false,
  });
  const [modal, setModal] = useState<"upload" | "help" | "reset" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saveState, setSaveState] = useState("Loading workspace");
  const [hydrated, setHydrated] = useState(false);
  const [savedSetup, setSavedSetup] = useState("");
  const runTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentTime = useRef(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const data = JSON.parse(stored);
          const next = validatePlan(data.plan);
          const s = data.scenario as Scenario;
          if (
            s &&
            Number.isInteger(s.occupancy) &&
            s.occupancy >= 10 &&
            s.occupancy <= 200 &&
            ["standard", "mixed"].includes(s.mobility) &&
            ["uniform", "workstations"].includes(s.distribution)
          ) {
            setPlan(next);
            setScenario(s);
          }
        }
      } catch {
        setNotice(
          "Your previous setup could not be restored. The sample plan is ready.",
        );
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
      if (runTimer.current) clearTimeout(runTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ plan, scenario }));
        setSaveState("Saved in this browser");
      } catch {
        setSaveState("Browser storage unavailable");
      }
      setSavedSetup(signature(plan, scenario));
    }, 100);
    return () => clearTimeout(timer);
  }, [hydrated, plan, scenario]);

  useEffect(() => {
    if (modal) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [modal]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    currentTime.current = time;
  }, [time]);
  useEffect(() => {
    if (!playing || !result) return;
    let frame = 0;
    let last = 0;
    let elapsed = currentTime.current;
    const endTime = Math.max(
      result.totalTime,
      mode === "compare" ? (baseline?.totalTime ?? 0) : 0,
    );
    const step = (now: number) => {
      if (last) elapsed += Math.min((now - last) / 1000, 0.1) * speed;
      last = now;
      const next = Math.min(elapsed, endTime);
      setTime(next);
      if (next >= endTime) setPlaying(false);
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, result, speed, mode, baseline]);

  const selected = plan.items.find((item) => item.id === selectedId);
  const stale = Boolean(
    result &&
      signature(plan, scenario) !== signature(result.plan, result.scenario),
  );
  const canCompare = Boolean(baseline && result && baseline.id !== result.id);
  const sameScenario = Boolean(
    baseline &&
      result &&
      JSON.stringify(baseline.scenario) === JSON.stringify(result.scenario),
  );
  const shownPlan = mode === "layout" ? plan : (result?.plan ?? plan);
  const shownResult = mode === "layout" ? preview : result;
  const evacuated = result ? getEvacuatedCount(result, time) : 0;
  const duration = Math.max(
    result?.totalTime ?? 60,
    mode === "compare" ? (baseline?.totalTime ?? 0) : 0,
  );
  const resultDifference =
    baseline && result ? result.totalTime - baseline.totalTime : 0;
  const layoutChanges =
    baseline && result
      ? new Set(
          [...baseline.plan.items, ...result.plan.items]
            .filter(
              (item) =>
                JSON.stringify(
                  baseline.plan.items.find(
                    (original) => original.id === item.id,
                  ),
                ) !==
                JSON.stringify(
                  result.plan.items.find((proposed) => proposed.id === item.id),
                ),
            )
            .map((item) => item.id),
        ).size
      : 0;
  const reducedMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function editPlan(next: FloorPlan) {
    if (busy) return;
    setHistory((previous) => [...previous.slice(-19), clonePlan(plan)]);
    setPlan(next);
  }
  function moveItem(id: string, x: number, y: number) {
    const item = plan.items.find((item) => item.id === id);
    if (!item) return;
    const sample = plan.id === SAMPLE_PLAN.id;
    const nextX = Math.max(
      sample ? 84 : 0,
      Math.min((sample ? 816 : plan.width) - item.width, Math.round(x)),
    );
    const nextY = Math.max(
      sample ? 94 : 0,
      Math.min((sample ? 506 : plan.height) - item.height, Math.round(y)),
    );
    if (item.x === nextX && item.y === nextY) return;
    editPlan({
      ...plan,
      items: plan.items.map((current) =>
        current.id === id ? { ...current, x: nextX, y: nextY } : current,
      ),
    });
  }
  function addObstacle() {
    const item: PlanItem = {
      id: `obstacle-${Date.now()}`,
      label: "New obstacle",
      x: 420,
      y: 275,
      width: 70,
      height: 45,
      kind: "obstacle",
    };
    editPlan({ ...plan, items: [...plan.items, item] });
    setSelectedId(item.id);
    setMode("layout");
    setPlaying(false);
  }
  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setPlan(previous);
    setHistory(history.slice(0, -1));
    setSelectedId(null);
  }
  function run() {
    if (busy) {
      if (runTimer.current) clearTimeout(runTimer.current);
      setBusy(false);
      setNotice("Run cancelled. Your setup is unchanged.");
      return;
    }
    setBusy(true);
    setPlaying(false);
    runTimer.current = setTimeout(() => {
      try {
        const next = runSimulation(plan, scenario, Date.now());
        setResult(next);
        setTime(0);
        setMode("simulation");
        setRunCount((count) => count + 1);
        setPlaying(next.totalTime > 0 && !reducedMotion());
        setNotice(
          next.remaining
            ? `Run finished with ${next.remaining} people remaining. Review blocked routes and exits.`
            : "Run complete. Inspect playback or pin this run as your baseline.",
        );
      } catch {
        setNotice(
          "The demo run could not finish. Check that an exit is reachable and try again.",
        );
      }
      setBusy(false);
    }, 550);
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setError(
        "This file is too large. Choose a JSON floor plan smaller than 1 MB.",
      );
      return;
    }
    try {
      const data = JSON.parse(await file.text());
      const next = validatePlan(data.plan ?? data);
      editPlan(next);
      setSelectedId(null);
      setMode("layout");
      setModal(null);
      setError("");
      setNotice(
        "Floor plan imported. Review the geometry and exits before running.",
      );
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? "This file is not valid JSON. Choose a Crowdy floor plan or download the sample below."
          : cause instanceof Error
            ? cause.message
            : "This floor plan could not be opened. Try the sample JSON.",
      );
    }
    if (uploadRef.current) uploadRef.current.value = "";
  }
  function reset() {
    editPlan(clonePlan(SAMPLE_PLAN));
    setScenario(DEFAULT_SCENARIO);
    setSelectedId(null);
    setMode("layout");
    setModal(null);
    setNotice(
      "Sample layout restored. Your previous layout is available with Undo.",
    );
  }
  function exportSetup() {
    downloadJson(
      {
        version: 1,
        plan,
        scenario,
        result: result
          ? {
              model: "Crowdy illustrative grid model",
              plan: result.plan,
              scenario: result.scenario,
              totalTime: result.totalTime,
              averageTime: result.averageTime,
              remaining: result.remaining,
              peakDensity: result.peakDensity,
            }
          : null,
      },
      "crowdy-workspace.json",
    );
    setNotice("Workspace exported as JSON.");
  }
  const planProps = {
    selectedId: mode === "layout" ? selectedId : null,
    onSelect: setSelectedId,
    onMove: moveItem,
    mode,
    time: mode === "layout" ? 0 : time,
    showPeople: layers.people,
    showRoutes: layers.routes,
    showDensity: layers.density,
    zoom,
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="brand" href="/" aria-label="Crowdy home">
          <span className="brand-symbol">
            <i />
            <i />
            <i />
            <i />
          </span>
          crowdy<span className="brand-period">.</span>
        </Link>
        <span className="header-divider" />
        <div className="breadcrumb">
          <span>Workspace</span>
          <Icon name="chevron" size={13} />
          <strong>Untitled project</strong>
        </div>
        <div className="header-right">
          <span className="demo-badge">
            <span />
            Interactive demo
          </span>
          <button
            className="icon-button help-button"
            aria-label="About this demo"
            onClick={() => setModal("help")}
          >
            <Icon name="help" />
          </button>
          <span className="avatar" aria-label="Local workspace">
            C
          </span>
        </div>
      </header>
      <div className="project-bar">
        <div>
          <div className="project-kicker">EVACUATION PLANNING</div>
          <h1>{plan.name.replace(/\.json$/i, "")}</h1>
          <p>
            <span className="status-dot" />
            {hydrated && savedSetup !== signature(plan, scenario)
              ? "Saving changes…"
              : saveState}
            <span className="text-separator">/</span>Ground floor
          </p>
        </div>
        <div className="project-actions">
          <button className="button secondary" onClick={exportSetup}>
            <Icon name="download" size={16} />
            <span>Export workspace</span>
          </button>
          <button
            className={`button primary ${busy ? "is-loading" : ""}`}
            onClick={run}
          >
            <Icon name={busy ? "close" : "play"} size={15} />
            {busy ? "Cancel run" : "Run simulation"}
          </button>
        </div>
      </div>
      <main className="workspace-grid">
        <aside className="setup-panel" aria-label="Plan and scenario settings">
          <div className="panel-title">
            <span>SETUP</span>
            <span className="small-tag">01—03</span>
          </div>
          <section className="setup-section">
            <div className="section-heading">
              <span className="step-number">01</span>
              <h2>Floor plan</h2>
              <Icon name="check" size={15} />
            </div>
            <button
              className="plan-card"
              onClick={() => {
                setModal("upload");
                setError("");
              }}
            >
              <span className="mini-plan">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span className="plan-card-copy">
                <strong>{plan.name}</strong>
                <span>
                  {plan.area} m² <b>·</b> {plan.exits.length} exits
                </span>
              </span>
              <Icon name="chevron" size={14} />
            </button>
            <button
              className="text-button upload-link"
              onClick={() => {
                setModal("upload");
                setError("");
              }}
            >
              <Icon name="upload" size={14} />
              Upload floor plan
            </button>
            <div className="scale-row">
              <span>Plan scale</span>
              <span className="mono">
                32 px / m <Icon name="check" size={12} />
              </span>
            </div>
          </section>
          <section className="setup-section layout-section">
            <div className="section-heading">
              <span className="step-number">02</span>
              <h2>Layout</h2>
              <span className="section-count">{plan.items.length} objects</span>
            </div>
            <p className="helper">Select furniture on the plan to move it.</p>
            <div className="layout-buttons">
              <button
                className="button subtle"
                disabled={busy || plan.items.length >= 100}
                onClick={addObstacle}
              >
                <Icon name="plus" size={15} />
                Add obstacle
              </button>
              <button
                className="icon-button bordered"
                disabled={!history.length || busy}
                aria-label="Undo layout change"
                onClick={undo}
              >
                <Icon name="undo" size={15} />
              </button>
            </div>
            {selected && mode === "layout" && (
              <div className="selection-editor">
                <div className="selection-heading">
                  <span>{selected.label}</span>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${selected.label}`}
                    onClick={() => {
                      editPlan({
                        ...plan,
                        items: plan.items.filter(
                          (item) => item.id !== selected.id,
                        ),
                      });
                      setSelectedId(null);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
                <div className="coordinate-fields">
                  <label>
                    X{" "}
                    <input
                      aria-label="Object X position"
                      type="number"
                      min={plan.id === SAMPLE_PLAN.id ? 84 : 0}
                      max={
                        (plan.id === SAMPLE_PLAN.id ? 816 : plan.width) -
                        selected.width
                      }
                      value={selected.x}
                      onChange={(e) =>
                        moveItem(
                          selected.id,
                          Number(e.target.value),
                          selected.y,
                        )
                      }
                    />
                  </label>
                  <label>
                    Y{" "}
                    <input
                      aria-label="Object Y position"
                      type="number"
                      min={plan.id === SAMPLE_PLAN.id ? 94 : 0}
                      max={
                        (plan.id === SAMPLE_PLAN.id ? 506 : plan.height) -
                        selected.height
                      }
                      value={selected.y}
                      onChange={(e) =>
                        moveItem(
                          selected.id,
                          selected.x,
                          Number(e.target.value),
                        )
                      }
                    />
                  </label>
                  <span>px</span>
                </div>
                <p>Arrow keys move 5 px. Shift moves 20 px.</p>
              </div>
            )}
          </section>
          <section className="setup-section scenario-section">
            <div className="section-heading">
              <span className="step-number">03</span>
              <h2>Scenario</h2>
            </div>
            <fieldset disabled={busy}>
              <div className="occupancy-label">
                <label htmlFor="occupancy">Occupancy</label>
                <span>
                  <input
                    aria-label="Number of people"
                    type="number"
                    min="10"
                    max="200"
                    value={scenario.occupancy}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (Number.isFinite(value))
                        setScenario({
                          ...scenario,
                          occupancy: Math.max(
                            10,
                            Math.min(200, Math.round(value)),
                          ),
                        });
                    }}
                  />{" "}
                  people
                </span>
              </div>
              <input
                id="occupancy"
                className="range-input"
                type="range"
                min="10"
                max="200"
                value={scenario.occupancy}
                style={
                  {
                    "--range-progress": `${((scenario.occupancy - 10) / 190) * 100}%`,
                  } as React.CSSProperties
                }
                onChange={(e) =>
                  setScenario({
                    ...scenario,
                    occupancy: Number(e.target.value),
                  })
                }
              />
              <div className="range-labels">
                <span>10 people</span>
                <span>200 people</span>
              </div>
              <label className="field-label" htmlFor="distribution">
                Starting distribution
              </label>
              <div className="select-wrap">
                <select
                  id="distribution"
                  value={scenario.distribution}
                  onChange={(e) =>
                    setScenario({
                      ...scenario,
                      distribution: e.target.value as Scenario["distribution"],
                    })
                  }
                >
                  <option value="uniform">Across the floor plan</option>
                  <option value="workstations">Around workstations</option>
                </select>
                <Icon name="chevron" size={13} />
              </div>
              <label className="field-label" htmlFor="mobility">
                Walking profile
              </label>
              <div className="select-wrap">
                <select
                  id="mobility"
                  value={scenario.mobility}
                  onChange={(e) =>
                    setScenario({
                      ...scenario,
                      mobility: e.target.value as Scenario["mobility"],
                    })
                  }
                >
                  <option value="standard">Standard walking</option>
                  <option value="mixed">Mixed walking speeds</option>
                </select>
                <Icon name="chevron" size={13} />
              </div>
              <p className="field-note">
                {scenario.mobility === "standard"
                  ? "Default walking speed: 1.2 m/s."
                  : "Includes slower walkers. Speed: 0.7–1.2 m/s."}
              </p>
            </fieldset>
          </section>
          <div className="setup-bottom">
            <span>
              <Icon name="check" size={14} />
              Scenario ready
            </span>
            <button
              className="text-button muted"
              onClick={() => setModal("reset")}
            >
              Reset layout
            </button>
          </div>
        </aside>
        <section
          className="spatial-workspace"
          aria-label="Floor plan workspace"
        >
          <div className="view-header">
            <div
              className="view-tabs"
              role="tablist"
              aria-label="Workspace view"
            >
              {(
                [
                  { id: "layout", label: "Layout", icon: "layout" },
                  { id: "simulation", label: "Simulation", icon: "people" },
                  { id: "compare", label: "Compare", icon: "compare" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={mode === tab.id}
                  disabled={
                    tab.id === "simulation"
                      ? !result
                      : tab.id === "compare"
                        ? !canCompare
                        : false
                  }
                  onClick={() => {
                    setMode(tab.id);
                    setSelectedId(null);
                    setPlaying(false);
                  }}
                >
                  <Icon name={tab.icon} size={15} />
                  {tab.label}
                  {tab.id === "compare" && <span className="tab-count">2</span>}
                </button>
              ))}
            </div>
            <span className="floor-label">FLOOR 01</span>
          </div>
          <div
            className={`canvas-container ${mode === "compare" ? "comparison-canvas" : ""}`}
          >
            <div className="canvas-caption">
              <span className="canvas-status">
                <span className={`status-dot ${busy ? "amber" : ""}`} />
                {busy
                  ? "Computing crowd movement"
                  : mode === "layout"
                    ? "Editing layout"
                    : playing
                      ? "Playing simulation"
                      : "Simulation paused"}
              </span>
              {mode === "layout" ? (
                <span>
                  {scenario.occupancy} people{" "}
                  <span className="caption-dot">·</span> {plan.exits.length}{" "}
                  exits
                </span>
              ) : (
                <span className="mono">
                  RUN {String(runCount).padStart(2, "0")}
                </span>
              )}
            </div>
            {mode === "compare" && baseline && result ? (
              <div className="compare-plans">
                <div>
                  <div className="compare-label">
                    <span>BASELINE</span>
                    <strong>{formatTime(baseline.totalTime)}</strong>
                  </div>
                  <FloorPlanView
                    {...planProps}
                    plan={baseline.plan}
                    result={baseline}
                    selectedId={null}
                  />
                </div>
                <div>
                  <div className="compare-label">
                    <span>PROPOSED</span>
                    <strong>{formatTime(result.totalTime)}</strong>
                  </div>
                  <FloorPlanView
                    {...planProps}
                    plan={result.plan}
                    result={result}
                    selectedId={null}
                  />
                </div>
              </div>
            ) : (
              <FloorPlanView
                {...planProps}
                plan={shownPlan}
                result={shownResult}
              />
            )}
            <div className="canvas-controls">
              <div className="tool-group">
                <button
                  className={`icon-button ${mode === "layout" ? "tool-selected" : ""}`}
                  aria-label="Edit layout"
                  onClick={() => {
                    setMode("layout");
                    setPlaying(false);
                  }}
                >
                  <Icon name="cursor" size={17} />
                </button>
                <span />
                <button
                  className="icon-button"
                  aria-label="Zoom out"
                  disabled={zoom <= 0.7}
                  onClick={() => setZoom(Math.max(0.7, zoom - 0.1))}
                >
                  <Icon name="minus" size={16} />
                </button>
                <span className="zoom-value">{Math.round(zoom * 100)}%</span>
                <button
                  className="icon-button"
                  aria-label="Zoom in"
                  disabled={zoom >= 1.6}
                  onClick={() => setZoom(Math.min(1.6, zoom + 0.1))}
                >
                  <Icon name="plus" size={16} />
                </button>
                <span />
                <button
                  className="icon-button"
                  aria-label="Fit plan to view"
                  onClick={() => setZoom(1)}
                >
                  <Icon name="fit" size={16} />
                </button>
              </div>

            </div>
            {stale && mode !== "layout" && (
              <div className="stale-notice">
                <Icon name="clock" size={14} />
                Inputs changed. This view shows the previous run.
                <button onClick={run}>
                  Run updated setup <span>↗</span>
                </button>
              </div>
            )}
          </div>
          <div className="layers-bar">
            <div className="layers-label">
              <Icon name="layers" size={15} />
              <span>Layers</span>
            </div>
            {(
              [
                { id: "people", label: "People", icon: "people" },
                { id: "routes", label: "Routes", icon: "route" },
                { id: "density", label: "Density", icon: "heat" },
              ] as { id: keyof typeof layers; label: string; icon: IconName }[]
            ).map((layer) => (
              <button
                className={`layer-toggle ${layers[layer.id] ? "active" : ""}`}
                key={layer.id}
                aria-pressed={layers[layer.id]}
                onClick={() =>
                  setLayers({ ...layers, [layer.id]: !layers[layer.id] })
                }
              >
                <span className="layer-checkbox">
                  {layers[layer.id] && <Icon name="check" size={10} />}
                </span>
                {layer.label}
              </button>
            ))}
            <div className="plan-legend">
              {layers.density ? (
                <>
                  <span className="density-scale" />
                  <span>0 → 6+ people / m²</span>
                </>
              ) : (
                <>
                  <span className="legend-person" />
                  Person
                  <span className="legend-exit" />
                  Exit
                </>
              )}
            </div>
          </div>
          <div className="playback-panel">
            <div className="playback-top">
              <div className="playback-title">
                <Icon name="clock" size={15} />
                <strong>
                  {mode === "layout" ? "Simulation playback" : "Playback"}
                </strong>
                <span>
                  {result
                    ? `${evacuated} / ${result.scenario.occupancy} exited`
                    : "Run a scenario to inspect movement"}
                </span>
              </div>
              <span className="playback-time mono">
                {time.toFixed(1)} <span>/ {duration.toFixed(1)} s</span>
              </span>
            </div>
            <div className="playback-bottom">
              <button
                className="playback-play"
                aria-label={playing ? "Pause simulation" : "Play simulation"}
                disabled={!result || busy || duration <= 0}
                onClick={() => {
                  if (time >= duration) setTime(0);
                  setMode(mode === "layout" ? "simulation" : mode);
                  setPlaying(!playing);
                }}
              >
                <Icon name={playing ? "pause" : "play"} size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="Restart playback"
                disabled={!result}
                onClick={() => {
                  setTime(0);
                  setPlaying(false);
                }}
              >
                <Icon name="reset" size={16} />
              </button>
              <input
                aria-label="Simulation time"
                type="range"
                min="0"
                max={Math.max(0.1, duration)}
                step="0.1"
                disabled={!result || duration <= 0}
                value={time}
                onChange={(e) => {
                  setTime(Number(e.target.value));
                  setPlaying(false);
                  if (mode === "layout") setMode("simulation");
                }}
              />
              <select
                className="speed-select"
                aria-label="Playback speed"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                <option value="0.5">0.5×</option>
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
              </select>
            </div>
            <div className="timeline-labels">
              <span>0 s</span>
              <span>{(duration / 4).toFixed(0)} s</span>
              <span>{(duration / 2).toFixed(0)} s</span>
              <span>{(duration * 0.75).toFixed(0)} s</span>
              <span>{duration.toFixed(0)} s</span>
            </div>
          </div>
        </section>
        <aside className="results-panel" aria-label="Simulation results">
          <div className="results-heading">
            <h2>Run overview</h2>
            <span className={`result-status ${result ? "complete" : ""}`}>
              {busy
                ? "Running"
                : result
                  ? result.remaining
                    ? "Partial"
                    : "Complete"
                  : "Not run"}
            </span>
          </div>
          <p className="results-subtitle">
            {result
              ? `${result.scenario.occupancy} people · ${result.plan.exits.length} exits · ${result.scenario.mobility === "standard" ? "Standard" : "Mixed"} walking`
              : "Your scenario, at a glance."}
          </p>
          {stale && (
            <div className="result-stale">Inputs changed since this run</div>
          )}
          <div className="primary-metric">
            <span>
              Simulated evacuation time{" "}
              <button
                className="inline-help"
                aria-label="Evacuation time definition"
                title="Time until all reachable people exit. People without a route are counted as remaining."
                onClick={() => setModal("help")}
              >
                <Icon name="help" size={12} />
              </button>
            </span>
            <div>
              {result?.exited ? result.totalTime.toFixed(1) : "—"}
              <span>{result ? "seconds" : "seconds"}</span>
            </div>
            <p>
              {result
                ? result.exited
                  ? `${result.exited} people reached an exit${result.remaining ? ` · ${result.remaining} remaining` : ""}`
                  : `No reachable exit · ${result.remaining} people remaining`
                : "Time until the last reachable person exits"}
            </p>
          </div>
          <div className="secondary-metrics">
            <div>
              <span>Average exit time</span>
              <strong>
                {result?.exited ? formatTime(result.averageTime) : "—"}
              </strong>
            </div>
            <div>
              <span title="Highest sampled density in a 2 m × 2 m cell across the run">Peak sampled density</span>
              <strong>
                {result ? result.peakDensity.toFixed(1) : "—"}
                <small> people / m²</small>
              </strong>
            </div>
            <div>
              <span>People remaining</span>
              <strong className={result?.remaining ? "warning-text" : ""}>
                {result ? result.remaining : "—"}
                <small>
                  {" "}
                  / {result?.scenario.occupancy ?? scenario.occupancy}
                </small>
              </strong>
            </div>
          </div>
          <div className="evacuation-chart">
            <div className="chart-heading">
              <h3>People evacuated</h3>
              <span>{result ? `${result.exited} total` : "No run yet"}</span>
            </div>
            <svg
              viewBox="0 0 240 110"
              role="img"
              aria-label={
                result
                  ? `Evacuation progress: ${result.exited} of ${result.scenario.occupancy} people reached an exit`
                  : "Evacuation chart will appear after a run"
              }
            >
              <path
                d="M24 12H230M24 49H230M24 86H230"
                stroke="#e7eae5"
                strokeDasharray="3 3"
                fill="none"
              />
              <text x="0" y="16">
                {result?.scenario.occupancy ?? scenario.occupancy}
              </text>
              <text x="12" y="90">
                0
              </text>
              {result ? (
                <>
                  <path
                    d={`M24 86 ${Array.from({ length: 31 }, (_, i) => `L${24 + (i / 30) * 206} ${86 - (getEvacuatedCount(result, (i / 30) * result.totalTime) / result.scenario.occupancy) * 74}`).join(" ")} L230 86Z`}
                    fill="#e4efdf"
                  />
                  <path
                    d={Array.from(
                      { length: 31 },
                      (_, i) =>
                        `${i ? "L" : "M"}${24 + (i / 30) * 206} ${86 - (getEvacuatedCount(result, (i / 30) * result.totalTime) / result.scenario.occupancy) * 74}`,
                    ).join(" ")}
                    stroke="#628447"
                    strokeWidth="2"
                    fill="none"
                  />
                </>
              ) : (
                <text
                  className="empty-chart-text"
                  x="120"
                  y="54"
                  textAnchor="middle"
                >
                  Awaiting simulation
                </text>
              )}
              <text x="24" y="106">
                0 s
              </text>
              <text x="230" y="106" textAnchor="end">
                {result ? result.totalTime.toFixed(0) : "—"} s
              </text>
            </svg>
          </div>
          <div className="observation">
            <span className="observation-icon">
              <Icon name={result ? "route" : "cursor"} size={17} />
            </span>
            <div>
              <h3>
                {result
                  ? "Inspect the exit approaches"
                  : "Start with the space"}
              </h3>
              <p>
                {result
                  ? "Turn on density to locate queues near exits. Pause playback to inspect a specific moment."
                  : "Move a desk, adjust occupancy, then run a scenario to see what changes."}
              </p>
              {result && (
                <button
                  className="text-button"
                  onClick={() => {
                    setLayers({ ...layers, density: true });
                    setMode("simulation");
                    setPlaying(false);
                    setTime(result.totalTime * 0.45);
                  }}
                >
                  Show crowd density <Icon name="arrow" size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="comparison-section">
            <div className="chart-heading">
              <h3>Compare runs</h3>
              <Icon name="compare" size={15} />
            </div>
            {baseline ? (
              <>
                <div className="baseline-row">
                  <span>
                    <Icon name="pin" size={13} />
                    Baseline pinned
                  </span>
                  <strong className="mono">
                    {formatTime(baseline.totalTime)}
                  </strong>
                </div>
                <p className="helper">
                  {canCompare
                    ? baseline &&
                      result &&
                      (baseline.remaining || result.remaining)
                      ? "Incomplete runs. Compare people remaining; total times exclude unreachable people."
                      : sameScenario
                        ? `${layoutChanges} layout object${layoutChanges === 1 ? "" : "s"} changed. Same occupancy and walking profile.`
                        : "Scenario settings differ between runs."
                    : "Edit the layout and run again to compare."}
                </p>
                {canCompare &&
                  baseline &&
                  result &&
                  !baseline.remaining &&
                  !result.remaining && (
                    <div
                      className={`comparison-delta ${resultDifference <= 0 ? "improvement" : "increase"}`}
                    >
                      <strong>
                        {resultDifference > 0 ? "+" : ""}
                        {resultDifference.toFixed(1)} s
                      </strong>
                      <span>vs. baseline · simulated time</span>
                    </div>
                  )}
                <div className="comparison-actions">
                  <button
                    className="button subtle"
                    disabled={!canCompare}
                    onClick={() => {
                      setMode("compare");
                      setTime(0);
                      setPlaying(false);
                    }}
                  >
                    Compare runs
                    <Icon name="arrow" size={14} />
                  </button>
                  <button
                    className="text-button muted"
                    onClick={() => {
                      setBaseline(null);
                      if (mode === "compare") setMode("simulation");
                    }}
                  >
                    Clear baseline
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="helper">
                  Keep a run as a baseline, then test a change to the layout.
                </p>
                <button
                  className="button subtle pin-button"
                  disabled={!result || stale}
                  onClick={() => {
                    setBaseline(result);
                    setNotice(
                      "Baseline pinned for this session. Edit the layout and run again.",
                    );
                  }}
                >
                  <Icon name="pin" size={14} />
                  Pin current run as baseline
                </button>
              </>
            )}
          </div>
          <div className="model-note">
            <span>DEMO MODEL</span>
            <p>
              Illustrative grid routing and exit queues. Results are simulated,
              not a safety assessment.
            </p>
            <button
              className="text-button muted"
              onClick={() => setModal("help")}
            >
              View assumptions
              <Icon name="external" size={12} />
            </button>
          </div>
        </aside>
      </main>
      <footer className="app-footer">
        <span>
          <span className="footer-mark">C</span>Made for the way people move.
        </span>
        <span>
          Cal Hacks 13.0<span className="text-separator">/</span>Browser-local
          workspace
        </span>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="Dismiss message"
            onClick={() => setNotice("")}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <dialog
        ref={dialogRef}
        aria-labelledby="workspace-dialog-title"
        className="workspace-dialog"
        onCancel={() => setModal(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setModal(null);
        }}
      >
        <div className="dialog-header">
          <h2 id="workspace-dialog-title">
            {modal === "upload"
              ? "Upload floor plan"
              : modal === "reset"
                ? "Restore the sample layout?"
                : "About this demo"}
          </h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={() => setModal(null)}
          >
            <Icon name="close" />
          </button>
        </div>
        {modal === "upload" ? (
          <>
            <p>
              Import a Crowdy JSON floor plan with editable walls, furniture,
              and exits. Uploading replaces your current layout; Undo restores
              it.
            </p>
            <button
              className="upload-dropzone"
              onClick={() => uploadRef.current?.click()}
            >
              <Icon name="upload" size={26} />
              <strong>Choose a floor plan</strong>
              <span>JSON only · up to 1 MB · 900 × 600 canvas</span>
            </button>
            <input
              ref={uploadRef}
              className="visually-hidden"
              type="file"
              accept=".json,application/json"
              aria-label="Choose floor plan JSON file"
              onChange={(e) => upload(e.target.files?.[0])}
            />
            {error && (
              <div className="upload-error" role="alert">
                {error}
              </div>
            )}
            <button
              className="text-button"
              onClick={() =>
                downloadJson(
                  { version: 1, plan: SAMPLE_PLAN },
                  "crowdy-sample-plan.json",
                )
              }
            >
              <Icon name="download" size={14} />
              Download sample JSON
            </button>
            <p className="dialog-note">
              Image and PDF interpretation will be available when the floor-plan
              backend is connected.
            </p>
          </>
        ) : modal === "reset" ? (
          <>
            <p>
              This replaces your edited layout and scenario with the sample
              studio. Your previous layout remains available through Undo;
              existing run results keep their original inputs.
            </p>
            <div className="dialog-actions">
              <button
                className="button secondary"
                onClick={() => setModal(null)}
              >
                Keep editing
              </button>
              <button className="button primary" onClick={reset}>
                Restore sample
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Crowdy explores how a furnished layout and its occupancy affect
              movement to exits.
            </p>
            <dl className="assumption-list">
              <div>
                <dt>Geometry</dt>
                <dd>
                  32 canvas pixels represent 1 metre. The sample area is
                  approximate. Review imported geometry before running.
                </dd>
              </div>
              <div>
                <dt>Movement</dt>
                <dd>
                  People follow shortest available grid routes around furniture.
                  Exit queues and reaction delays are simplified. Collisions and
                  real crowd behavior are not fully modeled.
                </dd>
              </div>
              <div>
                <dt>Reported time</dt>
                <dd>
                  Elapsed model time until the last reachable person exits.
                  Unreachable people remain visible and are excluded from the
                  average exit time.
                </dd>
              </div>
              <div>
                <dt>Playback</dt>
                <dd>
                  1× playback advances one simulated second per real second.
                  Reduced motion starts runs paused.
                </dd>
              </div>
              <div>
                <dt>Your work</dt>
                <dd>
                  Layout and scenario are saved in this browser. Runs and
                  baselines last for this session. Export a workspace to keep a
                  copy.
                </dd>
              </div>
            </dl>
            <p className="dialog-note">
              This frontend demo runs locally in your browser. No backend
              analysis or floor-plan interpretation is connected.
            </p>
          </>
        )}
      </dialog>
    </div>
  );
}
