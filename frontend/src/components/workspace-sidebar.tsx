"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import Icon from "./icon";
import styles from "./workspace-sidebar.module.css";

export type WorkspaceSidebarTab = "sources" | "editing";

type WorkspaceSidebarProps = {
  activeTab: WorkspaceSidebarTab;
  onTabChange: (tab: WorkspaceSidebarTab) => void;
  sources: ReactNode;
  children: ReactNode;
};

const tabs = [
  { id: "sources", label: "Sources", icon: "layers" },
  { id: "editing", label: "Editing", icon: "cursor" },
] as const;

export default function WorkspaceSidebar({
  activeTab,
  onTabChange,
  sources,
  children,
}: WorkspaceSidebarProps) {
  const id = useId();
  const tabRefs = useRef<Record<WorkspaceSidebarTab, HTMLButtonElement | null>>({
    sources: null,
    editing: null,
  });

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextTab = tabs[nextIndex].id;
    onTabChange(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  return (
    <aside className={`setup-panel ${styles.sidebar}`} aria-label="Workspace tools">
      <div className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.headingIcon}><Icon name="layout" size={16} /></span>
          <h2>Workspace tools</h2>
        </div>
        <div className={styles.tabs} role="tablist" aria-label="Workspace tools">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              ref={(element) => { tabRefs.current[tab.id] = element; }}
              type="button"
              role="tab"
              id={`${id}-${tab.id}-tab`}
              aria-selected={activeTab === tab.id}
              aria-controls={`${id}-${tab.id}-panel`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={styles.tab}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(event) => navigateTabs(event, index)}
            >
              <Icon name={tab.icon} size={16} />
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <div
        id={`${id}-sources-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-sources-tab`}
        hidden={activeTab !== "sources"}
        className={styles.panel}
        tabIndex={0}
      >
        {sources}
      </div>
      <div
        id={`${id}-editing-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-editing-tab`}
        hidden={activeTab !== "editing"}
        className={`${styles.panel} ${styles.editingPanel}`}
        tabIndex={0}
      >
        {children}
      </div>
    </aside>
  );
}
