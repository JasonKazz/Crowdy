import type { FloorPlan, Scenario } from "./simulation";
import {validPlanRooms, validPopulationSettings} from "./room-population.ts";

export const SAMPLE_WORKSPACE_ID = "berkeley-studio";
export const DEFAULT_SCENARIO: Scenario = {
  occupancy: 80,
  mobility: "standard",
  distribution: "rooms",
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

type WorkspaceInput = {
  name: string;
  plan: FloorPlan;
  scenario: Scenario;
};

type WorkspaceUpdate = {
  name?: string;
  plan: FloorPlan;
  scenario: Scenario;
};

const STORAGE_PREFIX = "crowdy-workspaces-v1:";
const CHANGE_EVENT = "crowdy-workspaces-changed";
const CORRUPT_MESSAGE =
  "Saved workspace data could not be read. Existing data has been kept.";
const MISSING_MESSAGE =
  "This workspace is no longer available. Return to Workspaces and try again.";
const itemKinds = new Set([
  "desk",
  "table",
  "shelf",
  "sofa",
  "plant",
  "obstacle",
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

function nextTimestamp(records: WorkspaceRecord[]): number {
  const newest = records.reduce(
    (latest, record) => Math.max(latest, record.updatedAt),
    -1,
  );
  const now = Math.max(Date.now(), newest + 1);
  if (!validTimestamp(now))
    fail(
      "Saved workspace timestamps could not be updated. Existing data has been kept.",
    );
  return now;
}

function storageKey(ownerId: string): string {
  if (
    !isText(ownerId, 512) ||
    ownerId.trim() !== ownerId ||
    /[\u0000-\u001f]/.test(ownerId)
  ) {
    fail("Sign in to access your personal workspaces.");
  }
  try {
    return STORAGE_PREFIX + encodeURIComponent(ownerId);
  } catch {
    return fail("The account identifier is invalid. Try signing in again.");
  }
}

function storage(): Storage {
  if (typeof window === "undefined") {
    fail("Workspaces can only be loaded in a browser.");
  }
  try {
    return window.localStorage;
  } catch {
    return fail(
      "Browser storage is unavailable. Enable site storage and try again.",
    );
  }
}

function validPlan(value: unknown): value is FloorPlan {
  if (!isObject(value) || !isText(value.id) || !isText(value.name))
    return false;
  if (!validPlanRooms(value.rooms)) return false;
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
    finite(value.occupancy) &&
    Number.isInteger(value.occupancy) &&
    value.occupancy >= 1 &&
    value.occupancy <= 200 &&
    (value.mobility === "standard" || value.mobility === "mixed") &&
    (value.distribution === "uniform" || value.distribution === "workstations" || value.distribution === "rooms") &&
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

function readRecords(ownerId: string): WorkspaceRecord[] {
  const key = storageKey(ownerId);
  let raw: string | null;
  try {
    raw = storage().getItem(key);
  } catch {
    return fail(
      "Browser storage is unavailable. Enable site storage and try again.",
    );
  }
  if (raw === null) return [];
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    return fail(CORRUPT_MESSAGE);
  }
  if (!Array.isArray(values)) return fail(CORRUPT_MESSAGE);
  const ids = new Set<string>();
  for (const value of values) {
    if (!validRecord(value, ownerId) || ids.has(value.id))
      return fail(CORRUPT_MESSAGE);
    ids.add(value.id);
  }
  return values.map((value) => copyRecord(value as WorkspaceRecord));
}

function saveRecords(ownerId: string, records: WorkspaceRecord[]) {
  const key = storageKey(ownerId);
  try {
    storage().setItem(key, JSON.stringify(records));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "QuotaExceededError"
    ) {
      fail(
        "This browser has no space left for workspaces. Export or remove an existing workspace and try again.",
      );
    }
    fail(
      "Your workspace could not be saved in this browser. Enable site storage and try again.",
    );
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
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

export function listWorkspaces(ownerId: string): WorkspaceRecord[] {
  return readRecords(ownerId).sort(
    (a, b) =>
      b.updatedAt - a.updatedAt ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  );
}

export function getWorkspace(
  ownerId: string,
  id: string,
): WorkspaceRecord | null {
  storageKey(ownerId);
  if (id === SAMPLE_WORKSPACE_ID) return null;
  requirePersonalId(id);
  return readRecords(ownerId).find((record) => record.id === id) ?? null;
}

export function createWorkspace(
  ownerId: string,
  input: WorkspaceInput,
): WorkspaceRecord {
  const records = readRecords(ownerId);
  const name = workspaceName(input.name);
  validateInputs(input.plan, input.scenario);
  let id: string;
  try {
    id = `ws-${globalThis.crypto.randomUUID()}`;
  } catch {
    return fail(
      "This browser could not create a workspace identifier. Try another browser.",
    );
  }
  const now = nextTimestamp(records);
  const record: WorkspaceRecord = {
    id,
    ownerId,
    name,
    plan: copyPlan(input.plan),
    scenario: copyScenario(input.scenario),
    createdAt: now,
    updatedAt: now,
  };
  saveRecords(ownerId, [...records, record]);
  return copyRecord(record);
}

export function updateWorkspace(
  ownerId: string,
  id: string,
  input: WorkspaceUpdate,
): WorkspaceRecord {
  requirePersonalId(id);
  const records = readRecords(ownerId);
  const index = records.findIndex((record) => record.id === id);
  if (index === -1) return fail(MISSING_MESSAGE);
  const name =
    input.name === undefined ? records[index].name : workspaceName(input.name);
  validateInputs(input.plan, input.scenario);
  const updated: WorkspaceRecord = {
    ...records[index],
    name,
    plan: copyPlan(input.plan),
    scenario: copyScenario(input.scenario),
    updatedAt: nextTimestamp(records),
  };
  records[index] = updated;
  saveRecords(ownerId, records);
  return copyRecord(updated);
}

export function deleteWorkspace(ownerId: string, id: string): void {
  requirePersonalId(id);
  const records = readRecords(ownerId);
  if (!records.some((record) => record.id === id)) return fail(MISSING_MESSAGE);
  saveRecords(
    ownerId,
    records.filter((record) => record.id !== id),
  );
}

export function subscribeWorkspaces(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      (typeof event.key === "string" && event.key.startsWith(STORAGE_PREFIX))
    )
      listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", handleStorage);
  };
}
