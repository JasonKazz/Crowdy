import AppHeader from "@/components/app-header";
import AppFooter from "@/components/app-footer";
import WorkspacesHome from "@/components/workspaces-home";

export default function Home() {
  return (
    <div className="app-shell home-shell">
      <AppHeader />
      <WorkspacesHome />
      <AppFooter />
    </div>
  );
}
