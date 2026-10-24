"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AppHeader from "./app-header";
import AppFooter from "./app-footer";
import { validatePlan } from "@/lib/plan-validation";
import { runBackendSimulation } from "@/lib/backend-simulation";
import { createWorkspace, updateWorkspace } from "@/lib/workspace-store";
import FloorPlanView from "./floor-plan";
import Icon, { type IconName } from "./icon";
import ScaleCalibrator, {type PendingCalibration} from "./scale-calibrator";
import GeometryPanel from "./geometry-panel";
import WorkspaceSidebar from "./workspace-sidebar";
import WorkspaceSources from "./workspace-sources";
import {nativeLayout, type GeometrySelection, type GeometryTool} from "@/lib/native-editor";
import { IMAGE_UPLOAD_SIZE_ERROR, prepareImageUpload } from "@/lib/image-upload";
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
type ProviderStatus = Record<string, {configured: boolean; busy: boolean; elapsed_seconds: number}>;
const signature = (plan: FloorPlan, scenario: Scenario) =>
  JSON.stringify({ plan, scenario });
const formatTime = (n: number) => `${n.toFixed(1)} s`;
const clonePlan = (plan: FloorPlan) =>
  JSON.parse(JSON.stringify(plan)) as FloorPlan;
const clearance = (run: SimulationResult) =>
  run.remaining ? null : (run.clearanceTime ?? run.totalTime);
const clearanceLabel = (run: SimulationResult) => {
  const value = clearance(run);
  return value === null ? "Incomplete" : formatTime(value);
};

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

type WorkspaceProps = {
  workspaceId: string;
  workspaceName: string;
  initialPlan: FloorPlan;
  initialScenario: Scenario;
  isSample: boolean;
  ownerId: string | null;
};

export default function Workspace({
  workspaceId,
  workspaceName,
  initialPlan,
  initialScenario,
  isSample,
  ownerId,
}: WorkspaceProps) {
  const router = useRouter();
  const [plan, setPlan] = useState<FloorPlan>(() => clonePlan(initialPlan));
  const [scenario, setScenario] = useState<Scenario>(() => ({
    ...initialScenario,
  }));
  const [mode, setMode] = useState<Mode>("layout");
  const [sidebarTab, setSidebarTab] = useState<"sources" | "editing">("sources");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<FloorPlan[]>([]);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const preview = useMemo(
    () => plan.native ? null : runSimulation(plan, scenario),
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
  const [imageProvider, setImageProvider] = useState("gemini");
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({});
  const [providerStatusError, setProviderStatusError] = useState("");
  const [pendingCalibration,setPendingCalibration]=useState<PendingCalibration|null>(null);
  const [calibratingExisting,setCalibratingExisting]=useState(false);
  const [geometrySelection,setGeometrySelection]=useState<GeometrySelection>(null);
  const [geometryTool,setGeometryTool]=useState<GeometryTool>("select");
  const [showReference,setShowReference]=useState(true);
  const [referenceOpacity,setReferenceOpacity]=useState(.35);
  const [notice, setNotice] = useState("");
  const [runError, setRunError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [copyError, setCopyError] = useState("");
  const [savedSetup, setSavedSetup] = useState(() =>
    signature(initialPlan, initialScenario),
  );
  const savedSignature = useRef(signature(initialPlan, initialScenario));
  const pendingSetup = useRef({ plan, scenario });
  const openingSetup = useRef({
    plan: clonePlan(initialPlan),
    scenario: { ...initialScenario },
  });
  const runController = useRef<AbortController | null>(null);
  const currentTime = useRef(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const persistWorkspace = useCallback(() => {
    if (isSample || !ownerId) return true;
    const currentSignature = signature(plan, scenario);
    if (currentSignature === savedSignature.current) return true;
    try {
      updateWorkspace(ownerId, workspaceId, { plan, scenario });
      savedSignature.current = currentSignature;
      setSavedSetup(currentSignature);
      setSaveError("");
      return true;
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "This workspace could not be saved. Export a copy before leaving.",
      );
      return false;
    }
  }, [isSample, ownerId, workspaceId, plan, scenario]);

  useEffect(() => {
    pendingSetup.current = { plan, scenario };
    if (isSample || signature(plan, scenario) === savedSetup) return;
    const timer = setTimeout(persistWorkspace, 150);
    return () => clearTimeout(timer);
  }, [isSample, plan, scenario, savedSetup, persistWorkspace]);

  useEffect(() => {
    if (isSample || !ownerId) return;
    function flush() {
      const pending = pendingSetup.current;
      const currentSignature = signature(pending.plan, pending.scenario);
      if (currentSignature === savedSignature.current) return true;
      try {
        updateWorkspace(ownerId!, workspaceId, pending);
        savedSignature.current = currentSignature;
        return true;
      } catch {
        return false;
      }
    }
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!flush()) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", beforeUnload);
      flush();
    };
  }, [isSample, ownerId, workspaceId]);

  useEffect(
    () => () => {
      runController.current?.abort();
      runController.current = null;
    },
    [],
  );

  function saveCopy() {
    if (!ownerId) return;
    try {
      const record = createWorkspace(ownerId, {
        name: `${workspaceName} copy`.slice(0, 80),
        plan,
        scenario,
      });
      router.push(`/workspaces/${record.id}`);
    } catch (error) {
      setCopyError(
        error instanceof Error
          ? error.message
          : "The copy could not be saved. Export this workspace to keep your work.",
      );
    }
  }

  useEffect(() => {
    if (modal) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [modal]);

  useEffect(() => {
    if (modal !== "upload") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch("/api/floorplans", {cache: "no-store", signal: controller.signal});
        if (!response.ok) throw new Error("Provider status unavailable.");
        const status: ProviderStatus = await response.json();
        if (!controller.signal.aborted) {
          setProviderStatus(status);
          setProviderStatusError("");
        }
      } catch {
        if (!controller.signal.aborted) {
          setProviderStatus({});
          setProviderStatusError("Could not check provider status. An upload will check again.");
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => {controller.abort(); clearTimeout(timer);};
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
  const sameEngine = Boolean(
    baseline && result && baseline.engine === result.engine &&
    baseline.engineVersion === result.engineVersion,
  );
  const canCompare = Boolean(
    baseline && result && baseline.id !== result.id && sameEngine,
  );
  const sameScenario = Boolean(
    baseline &&
      result &&
      JSON.stringify(baseline.scenario) === JSON.stringify(result.scenario),
  );
  const shownPlan = mode === "layout" ? plan : (result?.plan ?? plan);
  const shownResult = mode === "layout" ? (!stale && result ? result : preview) : result;
  const evacuated = result ? getEvacuatedCount(result, time) : 0;
  const duration = Math.max(
    result?.totalTime ?? 60,
    mode === "compare" ? (baseline?.totalTime ?? 0) : 0,
  );
  const resultDifference =
    baseline && result && clearance(baseline) !== null && clearance(result) !== null
      ? clearance(result)! - clearance(baseline)!
      : 0;
  const structuralChanges = baseline?.plan.native&&result?.plan.native
    ? (["walls","doors","exits"] as const).reduce((count,kind)=>{
      const before=nativeLayout(baseline.plan)[kind],after=nativeLayout(result.plan)[kind];
      return count+new Set([...before,...after].filter(item=>JSON.stringify(before.find(old=>old.id===item.id))!==
        JSON.stringify(after.find(next=>next.id===item.id))).map(item=>item.id)).size;
    },0):0;
  const layoutChanges = structuralChanges + (
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
      : 0);
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
    setGeometrySelection(null);
    setGeometryTool("select");
  }
  function acceptImport(data: {plan: unknown;warnings?:string[]}) {
    const next=validatePlan(data.plan);
    editPlan(next);setSelectedId(null);setGeometrySelection(null);setGeometryTool("select");
    setMode("layout");setModal(null);setPendingCalibration(null);setError("");setRunError("");
    const calibration=next.native?nativeLayout(next).source_image?.calibration:null;
    setNotice((calibration?.method==="automatic"?`Scale detected from ${calibration.label}. `:"")+
      "Floor plan imported. Review walls, doors, and exits before running."+(data.warnings?.length?" "+data.warnings.join(" "):""));
  }
  async function finishScale(reference: Parameters<React.ComponentProps<typeof ScaleCalibrator>["onApply"]>[0]) {
    if(!pendingCalibration||busy)return;
    setBusy(true);setError("");
    try {
      const response=await fetch("/api/floorplans",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(calibratingExisting?{editor_plan:plan,manual_scale:reference}:
          {extraction_id:pendingCalibration.extraction_id,manual_scale:reference})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"Could not apply the measurement.");
      acceptImport(data);
    } catch(cause){setError(cause instanceof Error?cause.message:"Could not apply the measurement.");}
    finally{setBusy(false);}
  }
  async function checkLayout() {
    if(busy||!plan.native)return;
    setBusy(true);setRunError("");
    try {
      const response=await fetch("/api/floorplans",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({editor_plan:plan})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"Could not check the layout.");
      const checked=validatePlan(data.plan);editPlan(checked);
      setNotice(checked.native?.issues?.length?"Review the layout issues below.":"Geometry checks passed. Ready to simulate.");
    }catch(cause){setRunError(cause instanceof Error?cause.message:"Could not check the layout.");}
    finally{setBusy(false);}
  }
  async function run() {
    if (runController.current) {
      runController.current.abort();
      runController.current = null;
      setBusy(false);
      setRunError("");
      setNotice("Run cancelled. Your setup is unchanged.");
      return;
    }
    const controller = new AbortController();
    runController.current = controller;
    const submittedPlan = clonePlan(plan);
    const submittedScenario = { ...scenario };
    setBusy(true);
    setRunError("");
    setPlaying(false);
    try {
      const next = await runBackendSimulation(submittedPlan, submittedScenario, {
        signal: controller.signal,
      });
      if (runController.current !== controller || controller.signal.aborted) return;
      setResult(next);
      setTime(0);
      setMode("simulation");
      setRunCount((count) => count + 1);
      setPlaying(next.totalTime > 0 && !reducedMotion());
      setNotice(
        next.remaining
          ? `Time limit reached with ${next.remaining} ${next.remaining === 1 ? "person" : "people"} remaining. Inspect the recorded movement and exits.`
          : "Run complete. Inspect playback or pin this run as your baseline.",
      );
    } catch (error) {
      if (runController.current !== controller || controller.signal.aborted) return;
      setRunError(
        error instanceof Error
          ? error.message
          : "The simulation could not finish. Your current setup is unchanged.",
      );
    } finally {
      if (runController.current === controller) {
        runController.current = null;
        setBusy(false);
      }
    }
  }
  async function upload(file: File | undefined) {
    if (!file || busy) return;
    const image = /\.(png|jpe?g|webp)$/i.test(file.name);
    if (file.size > (image ? 10 : 1) * 1024 * 1024) {
      setError(
        "Choose a JSON floor plan below 1 MB, or PNG/JPEG/WebP below 10 MB.",
      );
      return;
    }
    setBusy(true);
    setError("");
    setPendingCalibration(null);
    setCalibratingExisting(false);
    setNotice(image ? "Extracting the image. This can take a few minutes…" : "Importing floor plan…");
    try {
      let data;
      if (image) {
        data = {...await prepareImageUpload(file),provider:imageProvider};
      } else data = JSON.parse(await file.text());
      const raw = data.plan ?? data;
      let warnings: string[] = [];
      if (image || raw.walkable_areas) {
        const response = await fetch("/api/floorplans",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify(image ? data : {layout:raw})});
        if (response.status === 413) throw new Error(IMAGE_UPLOAD_SIZE_ERROR);
        const imported = await response.json().catch(() => null);
        if (!imported || typeof imported !== "object") throw new Error("The floor plan service returned an unreadable response. Try again shortly.");
        if(!response.ok) throw new Error(imported.error || "The floor plan could not be imported.");
        if(imported.needs_scale){setPendingCalibration(imported);setNotice("");return;}
        data = imported; warnings=imported.warnings ?? [];
      }
      acceptImport({plan:data.plan??data,warnings});
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? "This file is not valid JSON. Choose a Crowdy floor plan or download the sample below."
          : cause instanceof Error
            ? cause.message
            : "This floor plan could not be opened. Try the sample JSON.",
      );
    } finally {setBusy(false);if (uploadRef.current) uploadRef.current.value = "";}
  }
  function reset() {
    if (busy) return;
    editPlan(clonePlan(openingSetup.current.plan));
    setScenario({ ...openingSetup.current.scenario });
    setSelectedId(null);
    setMode("layout");
    setModal(null);
    setNotice(
      "Opening layout restored. Your previous layout is available with Undo.",
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
              model: result.engine === "jupedsim"
                ? "JuPedSim CollisionFreeSpeedModel"
                : "Crowdy illustrative grid model",
              engine: result.engine,
              engineVersion: result.engineVersion,
              modelSettings: result.modelSettings,
              status: result.status,
              plan: result.plan,
              scenario: result.scenario,
              totalTime: result.totalTime,
              clearanceTime: clearance(result),
              averageTime: result.averageTime,
              exited: result.exited,
              remaining: result.remaining,
              peakDensity: result.peakDensity,
              perExitCounts: result.perExitCounts,
            }
          : null,
      },
      "crowdy-workspace.json",
    );
    setNotice("Workspace exported as JSON.");
  }
  const planProps = {
    selectedId: mode === "layout" ? selectedId : null,
    onSelect: (id:string|null)=>{
      setSelectedId(id);
      setGeometrySelection(null);
      if (id) setSidebarTab("editing");
    },
    onMove: moveItem,
    mode,
    time: mode === "layout" ? 0 : time,
    showPeople: layers.people,
    showRoutes: layers.routes,
    showDensity: layers.density,
    zoom,
    showReference:mode==="layout"&&showReference,
    referenceOpacity,
    geometrySelection,
    geometryTool,
    onGeometrySelect:(selection:GeometrySelection)=>{
      setGeometrySelection(selection);
      setSelectedId(null);
      if (selection) setSidebarTab("editing");
    },
    onGeometryChange:busy?undefined:editPlan,
    onGeometryToolDone:()=>setGeometryTool("select"),
  };

  return (
    <div className="app-shell">
      <AppHeader
        workspaceName={workspaceName}
        onHelp={() => setModal("help")}
        onNavigate={persistWorkspace}
      />
      <div className="project-bar">
        <div>
          <h1>{workspaceName}</h1>
          <p>
            <span className="status-dot" />
            {isSample
              ? "Sample workspace"
              : saveError
                ? "Changes not saved"
                : savedSetup !== signature(plan, scenario)
                  ? "Saving changes…"
                  : "Saved on this device"}
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
      {isSample && (
        <div className="workspace-context-strip">
          <p>
            This sample is available to everyone. Changes here are temporary.
          </p>
          {ownerId ? (
            <button className="button secondary" onClick={saveCopy}>
              <Icon name="plus" size={15} />
              Make a copy
            </button>
          ) : (
            <a className="button secondary" href="/auth/login?returnTo=/">
              Sign in to create a workspace
            </a>
          )}
        </div>
      )}
      {(saveError || copyError) && (
        <div className="workspace-save-error" role="alert">
          <span>{saveError || copyError}</span>
          {saveError && (
            <button className="text-button" onClick={persistWorkspace}>
              Retry saving
            </button>
          )}
          <button className="text-button" onClick={exportSetup}>
            Export a copy
          </button>
        </div>
      )}
      {runError && (
        <div className="workspace-save-error" role="alert">
          <span>{runError}</span>
          <button className="text-button" onClick={run} disabled={busy}>
            Retry run
          </button>
        </div>
      )}
      <main className="workspace-grid">
        <WorkspaceSidebar
          activeTab={sidebarTab}
          onTabChange={(tab) => {
            setSidebarTab(tab);
            if (tab === "editing") {
              setMode("layout");
              setPlaying(false);
            }
          }}
          sources={
            <WorkspaceSources
              key={`${ownerId ?? "guest"}:${workspaceId}`}
              plan={plan}
              workspaceId={workspaceId}
              ownerId={ownerId}
              isSample={isSample}
              busy={busy}
              onUploadFloorPlan={() => {
                setModal("upload");
                setError("");
              }}
              onUseCrowdEstimate={(occupancy) => {
                setScenario((current) => ({ ...current, occupancy }));
                setNotice(`Venue crowd estimate applied: ${occupancy} people.`);
              }}
            >
              <div className="scale-row">
                <span>Plan scale</span>
                <span className="mono">
                  {(plan.native?.transform.pixels_per_metre ?? 32).toFixed(1)} px / m <Icon name="check" size={12} />
                </span>
              </div>
              {plan.native && nativeLayout(plan).source_image?.calibration && (
                <p className="helper scale-evidence">
                  {nativeLayout(plan).source_image!.calibration!.method === "automatic"
                    ? "Detected from: "
                    : "Calibrated from: "}
                  {nativeLayout(plan).source_image!.calibration!.label}
                </p>
              )}
              {plan.native?.image && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    const source = nativeLayout(plan).source_image!;
                    setCalibratingExisting(true);
                    setError("");
                    setPendingCalibration({
                      needs_scale: true,
                      extraction_id: "recalibrate",
                      image_id: source.id,
                      width_px: source.width_px,
                      height_px: source.height_px,
                      reason: "Mark a known distance to correct the current scale. Your wall, door, and furniture edits will be preserved.",
                    });
                    setModal("upload");
                  }}
                >
                  Edit scale
                </button>
              )}
            </WorkspaceSources>
          }
        >
          <section className="setup-section layout-section">
            <div className="section-heading">
              <Icon name="layout" size={17} />
              <h2>Layout</h2>
              <span className="section-count">{plan.items.length} objects</span>
            </div>
            <p className="helper">Select furniture on the plan to move it.</p>
            {mode==="layout"&&<GeometryPanel plan={plan} selection={geometrySelection} tool={geometryTool} busy={busy}
              onChange={editPlan} onSelect={selection=>{setGeometrySelection(selection);setSelectedId(null);}} onTool={setGeometryTool} onCheck={checkLayout}
              overlay={showReference} onOverlay={setShowReference} opacity={referenceOpacity} onOpacity={setReferenceOpacity}/>}
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
              <Icon name="people" size={17} />
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
              <label className="field-label" htmlFor="population-seed">Placement seed</label>
              <input id="population-seed" type="number" min="0" max="4294967295" step="1" value={scenario.seed ?? 42}
                onChange={event=>{const seed=Number(event.target.value); if(Number.isInteger(seed)&&seed>=0&&seed<=4294967295)
                  setScenario({...scenario,seed});}} />
              <label className="field-label" htmlFor="distribution">Starting distribution</label>
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
              disabled={busy}
              onClick={() => setModal("reset")}
            >
              Reset layout
            </button>
          </div>
        </WorkspaceSidebar>
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
                    ? plan.native ? "Editing imported geometry · run to place people" : "Editing layout · placement preview"
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
                    <strong>{clearanceLabel(baseline)}</strong>
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
                    <strong>{clearanceLabel(result)}</strong>
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
                    setSidebarTab("editing");
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
          {result && (
            <p className="results-subtitle">
              {`${result.scenario.occupancy} people · ${result.plan.exits.length} exits · ${result.scenario.mobility === "standard" ? "Standard" : "Mixed"} walking`}
            </p>
          )}
          {stale && (
            <div className="result-stale">Inputs changed since this run</div>
          )}
          <div className="primary-metric">
            <span>
              Simulated evacuation time{" "}
              <button
                className="inline-help"
                aria-label="Evacuation time definition"
                title="Time until everyone exits. Unavailable if anyone remains at the simulation time limit."
                onClick={() => setModal("help")}
              >
                <Icon name="help" size={12} />
              </button>
            </span>
            <div>
              {result && clearance(result) !== null ? clearance(result)!.toFixed(1) : "—"}
              <span>seconds</span>
            </div>
            <p>
              {result
                ? result.remaining
                  ? `${result.exited} exited · ${result.remaining} remaining at ${formatTime(result.totalTime)}`
                  : `${result.exited} people reached an exit`
                : "Time until everyone reaches an exit"}
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
              <span title="Highest sampled density in a 2 m × 2 m cell across the run">
                Peak sampled density
              </span>
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
            {result?.perExitCounts && Object.entries(result.perExitCounts).map(([id, count]) => (
              <div key={id}>
                <span>Via {result.plan.exits.find((exit) => exit.id === id)?.label ?? id}</span>
                <strong>{count}<small> {count === 1 ? "person" : "people"}</small></strong>
              </div>
            ))}
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
                    {clearanceLabel(baseline)}
                  </strong>
                </div>
                <p className="helper">
                  {result && !sameEngine
                    ? "These runs use different models. Clear the baseline and pin a run from the current model."
                    : canCompare
                    ? baseline &&
                      result &&
                      (baseline.remaining || result.remaining)
                      ? "Incomplete runs. Compare people remaining; evacuation times are unavailable until everyone exits."
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
                  disabled={!result || stale || busy}
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
      <AppFooter />
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
                ? "Restore the opening layout?"
                : "Simulation assumptions"}
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
              Import a frontend or backend Crowdy JSON layout, or extract an image.
              Uploading replaces your layout; Undo restores it. Imported furniture stays editable.
            </p>
            <label className="field-label" htmlFor="image-provider">Image extraction provider</label>
            <select id="image-provider" value={imageProvider} disabled={busy} onChange={e=>setImageProvider(e.target.value)}>
              <option value="gemini">Gemini</option><option value="claude">Claude</option>
            </select>
            <p className="muted" role="status">
              {providerStatusError || (providerStatus[imageProvider]?.busy
                ? `${imageProvider === "gemini" ? "Gemini" : "Claude"} is processing an image (${providerStatus[imageProvider].elapsed_seconds}s elapsed). Image requests stop after about 3 minutes. ${busy ? "Wait for this request to finish." : "Choose the other provider or import JSON while this image is processing."}`
                : providerStatus[imageProvider]?.configured === false
                  ? "This provider needs an API key in the server’s .env file."
                  : providerStatus[imageProvider] ? "This provider is ready for an image." : "Checking provider status…")}
            </p>
            <p className="muted">Scale is detected from printed dimensions or a scale bar. If none is readable, you can mark one known distance afterward. Images are resized to 1092 pixels on the longest edge before being sent to your selected provider; crop dense plans for clearer detail.</p>
            {pendingCalibration&&<ScaleCalibrator key={pendingCalibration.extraction_id} pending={pendingCalibration} busy={busy} onApply={finishScale}/>}
            <button
              className="upload-dropzone"
              disabled={busy}
              onClick={() => uploadRef.current?.click()}
            >
              <Icon name="upload" size={26} />
              <strong>{busy ? "Importing floor plan…" : "Choose a floor plan"}</strong>
              <span>JSON up to 1 MB · PNG, JPEG, WebP up to 10 MB</span>
            </button>
            <input
              ref={uploadRef}
              className="visually-hidden"
              type="file"
              accept=".json,.png,.jpg,.jpeg,.webp,application/json,image/png,image/jpeg,image/webp"
              aria-label="Choose floor plan file"
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
              PNG, JPEG, and WebP extraction uses your server’s provider key.
              Export PDF pages as images first. Imported walls, doors, exits, and furniture can be corrected in this workspace.
            </p>
          </>
        ) : modal === "reset" ? (
          <>
            <p>
              This restores the layout and scenario from when you opened this
              workspace. Your previous layout remains available through Undo;
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
                Restore layout
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
                  32 canvas pixels represent 1 metre. Walls define the floor
                  bounds; wall segments and furniture block movement. Boundary
                  exits include a short landing beyond the floor. Review
                  imported geometry before running.
                </dd>
              </div>
              <div>
                <dt>Movement</dt>
                <dd>
                  JuPedSim uses a collision-free speed model. People choose an
                  exit once using the shortest routed distance around obstacles;
                  they do not switch destinations to avoid congestion.
                </dd>
              </div>
              <div>
                <dt>Reported time</dt>
                <dd>
                  Evacuation time is available only when everyone exits.
                  Otherwise the run stops at 60 simulated seconds and keeps
                  remaining people visible. Average exit time counts only people
                  who reached an exit.
                </dd>
              </div>
              <div>
                <dt>Playback</dt>
                <dd>
                  Playback follows recorded positions and their simulation
                  timestamps. 1× advances one simulated second per real second.
                  Reduced motion starts runs paused.
                </dd>
              </div>
              <div>
                <dt>Your work</dt>
                <dd>
                  {isSample
                    ? "Sample edits are temporary. Make a personal copy to keep them, or export this layout."
                    : "This workspace is saved for your account on this device. Runs and baselines last for this session; export to keep a separate copy."}
                </dd>
              </div>
            </dl>
            <p className="dialog-note">
              Runs are computed by the simulation service. Layout people are
              placement previews for the sample. Image extraction uses the selected provider and scale; imported layouts use the native geometry. Export PDF pages as images first.
            </p>
          </>
        )}
      </dialog>
    </div>
  );
}
