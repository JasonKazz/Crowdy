import type { FloorPlan, Scenario } from "./simulation";
import {validPlanRooms, validPopulationSettings} from "./room-population.ts";
import {isSupportedCrowdSize, isVenueCapacity} from "./crowd-limits.ts";

export const SAMPLE_WORKSPACE_ID = "berkeley-studio";
export const DEFAULT_SCENARIO: Scenario = {
  occupancy: 24,
  mobility: "standard",
  distribution: "normal",
  behaviorMode: "idealized",
  bodyWidth: .46,
};

export type WorkspaceRecord = {
  id: string;
  ownerId: string;
  name: string;
  plan: FloorPlan;
  scenario: Scenario;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceInput = {
  name: string;
  plan: FloorPlan;
  scenario: Scenario;
};

export type WorkspaceUpdate = {
  name?: string;
  plan: FloorPlan;
  scenario: Scenario;
};

const STORAGE_PREFIX = "crowdy-workspaces-v1:";
const CHANGE_EVENT = "crowdy-workspaces-changed";
const MISSING_MESSAGE =
  "This workspace is no longer available. Return to Workspaces and try again.";
const itemKinds = new Set([
  "desk",
  "table",
  "shelf",
  "sofa",
  "plant",
  "obstacle",
  "chair",
]);

function fail(message: string): never {
  const error = new Error(message);
  error.name = "WorkspaceStorageError";
  throw error;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown, maximum = 80): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validTimestamp(value: unknown): value is number {
  return (
    finite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8.64e15
  );
}

function storageKey(ownerId: string): string {
  if (!isText(ownerId, 512) || ownerId.trim() !== ownerId || /[\u0000-\u001f]/.test(ownerId))
    fail("Sign in to access your personal workspaces.");
  return STORAGE_PREFIX + encodeURIComponent(ownerId);
}

function validPlan(value: unknown): value is FloorPlan {
  if (!isObject(value) || !isText(value.id) || !isText(value.name))
    return false;
  if (!validPlanRooms(value.rooms)) return false;
  if (value.capacity != null && !isVenueCapacity(value.capacity)) return false;
  if (
    value.width !== 900 ||
    value.height !== 600 ||
    !finite(value.area) ||
    value.area <= 0
  )
    return false;
  if (
    !Array.isArray(value.items) ||
    value.items.length > 1200 ||
    !Array.isArray(value.walls) ||
    value.walls.length > 1200 ||
    !Array.isArray(value.exits) ||
    (!value.native && !value.exits.length) ||
    value.exits.length > 30
  )
    return false;

  const itemIds = new Set<string>();
  for (const item of value.items) {
    if (
      !isObject(item) ||
      !isText(item.id, 128) ||
      itemIds.has(item.id) ||
      !isText(item.label) ||
      typeof item.kind !== "string" ||
      !itemKinds.has(item.kind)
    )
      return false;
    if (
      !finite(item.x) ||
      !finite(item.y) ||
      !finite(item.width) ||
      !finite(item.height) ||
      item.x < 0 ||
      item.y < 0 ||
      item.width < (value.native ? .001 : 8) ||
      item.height < (value.native ? .001 : 8) ||
      item.x + item.width > 900 ||
      item.y + item.height > 600
    )
      return false;
    itemIds.add(item.id);
  }
  for (const wall of value.walls) {
    if (
      !isObject(wall) ||
      !finite(wall.x1) ||
      !finite(wall.x2) ||
      !finite(wall.y1) ||
      !finite(wall.y2) ||
      Math.min(wall.x1, wall.x2) < 0 ||
      Math.max(wall.x1, wall.x2) > 900 ||
      Math.min(wall.y1, wall.y2) < 0 ||
      Math.max(wall.y1, wall.y2) > 600
    )
      return false;
  }
  const exitIds = new Set<string>();
  for (const exit of value.exits) {
    if (
      !isObject(exit) ||
      !isText(exit.id, 128) ||
      exitIds.has(exit.id) ||
      !isText(exit.label) ||
      !finite(exit.x) ||
      !finite(exit.y) ||
      exit.x < 0 ||
      exit.x > 900 ||
      exit.y < 0 ||
      exit.y > 600
    )
      return false;
    exitIds.add(exit.id);
  }
  return true;
}

function validScenario(value: unknown): value is Scenario {
  return (
    isObject(value) &&
    isSupportedCrowdSize(value.occupancy) &&
    (value.mobility === "standard" || value.mobility === "mixed") &&
    (value.distribution === "uniform" || value.distribution === "workstations" || value.distribution === "rooms" || value.distribution === "normal") &&
    (value.population === undefined || validPopulationSettings(value.population)) &&
    (value.behaviorMode === undefined || value.behaviorMode === "idealized" || value.behaviorMode === "behavioral") &&
    (value.bodyWidth === undefined || (finite(value.bodyWidth) && value.bodyWidth >= .4 && value.bodyWidth <= .7)) &&
    (value.blockedExitIds === undefined || (Array.isArray(value.blockedExitIds) && value.blockedExitIds.length <= 30 && new Set(value.blockedExitIds).size === value.blockedExitIds.length && value.blockedExitIds.every(id => typeof id === "string" && id.length > 0))) &&
    (value.seed === undefined || (finite(value.seed) && Number.isInteger(value.seed) && value.seed >= 0 && value.seed <= 4294967295))
  );
}

function copyPlan(plan: FloorPlan): FloorPlan {
  return {
    id: plan.id,
    name: plan.name,
    width: plan.width,
    height: plan.height,
    area: plan.area,
    ...(plan.capacity == null ? {} : {capacity: plan.capacity}),
    ...(plan.rooms ? {rooms: structuredClone(plan.rooms)} : {}),
    ...(plan.native ? {native: structuredClone(plan.native)} : {}),
    items: plan.items.map((item) => ({
      id: item.id,
      label: item.label,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      kind: item.kind,
      ...(item.polygon ? {polygon: structuredClone(item.polygon)} : {}),
    })),
    walls: plan.walls.map((wall) => ({
      x1: wall.x1,
      y1: wall.y1,
      x2: wall.x2,
      y2: wall.y2,
    })),
    exits: plan.exits.map((exit) => ({
      id: exit.id,
      label: exit.label,
      x: exit.x,
      y: exit.y,
    })),
  };
}

function copyScenario(scenario: Scenario): Scenario {
  return {
    occupancy: scenario.occupancy,
    mobility: scenario.mobility,
    distribution: scenario.distribution,
    ...(scenario.population ? {population: structuredClone(scenario.population)} : {}),
    ...(scenario.behaviorMode === undefined ? {} : {behaviorMode: scenario.behaviorMode}),
    ...(scenario.bodyWidth === undefined ? {} : {bodyWidth: scenario.bodyWidth}),
    ...(scenario.seed === undefined ? {} : {seed: scenario.seed}),
    ...(scenario.blockedExitIds === undefined ? {} : {blockedExitIds: [...scenario.blockedExitIds]}),
  };
}

function copyRecord(record: WorkspaceRecord): WorkspaceRecord {
  return {
    id: record.id,
    ownerId: record.ownerId,
    name: record.name,
    plan: copyPlan(record.plan),
    scenario: copyScenario(record.scenario),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function validRecord(
  value: unknown,
  ownerId: string,
): value is WorkspaceRecord {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    /^ws-[a-zA-Z0-9-]{8,128}$/.test(value.id) &&
    value.id !== SAMPLE_WORKSPACE_ID &&
    value.ownerId === ownerId &&
    isText(value.name) &&
    validTimestamp(value.createdAt) &&
    validTimestamp(value.updatedAt) &&
    value.updatedAt >= value.createdAt &&
    validPlan(value.plan) &&
    validScenario(value.scenario)
  );
}

function workspaceName(value: string): string {
  if (typeof value !== "string")
    return fail("Give your workspace a name between 1 and 80 characters.");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80)
    return fail("Give your workspace a name between 1 and 80 characters.");
  return name;
}

function validateInputs(plan: FloorPlan, scenario: Scenario) {
  if (!validPlan(plan))
    fail(
      "This layout has invalid floor-plan geometry. Review the plan before saving it.",
    );
  if (!validScenario(scenario))
    fail(
      "This scenario has invalid occupancy or movement settings. Review it before saving.",
    );
}

function requirePersonalId(id: string) {
  if (id === SAMPLE_WORKSPACE_ID)
    fail(
      "Berkeley studio is a shared sample. Create a personal copy to save changes.",
    );
  if (typeof id !== "string" || !/^ws-[a-zA-Z0-9-]{8,128}$/.test(id))
    fail(MISSING_MESSAGE);
}

type RequestOptions = { signal?: AbortSignal; keepalive?: boolean };
const revisions = new Map<string, number>();
const mutations = new Map<string, Promise<unknown>>();
const migrationRuns = new Map<string, Promise<void>>();

export class WorkspaceRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "WorkspaceRequestError";
  }
}

// Account is a precondition only. The server derives authorization from its
// encrypted session and never trusts this browser value as an owner identity.
export async function workspaceRequest(ownerId: string, path = "", init: RequestInit = {}): Promise<Response> {
  storageKey(ownerId);
  const response = await fetch(`/api/workspaces${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Crowdy-Account": ownerId, ...init.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new WorkspaceRequestError(
      typeof data?.error === "string" ? data.error : "Your workspace could not be saved to your account. Try again.",
      response.status,
    );
  }
  return response;
}

function received(value: unknown, ownerId: string): WorkspaceRecord {
  if (!validRecord(value, ownerId)) fail("The saved workspace response could not be read. Try refreshing the page.");
  const record = copyRecord(value);
  revisions.set(`${ownerId}:${record.id}`, record.updatedAt);
  return record;
}

function changed() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

function serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = mutations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  mutations.set(key, next);
  void next.finally(() => { if (mutations.get(key) === next) mutations.delete(key); }).catch(() => undefined);
  return next;
}

async function migrateLegacy(ownerId: string, options: RequestOptions) {
  if (typeof window === "undefined") return;
  const key = storageKey(ownerId);
  let records: unknown;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    records = JSON.parse(raw);
  } catch { return; } // Browser storage is optional; cloud storage remains usable.
  if (!Array.isArray(records)) return;
  for (const legacy of records) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (!validRecord(legacy, ownerId)) continue;
    try {
      const response = await workspaceRequest(ownerId, "", {
        method: "POST", signal: options.signal,
        body: JSON.stringify({ id: legacy.id, name: legacy.name, plan: copyPlan(legacy.plan), scenario: copyScenario(legacy.scenario) }),
      });
      received(await response.json(), ownerId);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!(error instanceof WorkspaceRequestError) || ![409, 410].includes(error.status)) continue;
      if (error.status === 409) {
        // Existing cloud work wins. Never PUT a legacy snapshot over it.
        try {
          const response = await workspaceRequest(ownerId, `/${encodeURIComponent(legacy.id)}`, { signal: options.signal });
          received(await response.json(), ownerId);
        } catch (existingError) {
          if (!(existingError instanceof WorkspaceRequestError) || existingError.status !== 410) continue;
        }
      }
    }
    try {
      const latest = JSON.parse(window.localStorage.getItem(key) ?? "[]");
      if (!Array.isArray(latest)) continue;
      // Remove only the exact snapshot acknowledged by the cloud.
      const remaining = latest.filter(entry => JSON.stringify(entry) !== JSON.stringify(legacy));
      if (remaining.length) window.localStorage.setItem(key, JSON.stringify(remaining));
      else window.localStorage.removeItem(key);
    } catch { /* Keep recoverable legacy data if browser storage is blocked. */ }
  }
}

async function ensureMigration(ownerId: string, options: RequestOptions) {
  storageKey(ownerId);
  let migration = migrationRuns.get(ownerId);
  if (!migration) {
    migration = migrateLegacy(ownerId, options);
    migrationRuns.set(ownerId, migration);
    void migration.catch(() => { if (migrationRuns.get(ownerId) === migration) migrationRuns.delete(ownerId); });
  }
  await migration;
}

export async function listWorkspaces(ownerId: string, options: RequestOptions = {}): Promise<WorkspaceRecord[]> {
  await ensureMigration(ownerId, options);
  const response = await workspaceRequest(ownerId, "", { signal: options.signal });
  const data = await response.json();
  if (!Array.isArray(data?.workspaces)) fail("Your workspace library could not be read. Try again.");
  return data.workspaces.map((record: unknown) => received(record, ownerId)).sort(
    (a: WorkspaceRecord, b: WorkspaceRecord) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

export async function getWorkspace(ownerId: string, id: string, options: RequestOptions = {}): Promise<WorkspaceRecord | null> {
  storageKey(ownerId);
  if (id === SAMPLE_WORKSPACE_ID) return null;
  requirePersonalId(id);
  await ensureMigration(ownerId, options);
  try {
    const response = await workspaceRequest(ownerId, `/${encodeURIComponent(id)}`, { signal: options.signal });
    return received(await response.json(), ownerId);
  } catch (error) {
    if (error instanceof WorkspaceRequestError && [404, 410].includes(error.status)) return null;
    throw error;
  }
}

export async function createWorkspace(ownerId: string, input: WorkspaceInput, options: RequestOptions = {}): Promise<WorkspaceRecord> {
  storageKey(ownerId);
  const name = workspaceName(input.name);
  validateInputs(input.plan, input.scenario);
  const response = await workspaceRequest(ownerId, "", { method: "POST", signal: options.signal,
    body: JSON.stringify({ name, plan: copyPlan(input.plan), scenario: copyScenario(input.scenario) }) });
  const record = received(await response.json(), ownerId);
  changed();
  return record;
}

export function updateWorkspace(ownerId: string, id: string, input: WorkspaceUpdate, options: RequestOptions = {}): Promise<WorkspaceRecord> {
  storageKey(ownerId);
  requirePersonalId(id);
  validateInputs(input.plan, input.scenario);
  const snapshot = { ...(input.name === undefined ? {} : { name: workspaceName(input.name) }), plan: copyPlan(input.plan), scenario: copyScenario(input.scenario) };
  return serialize(`${ownerId}:${id}`, async () => {
    if (options.signal?.aborted) throw options.signal.reason;
    let expectedUpdatedAt = revisions.get(`${ownerId}:${id}`);
    if (expectedUpdatedAt === undefined) {
      const current = await getWorkspace(ownerId, id, options);
      if (!current) fail(MISSING_MESSAGE);
      expectedUpdatedAt = current.updatedAt;
    }
    const body = JSON.stringify({ ...snapshot, expectedUpdatedAt });
    const response = await workspaceRequest(ownerId, `/${encodeURIComponent(id)}`, {
      method: "PUT", signal: options.signal,
      // Browsers cap keepalive requests at 64 KiB; larger plans rely on autosave.
      keepalive: Boolean(options.keepalive && new TextEncoder().encode(body).byteLength < 60 * 1024), body,
    });
    const record = received(await response.json(), ownerId);
    // Editor changes do not reload an open editor with a stale remote snapshot.
    return record;
  });
}

export function deleteWorkspace(ownerId: string, id: string, options: RequestOptions = {}): Promise<void> {
  storageKey(ownerId);
  requirePersonalId(id);
  return serialize(`${ownerId}:${id}`, async () => {
    await workspaceRequest(ownerId, `/${encodeURIComponent(id)}`, { method: "DELETE", signal: options.signal });
    revisions.delete(`${ownerId}:${id}`);
    changed();
  });
}

export function subscribeWorkspaces(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}
