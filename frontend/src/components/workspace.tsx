"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AppHeader from "./app-header";
import AppFooter from "./app-footer";
import { awaitFloorPlanImport, FLOOR_PLAN_IMPORT_TIMEOUT_MS, FLOOR_PLAN_IMPORT_TIMEOUT_MESSAGE } from "@/lib/floorplan-import";
import { validatePlan } from "@/lib/plan-validation";
import { runBackendSimulation, sameStartingPopulation } from "@/lib/backend-simulation";
import { createWorkspace, updateWorkspace } from "@/lib/workspace-store";
import FloorPlanView from "./floor-plan";
import RoomPopulationPanel from "./room-population-panel";
import {adaptPopulationPreview, placementKey, populationPreviewState, startingPopulation, type PopulationPreview} from "@/lib/room-population";
import Icon, { type IconName } from "./icon";
import ScaleCalibrator, {type PendingCalibration} from "./scale-calibrator";
import GeometryPanel from "./geometry-panel";
import WorkspaceSidebar from "./workspace-sidebar";
import WorkspaceSources from "./workspace-sources";
import LiveCrowdProvider from "./live-crowd-provider";
import LiveEvacuationAnalytics from "./live-evacuation-analytics";
import {nativeLayout, type GeometrySelection, type GeometryTool} from "@/lib/native-editor";
import { IMAGE_UPLOAD_SIZE_ERROR, prepareImageUpload } from "@/lib/image-upload";
import pofaVerifiedDemo from "@/lib/demos/pofa-verified.json";
import {isSupportedCrowdSize, MAX_CROWD_SIZE} from "@/lib/crowd-limits";
import {
  SAMPLE_PLAN,
  getEvacuatedCount,
  type FloorPlan,
  type PlanItem,
  type Scenario,
  type SimulationResult,
} from "@/lib/simulation";

type Mode = "layout" | "simulation" | "compare" | "live";
type ProviderStatus = Record<string, {configured: boolean; busy: boolean; elapsed_seconds: number; model?: string}>;
function providerLabel(provider: string, model?: string) {
  if (model === "google/gemini-3.8-flash" || model === "gemini-3.8-flash") return "Gemini 3.8 Flash";
  if (model === "anthropic/claude-sonnet-5.5" || model === "claude-sonnet-5.5" || model === "claude-sonnet-5-5") return "Claude Sonnet 5.5";
  return provider === "gemini" ? "Gemini" : "Claude";
}
const signature = (plan: FloorPlan, scenario: Scenario) =>
  JSON.stringify({ plan, scenario });
const formatTime = (n: number) => `${n.toFixed(1)} s`;
const clonePlan = (plan: FloorPlan) =>
  JSON.parse(JSON.stringify(plan)) as FloorPlan;
const verifiedPofaSourceHash = "a72b738f246de744080114beb74b848130068e880372acdfc6c7bbf99b9449ef";
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

export default function Workspace(props: WorkspaceProps) {
  return <LiveCrowdProvider scope={`${props.ownerId ?? "guest"}:${props.workspaceId}`}><WorkspaceContent key={props.workspaceId} {...props} /></LiveCrowdProvider>;
}

function WorkspaceContent({
  workspaceId,
  workspaceName,
  initialPlan,
  initialScenario,
  isSample,
  ownerId,
}: WorkspaceProps) {
  const router = useRouter();
  const viewId = useId();
  const [plan, setPlan] = useState<FloorPlan>(() => clonePlan(initialPlan));
  const itemBounds = plan.id === SAMPLE_PLAN.id && plan.walls.length ? {
    left: Math.min(...plan.walls.flatMap(wall => [wall.x1, wall.x2])) + 4,
    right: Math.max(...plan.walls.flatMap(wall => [wall.x1, wall.x2])) - 4,
    top: Math.min(...plan.walls.flatMap(wall => [wall.y1, wall.y2])) + 4,
    bottom: Math.max(...plan.walls.flatMap(wall => [wall.y1, wall.y2])) - 4,
  } : {left: 0, right: plan.width, top: 0, bottom: plan.height};
  const [scenario, setScenario] = useState<Scenario>(() => ({
    ...initialScenario,
    distribution: initialScenario.distribution === "rooms" || initialScenario.distribution === "workstations" ? "normal" : initialScenario.distribution,
  }));
  const [mode, setMode] = useState<Mode>("layout");
  const [sidebarTab, setSidebarTab] = useState<"sources" | "editing">("sources");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<FloorPlan[]>([]);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [baseline, setBaseline] = useState<SimulationResult | null>(null);
  const [populationPreview, setPopulationPreview] = useState<PopulationPreview | null>(null);
  const [placementStatus, setPlacementStatus] = useState({key:"",loading:false,error:""});
  const [placementRetry, setPlacementRetry] = useState(0);
  const populationKey = useMemo(()=>placementKey(plan,scenario,baseline),[plan,scenario,baseline]);
  const placement = populationPreviewState(populationKey, populationPreview, placementStatus);
  const currentPopulation = placement.preview;
  const [runCount, setRunCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState("");
  const [liveRunning, setLiveRunning] = useState(false);
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
  const [imageProvider, setImageProvider] = useState("claude");
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
  const [copying, setCopying] = useState(false);
  const accountController = useRef<AbortController | null>(null);
  const saveOperation = useRef<Promise<boolean> | null>(null);
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
  const importController = useRef<AbortController | null>(null);
  const currentTime = useRef(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const geometryPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    accountController.current = controller;
    return () => controller.abort();
  }, [ownerId, workspaceId]);

  const persistWorkspace = useCallback(async (): Promise<boolean> => {
    if (isSample || !ownerId) return true;
    const controller = accountController.current;
    if (!controller || controller.signal.aborted) return false;
    if (saveOperation.current) return saveOperation.current;
    const operation = (async () => {
      try {
        // Coalesce edits made while a save is pending. The store also serializes
        // mutations and sends the last acknowledged revision to the server.
        while (!controller.signal.aborted) {
          const pending = pendingSetup.current;
          const currentSignature = signature(pending.plan, pending.scenario);
          if (currentSignature === savedSignature.current) return true;
          await updateWorkspace(ownerId, workspaceId, pending, { signal: controller.signal });
          if (controller.signal.aborted) return false;
          savedSignature.current = currentSignature;
          setSavedSetup(currentSignature);
          setSaveError("");
        }
        return false;
      } catch (error) {
        if (!controller.signal.aborted) setSaveError(error instanceof Error ? error.message : "This workspace could not be saved. Try again before leaving.");
        return false;
      }
    })();
    saveOperation.current = operation;
    void operation.finally(() => { if (saveOperation.current === operation) saveOperation.current = null; });
    return operation;
  }, [isSample, ownerId, workspaceId]);

  useEffect(() => {
    pendingSetup.current = { plan, scenario };
    if (isSample || signature(plan, scenario) === savedSetup) return;
    const timer = setTimeout(() => { void persistWorkspace(); }, 150);
    return () => clearTimeout(timer);
  }, [isSample, plan, scenario, savedSetup, persistWorkspace]);

  useEffect(() => {
    if (isSample || !ownerId) return;
    function flush() {
      const pending = pendingSetup.current;
      if (signature(pending.plan, pending.scenario) === savedSignature.current || saveOperation.current) return;
      // Page shutdown is best effort: do not claim a save until its response.
      // Large snapshots cannot use the browser's 64 KiB keepalive allowance.
      if (new TextEncoder().encode(JSON.stringify(pending)).byteLength >= 59 * 1024) return;
      void updateWorkspace(ownerId!, workspaceId, pending, { keepalive: true }).catch(() => undefined);
    }
    function beforeUnload(event: BeforeUnloadEvent) {
      if (signature(pendingSetup.current.plan, pendingSetup.current.scenario) !== savedSignature.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [isSample, ownerId, workspaceId]);

  useEffect(
    () => () => {
      runController.current?.abort();
      runController.current = null;
      importController.current?.abort();
      importController.current = null;
    },
    [],
  );

  useEffect(() => {
    if (mode !== "layout") return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPlacementStatus({key:populationKey,loading:true,error:""});
      try {
        const response = await fetch("/api/populations", {method:"POST",headers:{"Content-Type":"application/json"},
          signal:controller.signal, body:JSON.stringify({plan,scenario:{...scenario,blocked_exit_ids:scenario.blockedExitIds ?? []},
            ...(baseline ? {starting_population:startingPopulation(baseline)} : {})})});
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not place people in this layout.");
        const next = adaptPopulationPreview(payload,plan,populationKey);
        if (next.people.length !== scenario.occupancy) throw new Error("The placement service returned a different crowd size.");
        if (controller.signal.aborted) return;
        setPopulationPreview(next);
        setPlacementStatus({key:populationKey,loading:false,error:""});
      } catch (cause) {
        if (controller.signal.aborted) return;
        setPlacementStatus({key:populationKey,loading:false,error:cause instanceof Error ? cause.message : "Placement failed."});
      }
    }, 350);
    return () => {clearTimeout(timer);controller.abort();};
  }, [plan, scenario, baseline, populationKey, mode, placementRetry]);

  async function saveCopy() {
    const controller = accountController.current;
    if (!ownerId || copying || !controller || controller.signal.aborted) return;
    setCopying(true);
    try {
      const record = await createWorkspace(ownerId, {
        name: `${workspaceName} copy`.slice(0, 80),
        plan,
        scenario,
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      router.push(`/workspaces/${record.id}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      setCopyError(
        error instanceof Error
          ? error.message
          : "The copy could not be saved. Export this workspace to keep your work.",
      );
    } finally {
      if (!controller.signal.aborted) setCopying(false);
    }
  }

  useEffect(() => {
    if (modal) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [modal]);

  useEffect(() => {
    if (modal !== "upload" || calibratingExisting) return;
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
  }, [modal, calibratingExisting]);

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
    baseline && result && baseline.id !== result.id && sameEngine && sameStartingPopulation(baseline, result),
  );
  const sameScenario = Boolean(
    baseline &&
      result &&
      JSON.stringify(baseline.scenario) === JSON.stringify(result.scenario),
  );
  const shownPlan = mode === "layout" ? plan : (result?.plan ?? plan);
  // Layout uses validated starting placement; recorded runs belong to playback.
  const shownResult = mode === "layout" ? null : result;
  const evacuated = result ? getEvacuatedCount(result, time) : 0;
  const responding = result?.agents.filter(agent => agent.outcome !== "trapped" && time < agent.delay).length ?? 0;
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
    if ((scenario.blockedExitIds ?? []).some(id => !next.exits.some(exit=>exit.id===id)))
      setScenario({...scenario,blockedExitIds:(scenario.blockedExitIds ?? []).filter(id=>next.exits.some(exit=>exit.id===id))});
  }
  function moveItem(id: string, x: number, y: number) {
    const item = plan.items.find((item) => item.id === id);
    if (!item) return;
    const nextX = Math.max(
      itemBounds.left,
      Math.min(itemBounds.right - item.width, Math.round(x)),
    );
    const nextY = Math.max(
      itemBounds.top,
      Math.min(itemBounds.bottom - item.height, Math.round(y)),
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
    editPlan(next);setBaseline(null);setResult(null);setPopulationPreview(null);setScenario({...scenario,blockedExitIds:[],distribution:"normal",population:{}});setSelectedId(null);setGeometrySelection(null);setGeometryTool("select");
    setMode("layout");setZoom(1);setModal(null);setPendingCalibration(null);setCalibratingExisting(false);setError("");setRunError("");
    const calibration=next.native?nativeLayout(next).source_image?.calibration:null;
    setNotice((calibration?.method==="automatic"?`Scale detected from ${calibration.label}. `:
      calibration?.method==="estimated"?"Scale estimated from doors and furniture. Edit scale to adjust it. ":"")+
      "Floor plan imported. Review walls, doors, and exits before running."+(data.warnings?.length?
        " "+data.warnings.slice(0,2).join(" ")+" See Extraction notes under Walls & doors for all observations.":""));
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
  function loadPofaDemo() {
    acceptImport(pofaVerifiedDemo);
    setScenario({occupancy:24,mobility:"standard",distribution:"normal",seed:42,bodyWidth:.46,behaviorMode:"idealized",blockedExitIds:[],population:{}});
    setNotice("Verified POFA demo loaded: 15 mapped exits and 24 people. Uses the saved 100 m demo measurement; Edit scale to change it.");
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

  function editScale() {
    if(busy||!plan.native?.image)return;
    const source=nativeLayout(plan).source_image;
    if(!source)return;
    setCalibratingExisting(true);
    setError("");
    setPendingCalibration({needs_scale:true,extraction_id:"recalibrate",image_id:source.id,
      width_px:source.width_px,height_px:source.height_px,
      current_width_m:source.width_px*source.meters_per_pixel,
      reason:"Mark a known distance or enter the full image width to correct the current scale. Your wall, door, and furniture edits will be preserved."});
    setModal("upload");
  }

  function inspectPlacementGeometry() {
    setSidebarTab("editing");
    setPlaying(false);
    setSelectedId(null);
    const match = /\b(Wall|Door|Exit) '([^']+)'/i.exec(placement.error);
    if (plan.native && match) {
      const kind=match[1].toLowerCase() as "wall"|"door"|"exit";
      const elements=nativeLayout(plan)[kind==="wall"?"walls":kind==="door"?"doors":"exits"];
      if(elements.some(element=>element.id===match[2])) {
        setGeometrySelection({kind,id:match[2]});
        setGeometryTool("select");
      }
    }
    requestAnimationFrame(() => {
      geometryPanelRef.current?.scrollIntoView({block: "nearest"});
      geometryPanelRef.current?.querySelector<HTMLElement>("select, button")?.focus();
    });
  }
  async function run() {
    if (liveRunning) return;
    if (busy && !running) return;
    if (runController.current) {
      runController.current.abort();
      runController.current = null;
      setBusy(false);
      setRunning(false);
      setRunProgress("");
      setRunError("");
      setNotice("Run cancelled. Your setup is unchanged.");
      return;
    }
    const controller = new AbortController();
    runController.current = controller;
    const submittedPlan = clonePlan(plan);
    const submittedScenario = { ...scenario };
    setBusy(true);
    setRunning(true);
    setRunProgress(`Preparing ${submittedScenario.occupancy.toLocaleString("en-US")} people…`);
    setRunError("");
    setPlaying(false);
    try {
      const next = await runBackendSimulation(submittedPlan, submittedScenario, {
        signal: controller.signal,
        baseline: baseline ?? undefined,
        onProgress: progress => {
          if (runController.current !== controller || controller.signal.aborted) return;
          const count = (progress.populationCount || submittedScenario.occupancy).toLocaleString("en-US");
          const elapsed = `${progress.elapsedSeconds.toFixed(1)} s processing`;
          setRunProgress(progress.phase === "placing" ? `Placing ${count} people · ${elapsed}` : progress.phase === "routing" ? `Calculating routes for ${count} people · ${elapsed}` : `Simulating ${count} people · ${progress.simulationTime.toFixed(1)} simulated seconds · ${progress.evacuatedCount.toLocaleString("en-US")} exited · ${elapsed}`);
        },
      });
      if (runController.current !== controller || controller.signal.aborted) return;
      setResult(next);
      setTime(0);
      setMode("simulation");
      setRunCount((count) => count + 1);
      setPlaying(next.scenario.occupancy <= 1000 && next.totalTime > 0 && !reducedMotion());
      setNotice(
        next.execution?.runtimeLimited
          ? `Processing time limit reached with ${next.remaining.toLocaleString("en-US")} people remaining. Inspect the incomplete recorded movement; a complete evacuation time is unavailable.`
          : next.trapped && !next.movingRemaining
          ? `${next.exited} evacuated; ${next.trapped} trapped with no available route. Trapped people remain visible in red.`
          : next.remaining
          ? `Time limit reached: ${next.trapped ?? 0} trapped and ${next.movingRemaining ?? next.remaining} with a route still inside; ${next.remaining} ${next.remaining === 1 ? "person" : "people"} remaining. Inspect the recorded movement and exits.`
          : next.scenario.occupancy > 1000 ? "Run complete. Playback is paused; press Play to inspect the full crowd." : "Run complete. Inspect playback or pin this run as your baseline.",
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
        setRunning(false);
        setRunProgress("");
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
    const controller = new AbortController();
    const deadline = image ? AbortSignal.timeout(FLOOR_PLAN_IMPORT_TIMEOUT_MS) : null;
    const signal = deadline ? AbortSignal.any([controller.signal, deadline]) : controller.signal;
    importController.current = controller;
    setBusy(true);
    setError("");
    setPendingCalibration(null);
    setCalibratingExisting(false);
    setNotice(image ? `Reading your floor plan with ${providerLabel(imageProvider, providerStatus[imageProvider]?.model)}…` : "Importing floor plan…");
    try {
      let data;
      if (image) {
        if (typeof crypto !== "undefined" && crypto.subtle) {
          const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
          const sourceHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("");
          signal.throwIfAborted();
          if (sourceHash === verifiedPofaSourceHash) {
            loadPofaDemo();
            return;
          }
        }
        const prepared = await prepareImageUpload(file);
        data = {filename: prepared.filename, image_base64: prepared.image_base64, provider:imageProvider,async_import:true};
      } else data = JSON.parse(await file.text());
      signal.throwIfAborted();
      const raw = data.plan ?? data;
      let warnings: string[] = [];
      if (image || raw.walkable_areas) {
        const response = await fetch("/api/floorplans",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify(image ? data : {layout:raw}), signal});
        if (response.status === 413) throw new Error(IMAGE_UPLOAD_SIZE_ERROR);
        let imported = await response.json().catch(() => null);
        if (!imported || typeof imported !== "object") throw new Error("The floor plan service returned an unreadable response. Try again shortly.");
        if(!response.ok) throw new Error(imported.error || "The floor plan could not be imported.");
        if (imported.job_id) imported = await awaitFloorPlanImport(imported.job_id, setNotice, signal);
        signal.throwIfAborted();
        if(imported.needs_scale){setPendingCalibration(imported);setNotice("");return;}
        data = imported; warnings=imported.warnings ?? [];
      }
      acceptImport({plan:data.plan??data,warnings});
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(
        deadline?.aborted
          ? FLOOR_PLAN_IMPORT_TIMEOUT_MESSAGE
          : cause instanceof SyntaxError
          ? "This file is not valid JSON. Choose a Crowdy floor plan or download the sample below."
          : cause instanceof Error
            ? cause.message
            : "This floor plan could not be opened. Try the sample JSON.",
      );
    } finally {
      if (importController.current === controller) {
        importController.current = null;
        if (!controller.signal.aborted) {
          setBusy(false);
          if (uploadRef.current) uploadRef.current.value = "";
        }
      }
    }
  }
  function reset() {
    if (busy) return;
    editPlan(clonePlan(openingSetup.current.plan));
    setScenario({ ...openingSetup.current.scenario });
    setBaseline(null);
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
        comparison: canCompare && baseline && result ? {
          sameStartingPeople: sameStartingPopulation(baseline,result), baseline, after: result,
          clearanceTimeChange: clearance(baseline) !== null && clearance(result) !== null ? clearance(result)!-clearance(baseline)! : null,
          evacuatedChange:result.exited-baseline.exited, trappedChange:(result.trapped??0)-(baseline.trapped??0),
        } : null,
        plan,
        scenario,
        result: result
          ? {
              model: result.engine === "jupedsim"
                ? "JuPedSim CollisionFreeSpeedModel"
                : "Crowdy illustrative grid model",
              engine: result.engine,
              engineVersion: result.engineVersion,
              execution: result.execution,
              modelSettings: result.modelSettings,
              bodyWidthMetres: result.agentRadius === undefined ? undefined : 2 * result.agentRadius,
              exitWidthsMetres: result.exitWidths,
              placementExcludedArea: result.placementExcludedArea,
              trapped: result.trapped,
              movingRemaining: result.movingRemaining,
              startingOccupants: result.startingOccupants,
              behaviorVersion: result.behaviorVersion,
              exitChanges: result.exitChanges,
              individualBehavior: result.agents.map(agent => ({id:agent.sourceId, responseDelay:agent.delay, desiredSpeed:agent.desiredSpeed})),
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
    mode: mode === "live" ? "simulation" as const : mode,
    time: mode === "layout" ? 0 : time,
    showPeople: layers.people,
    showRoutes: layers.routes,
    showDensity: layers.density,
    zoom,
    showReference:mode==="layout"&&showReference,
    referenceOpacity,
    geometrySelection,
    blockedExitIds: scenario.blockedExitIds,
    placement: mode === "layout" ? currentPopulation : null,
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
                  : "Saved to your account"}
            <span className="text-separator">/</span>Ground floor
          </p>
        </div>
        <div className="project-actions">
          <button className="button secondary" onClick={exportSetup}>
            <Icon name="download" size={16} />
            <span>Export workspace</span>
          </button>
          {mode !== "live" && <button
            className={`button primary ${running ? "is-loading" : ""}`}
            disabled={(busy && !running) || liveRunning}
            onClick={run}
          >
            <Icon name={running ? "close" : "play"} size={15} />
            {running ? "Cancel run" : liveRunning ? "Finishing live analysis…" : busy ? "Working…" : "Run simulation"}
          </button>}
        </div>
      </div>
      {isSample && (
        <div className="workspace-context-strip">
          <p>
            This sample is available to everyone. Changes here are temporary.
          </p>
          {ownerId ? (
            <button className="button secondary" onClick={saveCopy} disabled={copying}>
              <Icon name="plus" size={15} />
              {copying ? "Creating copy…" : "Make a copy"}
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
      <main className={`workspace-grid${mode === "live" ? " live-analytics-grid" : ""}`}>
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
              liveBlockedReason={baseline ? "Clear the pinned baseline to update the starting crowd from this feed." : mode !== "layout" ? "Return to Layout to apply live crowd updates." : ""}
              onUseLiveCrowdEstimate={(occupancy) => {
                if (busy || baseline || mode !== "layout" || !isSupportedCrowdSize(occupancy)) return;
                setScenario((current) => current.occupancy === occupancy && !Object.keys(current.population?.roomCounts ?? {}).length
                  ? current
                  : { ...current, occupancy, population: { ...current.population, roomCounts: {} } });
                setNotice(`Live venue crowd: ${occupancy} people. Review the estimate before running.`);
              }}
              onUploadFloorPlan={() => {
                setCalibratingExisting(false);
                setPendingCalibration(null);
                setModal("upload");
                setError("");
              }}
              onUseCrowdEstimate={(occupancy) => {
                if (!isSupportedCrowdSize(occupancy)) return;
                const clearingBaseline = Boolean(baseline && (scenario.occupancy !== occupancy ||
                  ((scenario.distribution === "rooms" || scenario.distribution === "normal") && Object.keys(scenario.population?.roomCounts ?? {}).length > 0)));
                if (clearingBaseline) {
                  setBaseline(null);
                }
                if (scenario.occupancy !== occupancy) setMode("layout");
                setPlaying(false);
                setScenario((current) => ({ ...current, occupancy, population:{...current.population,roomCounts:{}} }));
                setNotice(`Venue crowd estimate applied: ${occupancy} people.${clearingBaseline ? " Baseline cleared because the starting crowd changed." : ""}`);
              }}
            >
              <div className="scale-row">
                <span>Plan scale</span>
                <span className="mono">
                  {(plan.native?.transform.pixels_per_metre ?? 32).toFixed(1)} px / m
                  {!(plan.native && nativeLayout(plan).source_image?.calibration?.method === "estimated") && (
                    <Icon name="check" size={12} />
                  )}
                </span>
              </div>
              {plan.native && nativeLayout(plan).source_image?.calibration?.method === "estimated" && (
                <span className="estimated-scale-badge">Estimated scale</span>
              )}
              {plan.native && nativeLayout(plan).source_image?.calibration && (
                <p className="helper scale-evidence">
                  {nativeLayout(plan).source_image!.calibration!.method === "estimated"
                    ? "Estimated from: "
                    : nativeLayout(plan).source_image!.calibration!.method === "automatic"
                      ? "Detected from: "
                      : "Calibrated from: "}
                  {nativeLayout(plan).source_image!.calibration!.label}
                </p>
              )}
              {plan.native && nativeLayout(plan).source_image?.calibration?.method === "estimated" && (
                <p className="helper scale-estimate-note">
                  Distances, area, and results use assumed object sizes. Use Edit scale to enter a known measurement.
                </p>
              )}
              {plan.native?.image && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={editScale}
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
            {mode==="layout"&&<div ref={geometryPanelRef}><GeometryPanel plan={plan} selection={geometrySelection} tool={geometryTool} busy={busy}
              onChange={editPlan} onSelect={selection=>{setGeometrySelection(selection);setSelectedId(null);}} onTool={setGeometryTool} onCheck={checkLayout}
              overlay={showReference} onOverlay={setShowReference} opacity={referenceOpacity} onOpacity={setReferenceOpacity}/></div>}
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
                      min={itemBounds.left}
                      max={
                        itemBounds.right -
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
                      min={itemBounds.top}
                      max={
                        itemBounds.bottom -
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
            <fieldset disabled={busy || Boolean(baseline)}>
              <div className="occupancy-label">
                <label htmlFor="occupancy">Occupancy</label>
                <span>
                  <input
                    aria-label="Number of people"
                    type="number"
                    min="1"
                    max={MAX_CROWD_SIZE}
                    value={scenario.occupancy}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (Number.isFinite(value))
                        setScenario({
                          ...scenario,
                          occupancy: Math.max(
                            1,
                            Math.min(MAX_CROWD_SIZE, Math.round(value)),
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
                min="1"
                max={MAX_CROWD_SIZE}
                value={scenario.occupancy}
                style={
                  {
                    "--range-progress": `${((scenario.occupancy - 1) / (MAX_CROWD_SIZE - 1)) * 100}%`,
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
                <span>1 person</span>
                <span>{MAX_CROWD_SIZE.toLocaleString("en-US")} people</span>
              </div>
              {plan.capacity != null ? <p className={`helper${scenario.occupancy > plan.capacity ? " room-placement-warning" : ""}`} role="status">
                {plan.name.toUpperCase().includes("POFA") ? "POFA" : "Venue"} capacity: {plan.capacity.toLocaleString("en-US")} people.
                {scenario.occupancy > plan.capacity ? ` ${(scenario.occupancy - plan.capacity).toLocaleString("en-US")} above capacity. This scenario is available for analysis.` : scenario.occupancy === plan.capacity ? " At capacity." : ` ${(plan.capacity - scenario.occupancy).toLocaleString("en-US")} below capacity.`}
              </p> : null}
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
                  <option value="uniform">Random · anywhere walkable</option>
                  <option value="normal">Normal · seated / at desks</option>
                </select>
                <Icon name="chevron" size={13} />
              </div>
              {(scenario.distribution === "rooms" || scenario.distribution === "normal") && <RoomPopulationPanel plan={plan} scenario={scenario}
                preview={currentPopulation} loading={placement.loading}
                error={placement.error}
                onChange={next=>{setScenario(next);setMode("layout");setPlaying(false);}} />}
              <label className="field-label" htmlFor="body-width">Body width (cm)</label>
              <input id="body-width" type="number" min="40" max="70" step="1" value={Math.round((scenario.bodyWidth ?? .46)*100)}
                onChange={event => {const width=Number(event.target.value);if(Number.isInteger(width)&&width>=40&&width<=70)
                  setScenario({...scenario,bodyWidth:width/100});}} />
              <p className="field-note">Shoulder width and collision diameter use the same size. Default: 46 cm.
                {plan.id === SAMPLE_PLAN.id && plan.area === 76 && !plan.native ? " Sample exits are 0.875 m wide, so people pass single file at the default body width." : " Check the drawing’s scale if doors look too wide."}</p>
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
            {baseline && <p className="helper">Baseline starting people, body width and base walking speeds are fixed. You can change evacuation mode below.</p>}
            <fieldset disabled={busy}>
              <label className="field-label" htmlFor="behavior-mode">Evacuation mode</label>
              <div className="select-wrap">
                <select id="behavior-mode" value={scenario.behaviorMode ?? "idealized"}
                  onChange={event => setScenario({...scenario,behaviorMode:event.target.value as Scenario["behaviorMode"]})}>
                  <option value="idealized">Direct · nearest exit</option>
                  <option value="behavioral">Natural · avoids crowded exits</option>
                </select>
                <Icon name="chevron" size={13}/>
              </div>
              <p className="field-note">{scenario.behaviorMode === "behavioral"
                ? "Everyone starts immediately. People reconsider crowded exits and switch when another reachable exit offers a clearly better estimated arrival time."
                : "Everyone starts immediately and keeps their initially nearest reachable exit. This is not a globally optimal evacuation."}</p>
              <p className="field-note">Natural mode uses queue estimates and a cooldown to avoid constant back-and-forth switching. Sideways squeezing is not modeled.</p>
            </fieldset>
            {(scenario.distribution !== "rooms" && scenario.distribution !== "normal") && placementStatus.key === populationKey && placementStatus.error &&
              <p className="room-placement-error" role="alert">{placementStatus.error}</p>}
            <fieldset disabled={busy} className="exit-availability">
              <legend>Blocked exits</legend>
              <p className="helper">Unavailable for the entire run. Blocking every exit is allowed. Doorway geometry stays unchanged.</p>
              {plan.exits.map(exit => <label key={exit.id} className="exit-toggle">
                <input type="checkbox" aria-label={`Block ${exit.label}`}
                  checked={(scenario.blockedExitIds ?? []).includes(exit.id)}
                  onChange={event => setScenario({...scenario,blockedExitIds:event.target.checked
                    ? [...(scenario.blockedExitIds ?? []),exit.id]
                    : (scenario.blockedExitIds ?? []).filter(id => id !== exit.id)})} />
                {exit.label}
              </label>)}
            </fieldset>
          </section>
          <div className="setup-bottom">
            <span>
              <Icon name={placement.error || placement.loading ? "clock" : "check"} size={14} />
              {placement.error ? "Placement unavailable" : placement.loading ? "Checking placement…" : "Scenario ready"}
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
                  { id: "live", label: "Live analytics", icon: "video" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  id={`${viewId}-${tab.id}-tab`}
                  aria-controls={`${viewId}-${tab.id}-panel`}
                  tabIndex={mode === tab.id ? 0 : -1}
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
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const buttons = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="tab"]:not(:disabled)') ?? []);
                    const current = buttons.indexOf(event.currentTarget);
                    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
                    buttons[next]?.focus();
                    buttons[next]?.click();
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
          <LiveEvacuationAnalytics active={mode === "live"} plan={plan} scenario={scenario} busy={busy} onBusyChange={setLiveRunning}
            id={`${viewId}-live-panel`} labelledBy={`${viewId}-live-tab`} />
          <div className="manual-view-panel" role="tabpanel" id={`${viewId}-${mode === "live" ? "layout" : mode}-panel`}
            aria-labelledby={`${viewId}-${mode === "live" ? "layout" : mode}-tab`} style={mode === "live" ? { display: "none" } : undefined}>
          <div
            className={`canvas-container ${mode === "compare" ? "comparison-canvas" : ""}`}
          >
            <div className="canvas-caption">
              <span className="canvas-status">
                <span className={`status-dot ${busy ? "amber" : ""}`} />
                {busy
                  ? "Computing crowd movement"
                  : mode === "layout"
                    ? placement.error ? "Placement unavailable · review layout" : placement.loading ? "Preparing placement preview" : "Editing layout · placement preview"
                    : playing
                      ? "Playing simulation"
                      : "Simulation paused"}
              </span>
              {mode === "layout" ? (
                <span>
                  {scenario.occupancy} people requested{" "}
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
                    <span>BASELINE · {baseline.scenario.behaviorMode === "behavioral" ? "NATURAL" : "DIRECT"}</span>
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
                    <span>PROPOSED · {result.scenario.behaviorMode === "behavioral" ? "NATURAL" : "DIRECT"}</span>
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
          {mode === "layout" && placement.error && (
            <div className="placement-preview-error" role="alert">
              <div className="placement-preview-message">
                <p><strong>People preview unavailable.</strong> {scenario.occupancy} requested; no people placed.</p>
                <p>{placement.error}</p>
              </div>
              <div>
                <button type="button" className="text-button" disabled={busy} onClick={inspectPlacementGeometry}>{plan.native ? "Check walls & doors" : "Review layout"}</button>
                {plan.native?.image&&<button type="button" className="text-button" disabled={busy} onClick={editScale}>Edit scale</button>}
                <button type="button" className="text-button" disabled={busy} onClick={() => {
                  setPlacementStatus({key: populationKey, loading: true, error: ""});
                  setPlacementRetry(previous => previous + 1);
                }}>Retry preview</button>
              </div>
            </div>
          )}
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
                  {(result?.agents.some(agent=>agent.delay>0) || (mode === "compare" && baseline?.agents.some(agent=>agent.delay>0))) && <>
                    <span className="legend-person" style={{background:"#b98a3e"}}/>Responding
                  </>}
                  {Boolean(result?.trapped || (mode === "compare" && baseline?.trapped)) && <>
                    <span className="legend-person" style={{background:"#b64235"}}/>Trapped
                  </>}
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
                  {mode === "layout" ? "Starting placement" : "Playback"}
                </strong>
                <span>
                  {mode === "layout" ? currentPopulation ? `${currentPopulation.people.length} people placed${result ? " · Play shows the recorded run" : ""}` : placement.error ? `No people placed · ${scenario.occupancy} requested` : "Preparing placement preview…" : result
                    ? `${evacuated} / ${result.scenario.occupancy} exited${responding ? ` · ${responding} responding` : ""}`
                    : "Run a scenario to inspect movement"}
                </span>
              </div>
              <span className="playback-time mono">
                {(mode === "layout" ? 0 : time).toFixed(1)} <span>/ {duration.toFixed(1)} s</span>
              </span>
            </div>
            <div className="playback-bottom">
              <button
                className="playback-play"
                aria-label={playing ? "Pause simulation" : "Play simulation"}
                disabled={!result || busy || duration <= 0}
                onClick={() => {
                  if (mode === "layout" || time >= duration) setTime(0);
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
                value={mode === "layout" ? 0 : time}
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
          </div>
        </section>
        <aside className="results-panel" aria-label="Simulation results" style={mode === "live" ? { display: "none" } : undefined}>
          <div className="results-heading">
            <h2>Run overview</h2>
            <span className={`result-status ${result ? "complete" : ""}`}>
              {busy
                ? "Running"
                : result
                  ? result.remaining
                    ? result.execution?.runtimeLimited ? "Processing limit" : result.status === "trapped" ? "Trapped" : "Time limit"
                    : "Complete"
                  : "Not run"}
            </span>
          </div>
          {running && runProgress ? <p className="results-subtitle" role="status">{runProgress}</p> : null}
          {(result?.plan??plan).native&&nativeLayout(result?.plan??plan).source_image?.calibration?.method==="estimated"&&
            <p className="scale-estimate-note">Estimated scale: these results use assumed object sizes. Calibrate with a known measurement for more reliable distances and density.</p>}
          {result && (result.placementExcludedArea ?? 0) > .01 &&
            <p className="scale-estimate-note">Automatic placement excluded {result.placementExcludedArea!.toFixed(1)} m² with no body-clear route to an exit. These areas had no starting occupants; review narrow gaps and enclosed rooms before interpreting the results.</p>}
          {result && (
            <p className="results-subtitle">
              {`${result.scenario.occupancy} people · ${result.plan.exits.length} exits · ${result.scenario.behaviorMode === "behavioral" ? "Natural" : "Direct"} · ${result.scenario.mobility === "standard" ? "Standard" : "Mixed"} walking`}
            </p>
          )}
          {result?.exitChanges && result.exitChanges.length>0 && <p className="results-subtitle">{new Set(result.exitChanges.map(change=>change.agentId)).size} people changed exits to avoid congestion ({result.exitChanges.length} changes).</p>}
          {result?.execution ? <p className="results-subtitle">All {result.execution.populationCount.toLocaleString("en-US")} people simulated individually · {result.execution.wallTimeSeconds.toFixed(1)} s processing.{result.execution.playbackTemporallyThinned ? ` Playback sampled every ${result.execution.playbackSampleInterval.toFixed(2)} simulated seconds; headcount unchanged.` : ""}</p> : null}
          {result?.execution?.runtimeLimited ? <p className="scale-estimate-note" role="status">Processing time limit reached. This run is incomplete, with {result.remaining.toLocaleString("en-US")} people remaining after {result.totalTime.toFixed(1)} simulated seconds. A complete evacuation time is unavailable.</p> : null}
          {stale && (
            <div className="result-stale">Inputs changed since this run</div>
          )}
          <div className="primary-metric">
            <span>
              Simulated evacuation time{" "}
              <button
                className="inline-help"
                aria-label="Evacuation time definition"
                title="Time until everyone exits. Unavailable if anyone remains at a simulation or processing time limit."
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
                  ? `${result.exited} exited · ${result.trapped ?? 0} trapped · ${result.movingRemaining ?? result.remaining} with a route still inside at ${formatTime(result.totalTime)}`
                  : `${result.exited} people reached an exit`
                : "Time until everyone reaches an exit"}
            </p>
          </div>
          <div className="secondary-metrics">
            <div><span>Body width · collision diameter</span><strong>{result?.agentRadius === undefined ? "—" : `${Math.round(2*result.agentRadius*100)} cm`}</strong></div>
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
            <div><span>Trapped · no available route</span><strong className={result?.trapped ? "warning-text" : ""}>{result?.trapped ?? "—"}</strong></div>
            <div><span>With a route at time limit</span><strong>{result?.movingRemaining ?? "—"}</strong></div>
            {result?.perExitCounts && Object.entries(result.perExitCounts).map(([id, count]) => (
              <div key={id}>
                <span>Via {result.plan.exits.find((exit) => exit.id === id)?.label ?? id}{result.exitWidths?.[id] === undefined ? "" : ` · ${result.exitWidths[id].toFixed(2)} m wide`}</span>
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
                      ? "Identical starting people. Compare evacuated, trapped, and people still inside with a route; full evacuation time is unavailable when anyone remains."
                      : sameScenario
                        ? `${layoutChanges} layout object${layoutChanges === 1 ? "" : "s"} changed. Identical starting people and walking speeds.`
                        : "Identical starting people and base speeds; evacuation mode or exit availability changed."
                    : "Change evacuation mode, block exits or edit the layout, then run again."}
                </p>
                {canCompare && result && <dl className="comparison-outcomes">
                  <div><dt>Mode · before → after</dt><dd>{baseline.scenario.behaviorMode === "behavioral" ? "Natural" : "Direct"} → {result.scenario.behaviorMode === "behavioral" ? "Natural" : "Direct"}</dd></div>
                  <div><dt>Evacuated · before → after</dt><dd>{baseline.exited} → {result.exited}</dd></div>
                  <div><dt>Trapped · before → after</dt><dd>{baseline.trapped ?? 0} → {result.trapped ?? 0}</dd></div>
                  <div><dt>With a route · before → after</dt><dd>{baseline.movingRemaining ?? baseline.remaining} → {result.movingRemaining ?? result.remaining}</dd></div>
                  <div><dt>Peak density · before → after</dt><dd>{baseline.peakDensity.toFixed(1)} → {result.peakDensity.toFixed(1)} people/m²</dd></div>
                  {Object.entries(result.perExitCounts ?? {}).map(([id, total]) => <div key={id}><dt>{result.plan.exits.find(e=>e.id===id)?.label ?? id} · before → after</dt><dd>{baseline.perExitCounts?.[id] ?? 0} → {total}</dd></div>)}
                </dl>}
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
                  Keep a run as a baseline, then test another mode, blocked exits or a layout change.
                </p>
                <button
                  className="button subtle pin-button"
                  disabled={!result || stale || busy}
                  onClick={() => {
                    setBaseline(result);
                    setNotice(
                      "Baseline pinned. Starting positions and base speeds are fixed. Change evacuation mode, block exits or edit the layout, then run again.",
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
              ? calibratingExisting ? "Edit scale" : "Upload floor plan"
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
            {!calibratingExisting&&<>
            <p>
              Import a frontend or backend Crowdy JSON layout, or extract an image.
              Uploading replaces your layout; Undo restores it. Imported furniture stays editable.
            </p>
            <button className="button secondary" disabled={busy} onClick={loadPofaDemo}>
              Load verified POFA demo
            </button>
            <p className="muted">Saved layout with 15 mapped exits, 24 people, and the 100 m demo measurement. Opens without a new AI extraction. The original POFA PNG also uses this layout automatically.</p>
            <label className="field-label" htmlFor="image-provider">Image extraction provider</label>
            <select id="image-provider" value={imageProvider} disabled={busy}
              aria-describedby={`image-provider-status${providerStatus[imageProvider]?.model ? " image-provider-model" : ""}${imageProvider === "gemini" && providerStatus.claude?.configured ? " image-provider-review" : ""}`}
              onChange={e=>setImageProvider(e.target.value)}>
              <option value="claude">{providerLabel("claude", providerStatus.claude?.model)}</option>
              <option value="gemini">{providerLabel("gemini", providerStatus.gemini?.model)}</option>
            </select>
            <p id="image-provider-status" className="muted" role="status">
              {providerStatusError || (providerStatus[imageProvider]?.busy
                ? `${providerLabel(imageProvider, providerStatus[imageProvider]?.model)} is processing an image (${providerStatus[imageProvider].elapsed_seconds}s elapsed). ${busy ? "Your current layout stays in place until the import finishes." : "Choose the other provider or import JSON while this image is processing."}`
                : providerStatus[imageProvider]?.configured === false
                  ? "This provider is not configured for this deployment."
                  : providerStatus[imageProvider] ? "This provider is ready for an image." : "Checking provider status…")}
            </p>
            {providerStatus[imageProvider]?.model && <p id="image-provider-model" className="muted">Model: {providerStatus[imageProvider].model}</p>}
            {imageProvider === "gemini" && providerStatus.claude?.configured && <p id="image-provider-review" className="muted">
              Claude may check uncertain interior door mappings against a closer view of the source image. Import notes identify any corrections.
            </p>}
            <p className="muted">Scale uses printed dimensions first, then an estimate from doors and furniture when several objects agree. You can adjust estimates with Edit scale. If neither is usable, mark a known distance. Images are resized to at most 3072 pixels per side before being sent to your selected provider.</p>
            </>}
            {pendingCalibration&&<ScaleCalibrator key={pendingCalibration.extraction_id} pending={pendingCalibration} busy={busy} onApply={finishScale}/>}
            {!calibratingExisting&&<>
            <button
              className="upload-dropzone"
              disabled={busy}
              onClick={() => uploadRef.current?.click()}
            >
              <Icon name="upload" size={26} />
              <strong>{busy ? "Importing floor plan…" : "Choose a floor plan"}</strong>
              {busy && notice && <span role="status">{notice}</span>}
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
            </>}
            {error && (
              <div className="upload-error" role="alert">
                {error}
              </div>
            )}
            {!calibratingExisting&&<><button
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
              PNG, JPEG, and WebP images are read with the selected model.
              Export PDF pages as images first. Imported walls, doors, exits, and furniture can be corrected in this workspace.
            </p>
            </>}
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
                  Imported plans use their measured or estimated scale; the sample uses 32 pixels per metre. Walls define the floor
                  bounds; wall segments and furniture block movement. Boundary
                  exits include a short landing beyond the floor. Review
                  imported geometry before running.
                </dd>
              </div>
              <div>
                <dt>Movement</dt>
                <dd>
                  JuPedSim uses a collision-free speed model with body-clear routes around obstacles.
                  Both modes start immediately.
                  Natural mode starts immediately, varies desired speeds slightly, and periodically compares estimated travel plus doorway queue time. Exit changes require a clear benefit and a cooldown. Direct mode keeps the initial nearest exit.
                  These are illustrative assumptions, not calibrated predictions.
                </dd>
              </div>
              <div>
                <dt>Reported time</dt>
                <dd>
                  Evacuation time is available only when everyone exits.
                  Trapped people have no body-clear route to an available exit at the start and remain stationary and visible in red.
                  The run ends when everyone with a route has left, or at the configured time limit. People with a route still inside at that limit are reported separately.
                  Average exit time counts only people
                  who reached an exit.
                </dd>
              </div>
              <div>
                <dt>Playback</dt>
                <dd>
                  Playback follows recorded positions and their simulation
                  timestamps. 1× advances one simulated second per real second.
                  Reduced motion starts runs paused.
                  Shoulder ellipses face the measured walking direction with smoothed turns;
                  collision and route clearance still use circular bodies, with no sideways squeezing. Red means trapped.
                  Body width defaults to 46 cm (a 23 cm radius), is adjustable from 40–70 cm, and sets both the shoulder span and collision diameter.
                  Door widths come from the floor geometry; wide exits can support people abreast. Estimated drawing scale affects their measured width.
                </dd>
              </div>
              <div>
                <dt>Your work</dt>
                <dd>
                  {isSample
                    ? "Sample edits are temporary. Make a personal copy to keep them, or export this layout."
                    : "This workspace is saved to your account. Runs and baselines last for this session; export to keep a separate copy."}
                </dd>
              </div>
            </dl>
            <p className="dialog-note">
              Runs and placement previews are computed by the simulation service. Normal layout previews show seated poses; evacuation starts at adjacent clear standing positions without a sit-to-stand animation. Small individual chairs are movable seating assumptions; major furniture stays solid. Image extraction uses the selected provider and scale. Export PDF pages as images first.
            </p>
          </>
        )}
      </dialog>
    </div>
  );
}
