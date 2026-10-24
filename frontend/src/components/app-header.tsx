"use client";

import Link from "next/link";
import AuthControls from "./auth-controls";
import Icon from "./icon";

export default function AppHeader({
  workspaceName,
  onHelp,
  onNavigate,
}: {
  workspaceName?: string;
  onHelp?: () => void;
  onNavigate?: () => boolean;
}) {
  return (
    <header className="app-header">
      <Link
        className="brand"
        href="/"
        aria-label="Crowdy home"
        onClick={(event) => {
          if (onNavigate?.() === false) event.preventDefault();
        }}
      >
        <span className="brand-symbol">
          <i />
          <i />
          <i />
          <i />
        </span>
        crowdy<span className="brand-period">.</span>
      </Link>
      <span className="header-divider" />
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link
          href="/"
          onClick={(event) => {
            if (onNavigate?.() === false) event.preventDefault();
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
        <AuthControls />
      </div>
    </header>
  );
}
