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

const DATABASE = "crowdy-workspace-sources-v1";
const STORE = "venue-images";
const WORKSPACE_INDEX = "workspace";
const STORAGE_ERROR =
  "Venue images could not be saved in this browser. Enable site storage and try again.";

type StoredVenueImage = VenueImageSource & {
  ownerId: string;
  workspaceId: string;
};

function sourceError(message: string): Error {
  const error = new Error(message);
  error.name = "WorkspaceSourceError";
  return error;
}

function storageError(error: unknown): Error {
  const name = error && typeof error === "object" && "name" in error ? error.name : "";
  if (name === "QuotaExceededError") {
    return sourceError(
      "This browser has no space left for venue images. Remove an image or free some browser storage and try again.",
    );
  }
  if (name === "SecurityError" || name === "NotAllowedError") {
    return sourceError(
      "Browser storage is unavailable. Enable site storage to save venue images and try again.",
    );
  }
  return sourceError(STORAGE_ERROR);
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let factory: IDBFactory;
    try {
      if (typeof window === "undefined" || !window.indexedDB) {
        reject(sourceError("Browser storage is unavailable. Enable site storage to save venue images and try again."));
        return;
      }
      factory = window.indexedDB;
    } catch (error) {
      reject(storageError(error));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DATABASE, 1);
    } catch (error) {
      reject(storageError(error));
      return;
    }
    let blocked = false;
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, {
        keyPath: ["ownerId", "workspaceId", "id"],
      });
      store.createIndex(WORKSPACE_INDEX, ["ownerId", "workspaceId"]);
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () => {
      blocked = true;
      reject(sourceError("Venue image storage is busy in another tab. Close other Crowdy tabs and try again."));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function storeRequest<T>(
  mode: IDBTransactionMode,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest<T>;
    try {
      transaction = database.transaction(STORE, mode);
      request = createRequest(transaction.objectStore(STORE));
    } catch (error) {
      database.close();
      reject(storageError(error));
      return;
    }
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    // Request success only means the operation was queued; the transaction can
    // still fail (for example, when committing a Blob exceeds the quota).
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onabort = () => {
      database.close();
      reject(storageError(transaction.error ?? request.error));
    };
    transaction.onerror = () => {
      // IndexedDB aborts after an unhandled request error; onabort reports the
      // final failure, so callers never mistake request success for persistence.
    };
  });
}

export async function listVenueImages(ownerId: string, workspaceId: string): Promise<VenueImageSource[]> {
  validateScope(ownerId, workspaceId);
  const records = await storeRequest<StoredVenueImage[]>("readonly", (store) =>
    store.index(WORKSPACE_INDEX).getAll([ownerId, workspaceId]),
  );
  if (!Array.isArray(records) || records.some((record) =>
    !validSource(record) || record.ownerId !== ownerId || record.workspaceId !== workspaceId,
  )) {
    throw sourceError("Saved venue images could not be read. Existing images have been kept. Try refreshing this page.");
  }
  return records.map(copySource).sort((a, b) => b.addedAt - a.addedAt || a.id.localeCompare(b.id));
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

export async function saveVenueImage(ownerId: string, workspaceId: string, source: VenueImageSource): Promise<void> {
  validateScope(ownerId, workspaceId);
  validateVenueImageSource(source);
  const record: StoredVenueImage = { ...copySource(source), ownerId, workspaceId };
  await storeRequest("readwrite", (store) => store.put(record));
}

export async function deleteVenueImage(ownerId: string, workspaceId: string, sourceId: string): Promise<void> {
  validateScope(ownerId, workspaceId);
  if (!validText(sourceId, 128) || sourceId.trim() !== sourceId) {
    throw sourceError("This venue image could not be found. Refresh this page and try again.");
  }
  await storeRequest("readwrite", (store) => store.delete([ownerId, workspaceId, sourceId]));
}

// Placeholder until image-based crowd estimation is connected. Deliberately
// ignore image contents, venue dimensions, and any supplied occupancy.
export function estimateVenueCrowd(input?: unknown): number {
  void input;
  return 80;
}
