"use client";

import { useUser } from "@auth0/nextjs-auth0";
import Link from "next/link";
import { useEffect, useState } from "react";
import AppHeader from "./app-header";
import AppFooter from "./app-footer";
import Workspace from "./workspace";
import { SAMPLE_PLAN } from "@/lib/simulation";
import { validatePlan } from "@/lib/plan-validation";
import {
  DEFAULT_SCENARIO,
  SAMPLE_WORKSPACE_ID,
  getWorkspace,
  subscribeWorkspaces,
  type WorkspaceRecord,
} from "@/lib/workspace-store";

export function WorkspaceMessage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="app-shell workspace-message-shell">
      <AppHeader />
      <main className="workspace-message">
        <h1>{title}</h1>
        {children}
      </main>
      <AppFooter />
    </div>
  );
}

export default function WorkspaceScreen({
  workspaceId,
  ownerId,
}: {
  workspaceId: string;
  ownerId: string | null;
}) {
  const { user, isLoading } = useUser();
  const subject = typeof user?.sub === "string" ? user.sub : null;
  const sample = workspaceId === SAMPLE_WORKSPACE_ID;
  const [loaded, setLoaded] = useState<{
    scope: string;
    record: WorkspaceRecord | null;
    error: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (sample || !ownerId || isLoading || subject !== ownerId) return;
    let active = true;
    let controller: AbortController | null = null;
    async function load() {
      if (!active) return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      try {
        const record = await getWorkspace(ownerId!, workspaceId, { signal: request.signal });
        if (!active || request.signal.aborted) return;
        if (record) record.plan = validatePlan(record.plan);
        setLoaded({ scope: `${ownerId}:${workspaceId}`, record, error: "" });
      } catch (error) {
        if (!active || request.signal.aborted) return;
        setLoaded({
          scope: `${ownerId}:${workspaceId}`,
          record: null,
          error:
            error instanceof Error
              ? error.message
              : "This workspace could not be loaded from your account.",
        });
      }
    }
    queueMicrotask(load);
    const unsubscribe = subscribeWorkspaces(load);
    return () => {
      active = false;
      controller?.abort();
      unsubscribe();
    };
  }, [sample, ownerId, workspaceId, isLoading, subject, retry]);

  if (sample) {
    return (
      <Workspace
        key={SAMPLE_WORKSPACE_ID}
        workspaceId={SAMPLE_WORKSPACE_ID}
        workspaceName={SAMPLE_PLAN.name}
        initialPlan={SAMPLE_PLAN}
        initialScenario={DEFAULT_SCENARIO}
        isSample
        ownerId={subject}
      />
    );
  }
  if (isLoading)
    return (
      <WorkspaceMessage title="Opening workspace">
        <p role="status">Checking your account…</p>
      </WorkspaceMessage>
    );
  if (!subject || subject !== ownerId) {
    return (
      <WorkspaceMessage title="Sign in to open this workspace">
        <p>
          Personal workspaces are available to the account that created them.
        </p>
        <a
          className="button primary"
          href={`/auth/login?returnTo=${encodeURIComponent(`/workspaces/${workspaceId}`)}`}
        >
          Sign in
        </a>
        <Link className="text-button" href="/">
          Back to workspaces
        </Link>
      </WorkspaceMessage>
    );
  }
  if (!loaded || loaded.scope !== `${ownerId}:${workspaceId}`)
    return (
      <WorkspaceMessage title="Opening workspace">
        <p role="status">Loading the saved layout…</p>
      </WorkspaceMessage>
    );
  if (loaded.error)
    return (
      <WorkspaceMessage title="Workspace could not be opened">
        <p role="alert">{loaded.error}</p>
        <button
          className="button secondary"
          onClick={() => setRetry((value) => value + 1)}
        >
          Try again
        </button>
        <Link className="text-button" href="/">
          Back to workspaces
        </Link>
      </WorkspaceMessage>
    );
  if (!loaded.record)
    return (
      <WorkspaceMessage title="Workspace not found">
        <p>
          This workspace may have been removed, or it belongs to another account. Berkeley studio is always available as a sample.
        </p>
        <Link className="button primary" href="/">
          Back to workspaces
        </Link>
        <Link
          className="text-button"
          href={`/workspaces/${SAMPLE_WORKSPACE_ID}`}
        >
          Open the sample
        </Link>
      </WorkspaceMessage>
    );

  const record = loaded.record;
  return (
    <Workspace
      key={`${ownerId}:${workspaceId}`}
      workspaceId={record.id}
      workspaceName={record.name}
      initialPlan={record.plan}
      initialScenario={record.scenario}
      isSample={false}
      ownerId={ownerId}
    />
  );
}
