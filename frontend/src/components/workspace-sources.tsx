"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { FloorPlan } from "@/lib/simulation";
import { uploadImageDimensions } from "@/lib/image-upload";
import {
  deleteVenueImage,
  estimateVenueCrowd,
  listVenueImages,
  MAX_VENUE_IMAGE_BYTES,
  saveVenueImage,
  VENUE_IMAGE_TYPES,
  type VenueImageSource,
} from "@/lib/workspace-sources";
import Icon from "./icon";
import styles from "./workspace-sources.module.css";

type WorkspaceSourcesProps = {
  plan: FloorPlan;
  workspaceId: string;
  ownerId: string | null;
  isSample: boolean;
  busy: boolean;
  onUploadFloorPlan: () => void;
  onUseCrowdEstimate: (count: number) => void;
  children?: ReactNode;
};

type ImagePreview = VenueImageSource & { url: string };

function imageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const finish = () => {
      URL.revokeObjectURL(url);
      image.onload = null;
      image.onerror = null;
    };
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      finish();
      try {
        uploadImageDimensions(width, height);
        resolve({ width, height });
      } catch (cause) {
        reject(cause);
      }
    };
    image.onerror = () => {
      finish();
      reject(new Error("This file could not be opened as an image."));
    };
    image.src = url;
  });
}

function PlanThumbnail({ plan }: { plan: FloorPlan }) {
  const patternId = `source-grid-${useId().replaceAll(":", "")}`;
  return (
    <svg
      viewBox={`0 0 ${plan.width} ${plan.height}`}
      role="img"
      aria-label={`${plan.name} floor plan preview`}
      className={styles.planDrawing}
    >
      <defs>
        <pattern id={patternId} width="28" height="28" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1.2" fill="#d5decb" />
        </pattern>
      </defs>
      <rect width={plan.width} height={plan.height} fill={`url(#${patternId})`} />
      {plan.native?.floors.map((points, index) => (
        <polygon key={`floor-${index}`} points={points.map((point) => `${point.x},${point.y}`).join(" ")} fill="#fcfdf8" />
      ))}
      {plan.items.map((item) => item.polygon ? (
        <polygon key={item.id} points={item.polygon.map((point) => `${item.x + point.x * item.width},${item.y + point.y * item.height}`).join(" ")} fill="#dce3d3" stroke="#aab79b" strokeWidth="2" />
      ) : (
        <rect key={item.id} x={item.x} y={item.y} width={item.width} height={item.height} rx={item.kind === "plant" ? 12 : 3} fill={item.kind === "plant" ? "#a0b18e" : "#e4e6d9"} stroke="#aab79b" strokeWidth="2" />
      ))}
      <g stroke="#6a7a60" strokeWidth="7" strokeLinecap="square">
        {plan.walls.map((wall, index) => (
          <line key={`wall-${index}`} x1={wall.x1} y1={wall.y1} x2={wall.x2} y2={wall.y2} />
        ))}
        {plan.native?.walls.map((points, index) => (
          <polygon key={`native-${index}`} points={points.map((point) => `${point.x},${point.y}`).join(" ")} fill="#6a7a60" strokeWidth="0" />
        ))}
      </g>
      {plan.exits.map((exit) => (
        <circle key={exit.id} cx={exit.x} cy={exit.y} r="13" fill="#dcebcf" stroke="#6b8d50" strokeWidth="4" />
      ))}
    </svg>
  );
}

export default function WorkspaceSources({
  plan,
  workspaceId,
  ownerId,
  isSample,
  busy,
  onUploadFloorPlan,
  onUseCrowdEstimate,
  children,
}: WorkspaceSourcesProps) {
  const [images, setImages] = useState<ImagePreview[]>([]);
  const [loading, setLoading] = useState(!isSample && !!ownerId);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const operation = useRef(false);
  const objectUrls = useRef(new Set<string>());
  const dragDepth = useRef(0);
  const headingId = useId();
  const descriptionId = useId();
  const disabled = busy || loading || uploading || removing !== null;
  const hasFloorPlan = plan.walls.length > 0 || (plan.native?.floors.length ?? 0) > 0;
  const persistent = !isSample && ownerId !== null;

  useEffect(() => {
    const current = ++generation.current;
    const urls = objectUrls.current;
    async function loadImages() {
      try {
        const sources = !isSample && ownerId ? await listVenueImages(ownerId, workspaceId) : [];
        if (generation.current !== current) return;
        const previews = sources.map((source) => {
          const url = URL.createObjectURL(source.blob);
          urls.add(url);
          return { ...source, url };
        });
        setImages(previews);
      } catch (cause) {
        if (generation.current === current) {
          setError(cause instanceof Error ? cause.message : "Saved venue images could not be loaded.");
        }
      } finally {
        if (generation.current === current) setLoading(false);
      }
    }
    void loadImages();
    return () => {
      generation.current = current + 1;
      operation.current = false;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, [isSample, ownerId, workspaceId]);

  async function uploadImages(files: File[]) {
    if (disabled || operation.current || !files.length) return;
    operation.current = true;
    setUploading(true);
    setError("");
    setStatus(`Adding ${files.length === 1 ? "venue image" : `${files.length} venue images`}…`);
    const current = generation.current;
    const accepted: ImagePreview[] = [];
    const failures: string[] = [];
    for (const file of files) {
      if (generation.current !== current) return;
      try {
        if (!(VENUE_IMAGE_TYPES as readonly string[]).includes(file.type)) {
          throw new Error("Choose a PNG, JPG, or WebP image.");
        }
        if (file.size > MAX_VENUE_IMAGE_BYTES) throw new Error("Images must be 10 MB or smaller.");
        if (file.size === 0) throw new Error("This image is empty. Choose another file.");
        const dimensions = await imageSize(file);
        if (generation.current !== current) return;
        const source: VenueImageSource = {
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type,
          size: file.size,
          ...dimensions,
          addedAt: Date.now(),
          blob: file,
        };
        if (persistent && ownerId) await saveVenueImage(ownerId, workspaceId, source);
        if (generation.current !== current) return;
        const url = URL.createObjectURL(file);
        objectUrls.current.add(url);
        accepted.push({ ...source, url });
      } catch (cause) {
        failures.push(`${file.name}: ${cause instanceof Error ? cause.message : "This image could not be added."}`);
      }
    }
    if (generation.current !== current) return;
    if (accepted.length) {
      setImages((previous) => [...accepted.reverse(), ...previous]);
      const estimate = estimateVenueCrowd({ images: accepted, venueArea: plan.area });
      onUseCrowdEstimate(estimate);
      setStatus(`${accepted.length === 1 ? "Venue image added" : `${accepted.length} venue images added`}. Crowd set to ${estimate} people.`);
    } else setStatus("");
    if (failures.length) setError(failures.join(" "));
    operation.current = false;
    setUploading(false);
  }

  async function removeImage(source: ImagePreview) {
    if (disabled || operation.current) return;
    operation.current = true;
    setRemoving(source.id);
    setError("");
    const current = generation.current;
    try {
      if (persistent && ownerId) await deleteVenueImage(ownerId, workspaceId, source.id);
      if (generation.current !== current) return;
      setImages((previous) => previous.filter((image) => image.id !== source.id));
      objectUrls.current.delete(source.url);
      URL.revokeObjectURL(source.url);
      setStatus(`${source.name} removed.`);
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : "This image could not be removed.");
    } finally {
      if (generation.current === current) {
        operation.current = false;
        setRemoving(null);
      }
    }
  }

  return (
    <div className={styles.panel}>
      <section className={styles.section} aria-labelledby={`${headingId}-plan`}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionIcon}><Icon name="layout" size={16} /></span>
          <h3 id={`${headingId}-plan`}>Floor plan</h3>
          <span className={styles.sectionNumber}>01</span>
        </div>
        <div className={styles.planCard}>
          <div className={styles.planPreview}>
            <PlanThumbnail plan={plan} />
            <span className={styles.planTag}><span />{hasFloorPlan ? "Current layout" : "Empty layout"}</span>
          </div>
          <div className={styles.planSummary}>
            <p className={styles.planName} title={plan.name}>{plan.name}</p>
            <dl className={styles.planFacts}>
              <div><dt>Area</dt><dd>{new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(plan.area)} <span>m²</span></dd></div>
              <div><dt>Exits</dt><dd>{plan.exits.length} <span>{plan.exits.length === 1 ? "exit" : "exits"}</span></dd></div>
            </dl>
            <button type="button" className={styles.planButton} onClick={onUploadFloorPlan} disabled={busy}>
              <Icon name="upload" size={14} />{hasFloorPlan ? "Replace floor plan" : "Add floor plan"}
            </button>
          </div>
        </div>
        {children ? <div className={styles.scaleControls}>{children}</div> : null}
      </section>

      <section className={styles.section} aria-labelledby={`${headingId}-venue`} aria-busy={loading || uploading}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionIcon}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><circle cx="8" cy="10" r="1.5" /><path d="m3 17 5-4 4 3 4-5 5 6M8 5l1-2h6l1 2" /></svg>
          </span>
          <h3 id={`${headingId}-venue`}>Venue images</h3>
          {images.length > 0 ? <span className={styles.imageCount}>{images.length}</span> : <span className={styles.sectionNumber}>02</span>}
        </div>
        <p className={styles.sectionDescription}>Add a view of your venue to set the starting crowd.</p>
        <input
          ref={fileInput}
          className={styles.fileInput}
          type="file"
          accept={VENUE_IMAGE_TYPES.join(",")}
          multiple
          disabled={disabled}
          tabIndex={-1}
          aria-label="Upload venue images"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void uploadImages(files);
          }}
        />
        <div
          className={`${styles.dropArea} ${dragging && !disabled ? styles.dragging : ""} ${disabled ? styles.dropDisabled : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            if (disabled) return;
            dragDepth.current++;
            setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = disabled ? "none" : "copy";
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (!dragDepth.current) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            void uploadImages(Array.from(event.dataTransfer.files));
          }}
        >
          <button type="button" className={styles.dropButton} disabled={disabled} aria-describedby={descriptionId} onClick={() => fileInput.current?.click()}>
            <span className={styles.uploadIcon}><Icon name="plus" size={18} /></span>
            <span className={styles.dropLabel}>{uploading ? "Adding images…" : dragging ? "Drop your images here" : "Add venue images"}</span>
            <span className={styles.dropHint}>Choose files or drag them here</span>
          </button>
          <p className={styles.fileTypes} id={descriptionId}>PNG, JPG, WebP · up to 10 MB each</p>
        </div>

        {loading ? <p className={styles.loading}>Loading your venue images…</p> : null}
        {images.length > 0 ? (
          <>
            <ul className={styles.imageList} aria-label="Venue image sources">
              {images.map((image) => (
                <li key={image.id} className={styles.imageRow}>
                  {/* Object URLs are local previews; Next Image optimization cannot fetch them. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className={styles.thumbnail} src={image.url} alt={`Venue source: ${image.name}`} width={48} height={48} />
                  <div className={styles.imageDetails}>
                    <p title={image.name}>{image.name}</p>
                    <span>{image.width} × {image.height}<span className={styles.dimensionDot}>·</span>{Math.max(1, Math.round(image.size / 1024))} KB</span>
                  </div>
                  <button type="button" className={styles.removeButton} aria-label={`Remove ${image.name}`} title={`Remove ${image.name}`} disabled={disabled} onClick={() => void removeImage(image)}>
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ul>
            <div className={styles.estimateCard}>
              <div className={styles.estimateTop}><span><Icon name="people" size={15} />Estimated crowd</span><span className={styles.previewBadge}>Preview</span></div>
              <p className={styles.estimateNumber}>80 <span>people</span></p>
              <p className={styles.estimateNote}>Fixed at 80 for now, for any venue image.</p>
              <button type="button" className={styles.estimateButton} disabled={disabled} onClick={() => {
                const estimate = estimateVenueCrowd({ images, venueArea: plan.area });
                onUseCrowdEstimate(estimate);
                setStatus(`Crowd set to ${estimate} people.`);
              }}>Use 80 people<Icon name="arrow" size={14} /></button>
            </div>
          </>
        ) : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <p className={status ? styles.status : styles.emptyStatus} role="status" aria-live="polite" aria-atomic="true">{status}</p>
      </section>
    </div>
  );
}
