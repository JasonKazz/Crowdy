"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import AuthControls from "./auth-controls";
import BrandLogo from "./brand-logo";
import Icon from "./icon";
import ThemeToggle from "./theme-toggle";

export default function AppHeader({
  workspaceName,
  onHelp,
  onNavigate,
}: {
  workspaceName?: string;
  onHelp?: () => void;
  onNavigate?: () => boolean | Promise<boolean>;
}) {
  const router = useRouter();
  return (
    <header className="app-header">
      <Link
        className="brand"
        href="/"
        aria-label="Crowdy home"
        onClick={async (event) => {
          if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          if (await onNavigate()) router.push("/");
        }}
      >
        <BrandLogo alt="" preload />
      </Link>
      <span className="header-divider" />
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link
          href="/"
          onClick={async (event) => {
            if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (await onNavigate()) router.push("/");
          }}
        >
          Workspaces
        </Link>
        {workspaceName && (
          <>
            <Icon name="chevron" size={13} />
            <strong>{workspaceName}</strong>
          </>
        )}
      </nav>
      <div className="header-right">
        {onHelp && (
          <button
            className="icon-button help-button"
            aria-label="Simulation assumptions"
            onClick={onHelp}
          >
            <Icon name="help" />
          </button>
        )}
        <ThemeToggle />
        <AuthControls />
      </div>
    </header>
  );
}
