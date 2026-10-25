"use client";

import { useUser } from "@auth0/nextjs-auth0";
import WorkspaceLink from "./workspace-link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Icon from "./icon";
import BrandLogo from "./brand-logo";
import { SAMPLE_PLAN, type FloorPlan } from "@/lib/simulation";
import {
  createWorkspace,
  DEFAULT_SCENARIO,
  deleteWorkspace,
  listWorkspaces,
  SAMPLE_WORKSPACE_ID,
  subscribeWorkspaces,
  type WorkspaceRecord,
} from "@/lib/workspace-store";
import styles from "./workspaces-home.module.css";

type CreateDialog = {
  ownerId: string;
  type: "create";
  template: "empty" | "sample";
  source?: WorkspaceRecord;
};
type DialogState =
  | CreateDialog
  | { ownerId: string; type: "delete"; workspace: WorkspaceRecord }
  | null;
type LibraryState = {
  ownerId: string | null;
  records: WorkspaceRecord[];
  error: string;
};

function PlanPreview({
  plan,
  sample = false,
}: {
  plan: FloorPlan;
  sample?: boolean;
}) {
  const pattern = useId().replaceAll(":", "");
  return (
    <div className={styles.preview}>
      <svg
        viewBox="35 45 830 510"
        role="img"
        aria-label={`${plan.name} floor plan preview`}
      >
        <defs>
          <pattern
            id={`workspace-grid-${pattern}`}
            width="18"
            height="18"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r="0.65" fill="var(--plan-guide, #cfd7c5)" />
          </pattern>
        </defs>
        <rect
          x="35"
          y="45"
          width="830"
          height="510"
          fill={`url(#workspace-grid-${pattern})`}
        />
        <rect x="80" y="90" width="740" height="420" fill="var(--plan-floor, #fcfdf9)" />
        {sample && (
          <>
            <rect x="610" y="90" width="210" height="145" fill="var(--plan-room, #f1f4eb)" />
            <rect x="565" y="355" width="248" height="148" fill="var(--plan-lounge, #f4f3eb)" />
          </>
        )}
        {plan.items.map((item) => (
          <g key={item.id} transform={`translate(${item.x} ${item.y})`}>
            {item.kind === "plant" ? (
              <>
                <circle
                  cx={item.width / 2}
                  cy={item.height / 2}
                  r={Math.min(item.width, item.height) / 2}
                  fill="#93a681"
                />
                <path
                  d={`M${item.width / 2} 3v${item.height - 6}M3 ${item.height / 2}h${item.width - 6}`}
                  stroke="#728963"
                  strokeWidth="1.4"
                />
              </>
            ) : (
              <>
                <rect
                  width={item.width}
                  height={item.height}
                  rx={item.kind === "table" ? 12 : item.kind === "sofa" ? 6 : 2}
                  fill={
                    item.kind === "sofa"
                      ? "var(--plan-sofa, #dce4d0)"
                      : item.kind === "obstacle"
                        ? "var(--plan-furniture, #e6d9c8)"
                        : "var(--plan-furniture, #eae5d8)"
                  }
                  stroke={item.kind === "sofa" ? "var(--plan-seat-stroke, #a6b696)" : "var(--plan-furniture-stroke, #bdb7a8)"}
                  strokeWidth="1.5"
                />
                {item.kind === "desk" && (
                  <>
                    <rect
                      x={item.width / 2 - 17}
                      y="7"
                      width="34"
                      height="15"
                      rx="2"
                      fill="var(--plan-seat, #d1dbce)"
                      stroke="var(--plan-seat-stroke, #a5b19d)"
                    />
                    <path
                      d={`M${item.width / 2} 22v6m-7 0h14`}
                      stroke="var(--plan-seat-stroke, #a5b19d)"
                    />
                    <rect
                      x={item.width / 2 - 10}
                      y={item.height + 5}
                      width="20"
                      height="18"
                      rx="5"
                      fill="var(--plan-seat, #edf0e6)"
                      stroke="var(--plan-seat-stroke, #b7c0ac)"
                    />
                  </>
                )}
                {item.kind === "table" &&
                  [item.width * 0.25, item.width * 0.75].map((x) => (
                    <g key={x}>
                      <rect
                        x={x - 8}
                        y="-22"
                        width="16"
                        height="16"
                        rx="4"
                        fill="var(--plan-seat, #edf0e6)"
                        stroke="var(--plan-seat-stroke, #b7c0ac)"
                      />
                      <rect
                        x={x - 8}
                        y={item.height + 6}
                        width="16"
                        height="16"
                        rx="4"
                        fill="var(--plan-seat, #edf0e6)"
                        stroke="var(--plan-seat-stroke, #b7c0ac)"
                      />
                    </g>
                  ))}
                {item.kind === "shelf" && (
                  <path
                    d={
                      item.width > item.height
                        ? `M${item.width / 3} 3v${item.height - 6}m${item.width / 3} ${-item.height + 6}v${item.height - 6}`
                        : `M3 ${item.height / 3}h${item.width - 6}M3 ${(item.height * 2) / 3}h${item.width - 6}`
                    }
                    stroke="var(--plan-furniture-stroke, #b7b298)"
                    strokeWidth="3"
                  />
                )}
              </>
            )}
          </g>
        ))}
        <g stroke="var(--plan-wall, #727d65)" strokeWidth="7" fill="none" strokeLinecap="square">
          {plan.walls.map((wall, index) => (
            <path
              key={index}
              d={`M${wall.x1} ${wall.y1}L${wall.x2} ${wall.y2}`}
            />
          ))}
        </g>
        {plan.exits.map((exit) => (
          <g key={exit.id} transform={`translate(${exit.x} ${exit.y})`}>
            <rect
              x="-13"
              y="-17"
              width="26"
              height="34"
              rx="3"
              fill="#e6efdd"
              stroke="#9bb58a"
              strokeWidth="1.5"
            />
            <path
              d={
                exit.x < plan.width / 2
                  ? "M6 0H-6m4-4-4 4 4 4"
                  : "M-6 0H6m-4-4 4 4-4 4"
              }
              fill="none"
              stroke="#63824c"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))}
      </svg>
      {sample && <span className={styles.sampleBadge}>Sample</span>}
    </div>
  );
}

function updatedLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp);
}

function NewWorkspaceCardContent() {
  return (
    <>
      <span className={styles.newCardIcon}>
        <Icon name="plus" size={23} />
      </span>
      <strong>New workspace</strong>
      <span>Start with an empty layout</span>
    </>
  );
}

export default function WorkspacesHome() {
  const { user, isLoading } = useUser();
  const ownerId = typeof user?.sub === "string" ? user.sub : null;
  const router = useRouter();
  const [library, setLibrary] = useState<LibraryState>({
    ownerId: null,
    records: [],
    error: "",
  });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const accountRequests = useRef<AbortController | null>(null);
  const libraryRequest = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogTitleId = useId();
  const activeDialog =
    !isLoading &&
    ownerId &&
    dialog &&
    dialog.ownerId === ownerId &&
    (dialog.type === "create"
      ? !dialog.source || dialog.source.ownerId === ownerId
      : dialog.workspace.ownerId === ownerId)
      ? dialog
      : null;

  const refreshLibrary = useCallback(async () => {
    libraryRequest.current?.abort();
    const controller = new AbortController();
    libraryRequest.current = controller;
    if (!ownerId) {
      setLibrary({ ownerId: null, records: [], error: "" });
      return;
    }
    try {
      const records = await listWorkspaces(ownerId, { signal: controller.signal });
      if (!controller.signal.aborted) setLibrary({ ownerId, records, error: "" });
    } catch (cause) {
      if (!controller.signal.aborted) setLibrary({ ownerId, records: [], error:
        cause instanceof Error ? cause.message : "Your workspaces could not be loaded. Try again." });
    }
  }, [ownerId]);

  useEffect(() => {
    const controller = new AbortController();
    accountRequests.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void refreshLibrary(); });
    const unsubscribe = subscribeWorkspaces(() => { if (!controller.signal.aborted) void refreshLibrary(); });
    return () => {
      controller.abort();
      libraryRequest.current?.abort();
      unsubscribe();
    };
  }, [refreshLibrary]);

  useEffect(() => {
    if (activeDialog) {
      dialogRef.current?.showModal();
      if (activeDialog.type === "create") nameRef.current?.focus();
      return;
    }
    dialogRef.current?.close();
    if (!dialog) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setDialog(null);
      setName("");
      setFormError("");
      setBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [activeDialog, dialog]);

  const ready = Boolean(ownerId && library.ownerId === ownerId);
  const records = ready ? library.records : [];
  const storageError = ready ? library.error : "";

  function openCreate(template: "empty" | "sample", source?: WorkspaceRecord) {
    if (!ownerId || isLoading || (source && source.ownerId !== ownerId)) return;
    setFormError("");
    setName(
      source
        ? `${source.name} copy`.slice(0, 80)
        : template === "sample"
          ? "Berkeley studio copy"
          : "",
    );
    setDialog({ ownerId, type: "create", template, source });
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !ownerId ||
      isLoading ||
      activeDialog?.type !== "create" ||
      activeDialog.ownerId !== ownerId ||
      (activeDialog.source && activeDialog.source.ownerId !== ownerId)
    ) {
      setDialog(null);
      setName("");
      setFormError("");
      return;
    }
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("Give your workspace a name.");
      nameRef.current?.focus();
      return;
    }
    const controller = accountRequests.current;
    if (!controller || controller.signal.aborted || busy) return;
    setBusy(true);
    try {
      const plan = structuredClone(activeDialog.source?.plan ?? SAMPLE_PLAN);
      plan.name = trimmedName;
      if (!activeDialog.source && activeDialog.template === "empty") {
        plan.id = `empty-${crypto.randomUUID()}`;
        plan.items = [];
        plan.walls = plan.walls.slice(0, 6);
      }
      const created = await createWorkspace(ownerId, {
        name: trimmedName,
        plan,
        scenario: structuredClone(
          activeDialog.source?.scenario ?? DEFAULT_SCENARIO,
        ),
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setDialog(null);
      router.push(`/workspaces/${created.id}`);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setFormError(
        cause instanceof Error
          ? cause.message
          : "This workspace could not be saved to your account. Try again.",
      );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function confirmDelete() {
    if (
      !ownerId ||
      isLoading ||
      activeDialog?.type !== "delete" ||
      activeDialog.ownerId !== ownerId ||
      activeDialog.workspace.ownerId !== ownerId
    )
      return;
    const controller = accountRequests.current;
    if (!controller || controller.signal.aborted || busy) return;
    setBusy(true);
    try {
      await deleteWorkspace(ownerId, activeDialog.workspace.id, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setDialog(null);
      refreshLibrary();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setFormError(
        cause instanceof Error
          ? cause.message
          : "This workspace could not be deleted. Try again.",
      );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <main className={styles.home}>
      <section className={styles.intro} aria-labelledby="intro-title">
        <div className={styles.introCopy}>
          <h1 id="intro-title"><span>Plan what’s next.</span></h1>
          <p className={styles.introDescription}>
            Test evacuation plans for safer spaces.
          </p>
        </div>
        <div className={styles.introArt} aria-hidden="true">
          <span className={styles.orbit} />
          <span className={styles.orbitInner} />
          <BrandLogo variant="symbol" alt="" className={styles.heroSymbol} />
        </div>
      </section>

      <div className={styles.heading}>
        <div>
          <h2 id="workspaces-title">
            {!isLoading && ownerId ? "Your workspaces" : "Workspaces"}
          </h2>
          <p>
            {isLoading
              ? "Checking your account…"
              : ownerId
                ? "Open a workspace or start a new floor plan."
                : "Explore the sample, or sign in to create your own."}
          </p>
        </div>
      </div>

      <section aria-labelledby="workspaces-title">
        {isLoading ? (
          <div className={styles.loading} role="status">
            <span />
            Loading your workspace home
          </div>
        ) : ownerId && !ready ? (
          <div className={styles.loading} role="status">
            <span />
            Loading your workspaces
          </div>
        ) : ownerId && storageError ? (
          <div className={styles.storageError} role="alert">
            <Icon name="help" size={18} />
            <div>
              <strong>Your workspaces couldn’t be loaded</strong>
              <p>{storageError}</p>
              <button className="text-button" onClick={refreshLibrary}>
                Try again
                <Icon name="reset" size={13} />
              </button>
            </div>
          </div>
        ) : null}

        <div className={styles.workspaceGrid}>
          {!isLoading && records.map((record) => (
            <article className={styles.card} key={record.id}>
              <WorkspaceLink
                href={`/workspaces/${record.id}`}
                className={styles.cardLink}
                aria-label={`Open ${record.name}`}
              >
                <PlanPreview plan={record.plan} />
                <div className={styles.cardBody}>
                  <div className={styles.cardTitle}>
                    <h2>{record.name}</h2>
                    <Icon name="arrow" size={17} />
                  </div>
                  <p>
                    {record.plan.area} m²<span>·</span>
                    {record.plan.exits.length} exits<span>·</span>
                    {record.scenario.occupancy} people
                  </p>
                </div>
              </WorkspaceLink>
              <div className={styles.cardFooter}>
                <time dateTime={new Date(record.updatedAt).toISOString()}>
                  Updated {updatedLabel(record.updatedAt)}
                </time>
                <div>
                  <button
                    className={styles.smallButton}
                    onClick={() => openCreate("sample", record)}
                    aria-label={`Duplicate ${record.name}`}
                  >
                    <Icon name="compare" size={14} />
                    <span>Duplicate</span>
                  </button>
                  <button
                    className={styles.deleteButton}
                    aria-label={`Delete ${record.name}`}
                    onClick={() => {
                      setFormError("");
                      setDialog({
                        ownerId: record.ownerId,
                        type: "delete",
                        workspace: record,
                      });
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
            </article>
          ))}
          <article className={styles.card}>
            <WorkspaceLink
              href={`/workspaces/${SAMPLE_WORKSPACE_ID}`}
              className={styles.cardLink}
              aria-label="Open Berkeley studio sample workspace"
            >
              <PlanPreview plan={SAMPLE_PLAN} sample />
              <div className={styles.cardBody}>
                <div className={styles.cardTitle}>
                  <h2>Berkeley studio</h2>
                  <Icon name="arrow" size={17} />
                </div>
                <p>
                  {SAMPLE_PLAN.area} m²<span>·</span>
                  {SAMPLE_PLAN.exits.length} exits<span>·</span>
                  {DEFAULT_SCENARIO.occupancy} people
                </p>
              </div>
            </WorkspaceLink>
            <div className={styles.cardFooter}>
              <span>Original sample</span>
              {!isLoading && ownerId ? (
                <button
                  className={styles.smallButton}
                  onClick={() => openCreate("sample")}
                >
                  <Icon name="compare" size={14} />
                  Make a copy
                </button>
              ) : (
                <WorkspaceLink
                  className={styles.smallButton}
                  href={`/workspaces/${SAMPLE_WORKSPACE_ID}`}
                >
                  Open sample
                  <Icon name="arrow" size={13} />
                </WorkspaceLink>
              )}
            </div>
          </article>
          {!isLoading &&
            (ownerId ? (
              <button
                className={styles.newCard}
                onClick={() => openCreate("empty")}
              >
                <NewWorkspaceCardContent />
              </button>
            ) : (
              <a className={styles.newCard} href="/auth/login?returnTo=/">
                <NewWorkspaceCardContent />
              </a>
            ))}
        </div>
      </section>

      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={dialogTitleId}
        onCancel={() => setDialog(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget && !busy) setDialog(null);
        }}
      >
        <div className={styles.dialogHeading}>
          <h2 id={dialogTitleId}>
            {activeDialog?.type === "delete"
              ? "Delete workspace?"
              : activeDialog?.type === "create" && activeDialog.source
                ? "Duplicate workspace"
                : "Create workspace"}
          </h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={() => setDialog(null)}
          >
            <Icon name="close" />
          </button>
        </div>
        {activeDialog?.type === "create" ? (
          <form onSubmit={submitCreate}>
            <label className={styles.fieldLabel} htmlFor="workspace-name">
              Workspace name
            </label>
            <input
              ref={nameRef}
              id="workspace-name"
              className={styles.nameInput}
              value={name}
              placeholder="e.g. Ground floor study"
              maxLength={80}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => {
                setName(event.target.value);
                setFormError("");
              }}
            />
            {!activeDialog.source ? (
              <fieldset className={styles.templateFieldset}>
                <legend>Start from</legend>
                <div className={styles.templateOptions}>
                  {(
                    [
                      {
                        value: "empty",
                        title: "Empty layout",
                        detail: "An open floor plan with two exits",
                        icon: "layout",
                      },
                      {
                        value: "sample",
                        title: "Berkeley studio",
                        detail: "A copy of the furnished sample",
                        icon: "compare",
                      },
                    ] as const
                  ).map((template) => (
                    <label
                      key={template.value}
                      className={
                        activeDialog.template === template.value
                          ? styles.selectedTemplate
                          : styles.template
                      }
                    >
                      <input
                        type="radio"
                        name="template"
                        value={template.value}
                        checked={activeDialog.template === template.value}
                        disabled={busy}
                        onChange={() =>
                          setDialog({
                            ...activeDialog,
                            template: template.value,
                          })
                        }
                      />
                      <Icon name={template.icon} size={18} />
                      <span>
                        <strong>{template.title}</strong>
                        <span>{template.detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <p className={styles.dialogCopy}>
                Copies the layout and scenario from{" "}
                <strong>{activeDialog.source.name}</strong>.
              </p>
            )}
            <p className={styles.localNote}>
              This workspace is saved to your account.
            </p>
            {formError && (
              <div className={styles.formError} role="alert">
                {formError}
              </div>
            )}
            <div className={styles.dialogActions}>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy
                  ? "Creating…"
                  : activeDialog.source
                    ? "Create copy"
                    : "Create workspace"}
                <Icon name="arrow" size={14} />
              </button>
            </div>
          </form>
        ) : activeDialog?.type === "delete" ? (
          <>
            <p className={styles.deleteCopy}>
              This removes <strong>{activeDialog.workspace.name}</strong> from
              your account, including its saved sources. This
              action can’t be undone.
            </p>
            {formError && (
              <div className={styles.formError} role="alert">
                {formError}
              </div>
            )}
            <div className={styles.dialogActions}>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                Keep workspace
              </button>
              <button
                className={`button ${styles.confirmDelete}`}
                disabled={busy}
                onClick={confirmDelete}
              >
                {busy ? "Deleting…" : "Delete workspace"}
              </button>
            </div>
          </>
        ) : null}
      </dialog>
    </main>
  );
}
