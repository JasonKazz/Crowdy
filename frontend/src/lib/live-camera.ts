export const LIVE_FRAME_INTERVAL_MS = 2_000;
export const LIVE_STALE_AFTER_MS = 12_000;

export function smoothedCrowdCount(counts: number[]): number | null {
  const recent = counts.slice(-3).filter(count => Number.isSafeInteger(count) && count >= 0);
  if (!recent.length) return null;
  recent.sort((a, b) => a - b);
  return recent[Math.floor(recent.length / 2)];
}

export function canApplyLiveCount(count: number | null, updatedAt: string | null, now: number): boolean {
  if (count === null || count < 1 || count > 200 || !updatedAt) return false;
  const age = now - Date.parse(updatedAt);
  return Number.isFinite(age) && age >= -5_000 && age < LIVE_STALE_AFTER_MS;
}

export async function captureLiveFrame(video: HTMLVideoElement): Promise<Blob> {
  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0)
    throw new Error("Waiting for the camera image. Keep this page open.");
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not prepare a camera frame.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.8));
  if (!blob || blob.size === 0 || blob.size > 3 * 1024 * 1024)
    throw new Error("The camera frame could not be prepared. Try starting the camera again.");
  return blob;
}

export function cameraErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return "Camera access was denied. Allow camera access in Safari’s website settings, then try again.";
    if (error.name === "NotFoundError") return "No camera was found on this device.";
    if (error.name === "NotReadableError") return "The camera is being used by another app. Close it and try again.";
  }
  return error instanceof Error ? error.message : "The camera could not start. Try again.";
}
