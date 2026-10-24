import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import AppHeader from "@/components/app-header";
import AppFooter from "@/components/app-footer";
import WorkspaceScreen from "@/components/workspace-screen";
import { auth0 } from "@/lib/auth0";
import { SAMPLE_WORKSPACE_ID } from "@/lib/workspace-store";

type Params = Promise<{ workspaceId: string }>;

async function WorkspaceContent({ params }: { params: Params }) {
  const { workspaceId } = await params;
  if (workspaceId === SAMPLE_WORKSPACE_ID)
    return <WorkspaceScreen workspaceId={workspaceId} ownerId={null} />;
  if (!/^ws-[a-zA-Z0-9-]{1,100}$/.test(workspaceId)) notFound();
  const session = await auth0.getSession();
  if (!session?.user.sub)
    redirect(
      `/auth/login?returnTo=${encodeURIComponent(`/workspaces/${workspaceId}`)}`,
    );
  return (
    <WorkspaceScreen workspaceId={workspaceId} ownerId={session.user.sub} />
  );
}

function LoadingWorkspace() {
  return (
    <div className="app-shell workspace-message-shell">
      <AppHeader />
      <main className="workspace-message">
        <h1>Opening workspace</h1>
        <p role="status">Loading the floor plan…</p>
      </main>
      <AppFooter />
    </div>
  );
}

export default function WorkspacePage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<LoadingWorkspace />}>
      <WorkspaceContent params={params} />
    </Suspense>
  );
}
