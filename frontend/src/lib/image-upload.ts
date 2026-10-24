// Keep the base64 JSON request below the hosting service's request limit.
// Preserve the canonical image size used by staged extraction and its overlay.
export const MAX_IMAGE_DIMENSION = 3072;
export const MAX_UPLOAD_IMAGE_BYTES = 3 * 1024 * 1024;
export const IMAGE_UPLOAD_SIZE_ERROR =
  "This image is too large to upload. Crop to one floor plan or export a smaller PNG or JPEG, then try again.";

export function uploadImageDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error("Could not read this image’s dimensions. Choose a readable PNG, JPEG, or WebP.");
  if (width * height > 30_000_000)
    throw new Error("The image is too large. Resize it below 30 million pixels.");
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function imageBase64Length(bytes: number) {
  return 4 * Math.ceil(bytes / 3);
}

export async function encodeUploadImage(encode: (type: string, quality?: number) => Promise<Blob>) {
  // PNG keeps floor-plan lines lossless whenever its size fits. A white-backed
  // JPEG retains the exact same dimensions and geometry if PNG is too large.
  for (const [type, quality] of [["image/png", undefined], ["image/jpeg", .92], ["image/jpeg", .82]] as const) {
    const blob = await encode(type, quality);
    if (blob.size > 0 && blob.size <= MAX_UPLOAD_IMAGE_BYTES)
      return blob;
  }
  throw new Error(IMAGE_UPLOAD_SIZE_ERROR);
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not prepare this image. Try exporting it as PNG or JPEG.")), type, quality);
  });
}

function blobBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read this image. Try choosing it again."));
    reader.readAsDataURL(blob);
  });
}

export async function prepareImageUpload(file: File) {
  let image: ImageBitmap;
  try {
    // Decode EXIF orientation once. Canvas output strips that metadata so the
    // backend cannot rotate it again; scale picking and overlays use this image.
    image = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("Could not decode this image. Choose a readable PNG, JPEG, or WebP.");
  }
  try {
    const { width, height } = uploadImageDimensions(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare this image in this browser. Try another browser or export a smaller PNG.");
    context.fillStyle = "white";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    const blob = await encodeUploadImage((type, quality) => canvasBlob(canvas, type, quality));
    const encoded = await blobBase64(blob);
    if (encoded.length !== imageBase64Length(blob.size) || encoded.length > imageBase64Length(MAX_UPLOAD_IMAGE_BYTES))
      throw new Error(IMAGE_UPLOAD_SIZE_ERROR);
    const base = file.name.replace(/\.[^.]*$/, "").slice(0, 200) || "floor-plan";
    return { filename: `${base}.${blob.type === "image/png" ? "png" : "jpg"}`, image_base64: encoded, blob, width, height };
  } finally {
    image.close();
  }
}
