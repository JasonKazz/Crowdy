"use client";

import { useEffect, useRef, useState } from "react";
import { runBackendSimulation } from "@/lib/backend-simulation";
import { initialLiveEvacuationState, LiveEvacuationRunner, type LiveEvacuationCompletion } from "@/lib/live-evacuation";
import { getEvacuatedCount, type FloorPlan, type Scenario, type SimulationResult } from "@/lib/simulation";
import { useLiveCrowd } from "./live-crowd-provider";
import LiveCrowdFeed from "./live-crowd-feed";
import FloorPlanView from "./floor-plan";
import Icon from "./icon";
import styles from "./live-evacuation-analytics.module.css";

function clearance(result: SimulationResult): number | null {
  if (result.remaining > 0 || result.clearanceTime === null) return null;
  return result.clearanceTime ?? result.totalTime;
}

const elapsed = (timestamp: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  return seconds < 2 ? "just now" : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
};

function ForecastPlayback({ completion }: { completion: LiveEvacuationCompletion }) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [density, setDensity] = useState(false);
  const position = useRef(0);
  const result = completion.result;
  useEffect(() => { position.current = time; }, [time]);
  useEffect(() => {
    if (!playing || result.totalTime <= 0) return;
    let frame = 0;
    let last = 0;
    let current = position.current;
    const step = (now: number) => {
      if (last) current += Math.min((now - last) / 1_000, .1);
      last = now;
      setTime(Math.min(current, result.totalTime));
      if (current >= result.totalTime) setPlaying(false);
      else frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, result.totalTime]);
  return (
    <>
      <div className={styles.plan}>
        <FloorPlanView plan={result.plan} result={result} mode="simulation" selectedId={null} onSelect={() => undefined} onMove={() => undefined}
          time={time} showPeople showRoutes={false} showDensity={density} zoom={1} blockedExitIds={result.scenario.blockedExitIds} />
      </div>
      <div className={styles.playback}>
        <button type="button" className={styles.play} disabled={result.totalTime <= 0} aria-label={playing ? "Pause evacuation forecast" : "Play evacuation forecast"}
          onClick={() => { if (time >= result.totalTime) setTime(0); setPlaying(!playing); }}><Icon name={playing ? "pause" : "play"} size={14} /></button>
        <input type="range" min={0} max={Math.max(.1, result.totalTime)} step={.1} value={time} disabled={result.totalTime <= 0} aria-label="Evacuation forecast time"
          onChange={event => { setTime(Number(event.target.value)); setPlaying(false); }} />
        <span>{time.toFixed(1)} / {result.totalTime.toFixed(1)} s</span>
        <button type="button" className={styles.density} aria-pressed={density} onClick={() => setDensity(!density)}><Icon name="heat" size={14} /><span>Density</span></button>
      </div>
      <p className={styles.playbackNote}>{getEvacuatedCount(result, time)} / {completion.count} exited in this simulated playback</p>
    </>
  );
}

export default function LiveEvacuationAnalytics({ active, plan, scenario, busy, onBusyChange, id, labelledBy }: {
  active: boolean;
  plan: FloorPlan;
  scenario: Scenario;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  id: string;
  labelledBy: string;
}) {
  const feed = useLiveCrowd();
  const [state, setState] = useState(initialLiveEvacuationState);
  const [automatic, setAutomatic] = useState(true);
  const [visible, setVisible] = useState(true);
  const [history, setHistory] = useState<LiveEvacuationCompletion[]>([]);
  const runner = useRef<LiveEvacuationRunner | null>(null);

  useEffect(() => {
    let disposed = false;
    let lastCompletion: LiveEvacuationCompletion | null = null;
    const transports = new Set<AbortController>();
    const instance = new LiveEvacuationRunner({
      run: (submittedPlan, submittedScenario) => {
        // Native simulation keeps computing when an HTTP client disconnects.
        // Drain issued work so manual runs wait for its actual response. The
        // runner still invalidates paused/old results immediately.
        const controller = new AbortController();
        transports.add(controller);
        return runBackendSimulation(submittedPlan, submittedScenario, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) })
          .finally(() => transports.delete(controller));
      },
      onState: next => {
        if (disposed) return;
        setState(next);
        if (next.completed && next.completed !== lastCompletion) {
          lastCompletion = next.completed;
          const completed = next.completed;
          setHistory(previous => [completed, ...previous.filter(item => item.sessionId === completed.sessionId && item.result.id !== completed.result.id)].slice(0, 6));
        } else if (next.completed === null && lastCompletion !== null) {
          lastCompletion = null;
          setHistory([]);
        }
      },
    });
    runner.current = instance;
    return () => {
      disposed = true;
      instance.dispose();
      runner.current = null;
      for (const controller of transports) controller.abort();
    };
  }, []);

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    queueMicrotask(update);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    runner.current?.update({ plan, scenario, observation: feed.observation, enabled: active && automatic && visible, blocked: busy });
  }, [plan, scenario, feed.observation, active, automatic, visible, busy]);

  useEffect(() => { onBusyChange(state.active !== null); }, [state.active, onBusyChange]);

  const completion = state.completed;
  const result = completion?.result;
  const estimate = result ? clearance(result) : null;
  const current = state.current && automatic && visible && !busy;
  const status = state.active ? state.status === "running" ? "Calculating" : "Finishing previous run" : !automatic ? "Analytics paused" : current ? "Up to date" : state.error ? "Needs attention" : state.nextRunAt ? "Update queued" : "Waiting for camera";
  const lastEstimate = completion ? `For ${completion.count} people · calculated ${elapsed(completion.completedAt, feed.now)}` : "Connect a camera to calculate an estimate";
  const cameraIsLive = feed.observation.status === "live";

  return (
    <section id={id} role="tabpanel" aria-labelledby={labelledBy} className={styles.root} hidden={!active}>
      <div className={styles.heading}>
        <div><p className={styles.eyebrow}>LIVE EVACUATION ANALYTICS</p><h2>A forecast that follows your crowd.</h2><p>Live headcount, your floor plan, and a fresh evacuation estimate.</p></div>
        <button type="button" className={styles.toggle} aria-pressed={automatic} onClick={() => setAutomatic(!automatic)}><Icon name={automatic ? "pause" : "play"} size={14} />{automatic ? "Pause analytics" : "Resume analytics"}</button>
      </div>
      <div className={styles.metrics}>
        <div className={styles.metric}><span><Icon name="video" size={14} />Crowd now</span><p>{feed.count ?? "—"}<small>people</small></p><em>{cameraIsLive ? "Detected in the current view" : feed.observation.status === "disconnected" ? "No camera connected" : feed.count === null ? "Waiting for a camera frame" : "Last observed count"}</em></div>
        <div className={`${styles.metric} ${styles.primaryMetric}`}><span><Icon name="clock" size={14} />Estimated evacuation time</span><p className={estimate === null && result ? styles.incomplete : undefined}>{estimate === null ? result ? "Incomplete" : "—" : estimate.toFixed(1)}{estimate !== null ? <small>seconds</small> : null}</p><em>{lastEstimate}</em><span className={`${styles.badge} ${current ? styles.current : styles.previous}`}>{current ? "CURRENT INPUTS" : completion ? "PREVIOUS ESTIMATE" : "AWAITING FIRST ESTIMATE"}</span></div>
        <div className={styles.metric}><span><Icon name="people" size={14} />Remaining at run end</span><p>{result?.remaining ?? "—"}<small>people</small></p><em>{result ? `${result.trapped ?? 0} trapped · ${result.movingRemaining ?? result.remaining} with a route` : "Reported from simulated movement"}</em></div>
      </div>
      <div className={styles.body}>
        <div className={styles.forecast}>
          <div className={styles.sectionTop}><h3><Icon name="route" size={15} />Evacuation forecast</h3><span className={styles.runStatus}><span className={`${styles.statusDot} ${state.active ? styles.computing : current ? styles.ready : ""}`} />{status}</span></div>
          <p className={styles.explanation} role="status">{!automatic ? "Automatic estimates are paused. Your camera can stay connected." : state.reason || (current ? "This forecast matches the latest headcount and layout settings." : "Connect your iPhone, then keep its camera page visible to start live analysis.")}</p>
          {state.error ? <div className={styles.error} role="alert">{state.error} Fresh inputs will retry after the update interval.</div> : null}
          {completion ? <>
            {!current ? <p className={styles.outdated}><Icon name="clock" size={13} />This shows a previous estimate. {state.active ? `Calculating for ${state.active.count} people…` : state.nextRunAt ? `Next update in ${Math.max(0, Math.ceil((state.nextRunAt - feed.now) / 1_000))}s.` : "Waiting for fresh, valid camera data."}</p> : null}
            <ForecastPlayback key={completion.result.id} completion={completion} />
            <div className={styles.resultFacts}><span>{result!.exited} / {completion.count} evacuated</span><span>{result!.peakDensity.toFixed(1)} peak people / m²</span><span>{result!.scenario.behaviorMode === "behavioral" ? "Natural" : "Direct"} evacuation</span></div>
            <div className={styles.exits}><h4>Exit use</h4>{completion.plan.exits.map(exit => <div key={exit.id}><span>{exit.label}{completion.scenario.blockedExitIds?.includes(exit.id) ? " · blocked" : ""}</span><strong>{result!.perExitCounts?.[exit.id] ?? 0} people</strong></div>)}</div>
          </> : <div className={styles.empty}>
            <div className={styles.emptyPlan}><FloorPlanView plan={plan} result={null} mode="simulation" selectedId={null} onSelect={() => undefined} onMove={() => undefined} time={0} showPeople={false} showRoutes={false} showDensity={false} zoom={1} blockedExitIds={scenario.blockedExitIds} /></div>
            <div className={styles.emptyLabel}><span><Icon name={state.active ? "clock" : "video"} size={21} /></span><h4>{state.active ? `Simulating ${state.active.count} people` : "Your live forecast starts here"}</h4><p>{state.active ? "Calculating routes and movement through this floor plan." : "Connect your iPhone camera. Fresh crowd data will run the first simulation automatically."}</p></div>
          </div>}
          <p className={styles.assumptions}>Camera data supplies the headcount. Starting positions are generated from your layout and placement settings; individual camera positions are not tracked. This is a simulation estimate.</p>
        </div>
        <aside className={styles.camera} aria-label="Live analytics camera connection"><div className={styles.sectionTop}><h3><Icon name="video" size={15} />Venue camera</h3><span className={styles.cameraTag}>IPHONE</span></div><p className={styles.cameraIntro}>Connect once. The same feed is available in Venue images.</p><LiveCrowdFeed purpose="analytics" busy={busy} blockedReason="" /><p className={styles.interval}>Forecasts refresh when the headcount or layout changes, at most once every 10 seconds. Zero, above-limit and stale counts wait for a valid frame.</p></aside>
      </div>
      {history.length ? <div className={styles.history}><div className={styles.sectionTop}><h3><Icon name="clock" size={14} />Recent estimates</h3><span>THIS CONNECTION</span></div><div className={styles.tableWrap}><table><thead><tr><th>Calculated</th><th>People</th><th>Evacuation estimate</th><th>Remaining</th></tr></thead><tbody>{history.map(item => <tr key={item.result.id}><td>{elapsed(item.completedAt, feed.now)}</td><td>{item.count}</td><td>{clearance(item.result) === null ? "Incomplete" : `${clearance(item.result)!.toFixed(1)} s`}</td><td>{item.result.remaining}</td></tr>)}</tbody></table></div></div> : null}
    </section>
  );
}
