export type VenueImageSource = {
  id: string;
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
  addedAt: number;
  blob: Blob;
};

export const MAX_VENUE_IMAGE_BYTES = 10 * 1024 * 1024;
export const VENUE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const MAX_CLOUD_IMAGE_BYTES = 3 * 1024 * 1024;
const LEGACY_DATABASE = "crowdy-workspace-sources-v1";
const LEGACY_STORE = "venue-images";
const migrationRuns = new Map<string, Promise<void>>();
const migrationNotices = new Map<string, string>();
const MIGRATION_NOTICE = "Some images saved on this device still need to transfer. Your originals have been kept. Reopen Sources to retry.";
type SourceOptions = {
  signal?: AbortSignal;
  prepareLegacy?: (source: VenueImageSource) => Promise<VenueImageSource>;
};
type LegacySource = VenueImageSource & { ownerId: string; workspaceId: string };
class SourceRequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = "WorkspaceSourceError"; this.status = status; }
}

export function venueImageMigrationNotice(ownerId: string, workspaceId: string) {
  return migrationNotices.get(`${ownerId}:${workspaceId}`) ?? "";
}

// IndexedDB is read only for legacy recovery. New data always uses the cloud.
async function legacyDatabase(): Promise<IDBDatabase | null> {
  try {
    if (typeof window === "undefined" || !window.indexedDB) return null;
    const factory = window.indexedDB;
    if (factory.databases && !(await factory.databases()).some(database => database.name === LEGACY_DATABASE)) return null;
    return await new Promise(resolve => {
      const request = factory.open(LEGACY_DATABASE);
      let settled = false;
      const finish = (database: IDBDatabase | null) => {
        if (settled) { database?.close(); return; }
        settled = true; clearTimeout(timer); resolve(database);
      };
      const timer = setTimeout(() => finish(null), 1500);
      request.onupgradeneeded = () => { request.transaction?.abort(); finish(null); };
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(LEGACY_STORE)) { database.close(); finish(null); return; }
        database.onversionchange = () => database.close();
        finish(database);
      };
    });
  } catch { return null; }
}

async function legacyRequest<T>(database: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest<T>;
    try { transaction = database.transaction(LEGACY_STORE, mode); request = action(transaction.objectStore(LEGACY_STORE)); }
    catch (error) { reject(error); return; }
    let result: T;
    const timer = setTimeout(() => { transaction.abort(); reject(new Error("Legacy storage is busy")); }, 1500);
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => { clearTimeout(timer); resolve(result); };
    transaction.onabort = () => { clearTimeout(timer); reject(new Error("Legacy storage is unavailable")); };
    transaction.onerror = () => {};
  });
}

async function migrateLegacySources(ownerId: string, workspaceId: string, existing: {id: string}[], options: SourceOptions) {
  const scope = `${ownerId}:${workspaceId}`;
  const database = await legacyDatabase();
  if (!database) return;
  const timeout = AbortSignal.timeout(20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const records = await legacyRequest<LegacySource[]>(database, "readonly", store => store.index("workspace").getAll([ownerId, workspaceId], 9));
    if (!records.length) { migrationNotices.delete(scope); return; }
    let incomplete = records.length > 8;
    for (const legacy of records.slice(0, 8)) {
      if (signal.aborted) { incomplete = true; break; }
      if (legacy.ownerId !== ownerId || legacy.workspaceId !== workspaceId || !validSource(legacy)) { incomplete = true; continue; }
      try {
        if (!existing.some(source => source.id === legacy.id)) {
          const prepared = options.prepareLegacy ? await options.prepareLegacy(copySource(legacy)) : copySource(legacy);
          if (signal.aborted) { incomplete = true; break; }
          try { await saveVenueImage(ownerId, workspaceId, prepared, { signal }); }
          catch (error) {
            if (!(error instanceof SourceRequestError) || ![409,410].includes(error.status)) throw error;
            if (error.status === 409) {
              const response = await requestSource(ownerId, workspaceId, "", { signal });
              const current = await response.json();
              if (!Array.isArray(current.sources) || !current.sources.some((source: {id: string}) => source.id === legacy.id)) throw error;
            }
          }
        }
        // Remove this original only after a cloud acknowledgement, confirmed
        // existing source, or durable deletion tombstone. Never clear a store.
        await legacyRequest(database, "readwrite", store => store.delete([ownerId, workspaceId, legacy.id]));
      } catch { incomplete = true; }
    }
    if (incomplete) migrationNotices.set(scope, MIGRATION_NOTICE);
    else migrationNotices.delete(scope);
  } catch { migrationNotices.set(scope, MIGRATION_NOTICE); }
  finally { database.close(); }
}


function sourceError(message: string): Error {
  const error = new Error(message);
  error.name = "WorkspaceSourceError";
  return error;
}

function validText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function validateScope(ownerId: string, workspaceId: string) {
  if (!validText(ownerId, 512) || ownerId.trim() !== ownerId) {
    throw sourceError("Sign in to access your venue images.");
  }
  if (!validText(workspaceId, 128) || workspaceId.trim() !== workspaceId) {
    throw sourceError("Choose a workspace before adding venue images.");
  }
}

function validSource(value: unknown): value is VenueImageSource {
  if (!value || typeof value !== "object") return false;
  const source = value as VenueImageSource;
  return (
    validText(source.id, 128) &&
    source.id.trim() === source.id &&
    validText(source.name, 255) &&
    typeof Blob !== "undefined" &&
    source.blob instanceof Blob &&
    VENUE_IMAGE_TYPES.some((type) => type === source.type) &&
    source.blob.type === source.type &&
    source.size === source.blob.size &&
    source.size > 0 &&
    source.size <= MAX_VENUE_IMAGE_BYTES &&
    Number.isSafeInteger(source.width) &&
    source.width > 0 &&
    Number.isSafeInteger(source.height) &&
    source.height > 0 &&
    Number.isSafeInteger(source.width * source.height) &&
    Number.isSafeInteger(source.addedAt) &&
    source.addedAt >= 0 &&
    source.addedAt <= 8.64e15
  );
}

function copySource(source: VenueImageSource): VenueImageSource {
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    size: source.size,
    width: source.width,
    height: source.height,
    addedAt: source.addedAt,
    blob: source.blob,
  };
}

async function requestSource(ownerId: string, workspaceId: string, suffix = "", init: RequestInit = {}) {
  validateScope(ownerId, workspaceId);
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sources${suffix}`, {
    ...init, credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Crowdy-Account": ownerId },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new SourceRequestError(typeof data?.error === "string" ? data.error : "Your venue images could not be saved to your account. Try again.", response.status);
  }
  return response;
}

export async function listVenueImages(ownerId: string, workspaceId: string, options: SourceOptions = {}): Promise<VenueImageSource[]> {
  validateScope(ownerId, workspaceId);
  const response = await requestSource(ownerId, workspaceId, "", { signal: options.signal });
  let data = await response.json();
  if (!Array.isArray(data?.sources)) throw sourceError("Saved venue images could not be read. Try again.");
  const scope = `${ownerId}:${workspaceId}`;
  let migration = migrationRuns.get(scope);
  if (!migration) {
    migration = migrateLegacySources(ownerId, workspaceId, data.sources, options);
    migrationRuns.set(scope, migration);
    void migration.finally(() => { if (migrationRuns.get(scope) === migration) migrationRuns.delete(scope); }).catch(() => undefined);
  }
  await migration;
  options.signal?.throwIfAborted();
  // Read canonical metadata again after any successful legacy uploads.
  data = await (await requestSource(ownerId, workspaceId, "", { signal: options.signal })).json();
  if (!Array.isArray(data?.sources)) throw sourceError("Saved venue images could not be read. Try again.");
  const records = await Promise.all(data.sources.map(async (metadata: Omit<VenueImageSource, "blob">) => {
    if (!validText(metadata?.id, 128) || !VENUE_IMAGE_TYPES.some(type => type === metadata.type) || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_CLOUD_IMAGE_BYTES)
      throw sourceError("Saved venue image metadata could not be read.");
    const response = await requestSource(ownerId, workspaceId, `/${encodeURIComponent(metadata.id)}/image`, { signal: options.signal });
    const blob = await response.blob();
    const source = { ...metadata, blob };
    if (!validSource(source)) throw sourceError("Saved venue images could not be read. Try again.");
    return copySource(source);
  }));
  return records.sort((a, b) => b.addedAt - a.addedAt || a.id.localeCompare(b.id));
}

export function validateVenueImageSource(source: unknown): asserts source is VenueImageSource {
  const candidate = source && typeof source === "object" ? source as Partial<VenueImageSource> : null;
  if ((typeof candidate?.size === "number" && candidate.size > MAX_VENUE_IMAGE_BYTES) ||
    (typeof Blob !== "undefined" && candidate?.blob instanceof Blob && candidate.blob.size > MAX_VENUE_IMAGE_BYTES)) {
    throw sourceError("This venue image is too large. Choose a PNG, JPEG, or WebP under 10 MB.");
  }
  if (!validSource(source)) {
    throw sourceError("This venue image could not be read. Choose a readable PNG, JPEG, or WebP under 10 MB and try again.");
  }
}

export async function saveVenueImage(ownerId: string, workspaceId: string, source: VenueImageSource, options: { signal?: AbortSignal } = {}): Promise<void> {
  validateScope(ownerId, workspaceId);
  validateVenueImageSource(source);
  const snapshot = copySource(source);
  if (snapshot.size > MAX_CLOUD_IMAGE_BYTES) throw sourceError("Prepare an image under 3 MB before saving it to your account.");
  const bytes = new Uint8Array(await snapshot.blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await requestSource(ownerId, workspaceId, "", { method: "POST", signal: options.signal,
    body: JSON.stringify({ id: snapshot.id, name: snapshot.name, image_base64: btoa(binary) }) });
}

export async function deleteVenueImage(ownerId: string, workspaceId: string, sourceId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  validateScope(ownerId, workspaceId);
  if (!validText(sourceId, 128) || sourceId.trim() !== sourceId) throw sourceError("This venue image could not be found. Refresh this page and try again.");
  await requestSource(ownerId, workspaceId, `/${encodeURIComponent(sourceId)}`, { method: "DELETE", signal: options.signal });
}
