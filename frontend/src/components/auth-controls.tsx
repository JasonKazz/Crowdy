"use client";

import { useUser } from "@auth0/nextjs-auth0";
import { useEffect, useId, useRef, useState } from "react";
import Icon from "./icon";
import styles from "./auth-controls.module.css";

const LOGIN_URL = "/auth/login?returnTo=/";
const SIGNUP_URL = "/auth/login?screen_hint=signup&returnTo=/";

export default function AuthControls() {
  const { user, isLoading, error } = useUser();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const signOutRef = useRef<HTMLAnchorElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    signOutRef.current?.focus();

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (isLoading) {
    return (
      <span className={styles.loading} role="status">
        <span className={styles.loadingAvatar} aria-hidden="true" />
        <span>Checking account</span>
      </span>
    );
  }

  if (!user) {
    // The SDK uses "Unauthorized" for unsuccessful profile responses. Keep
    // account entry points available whenever no authenticated user is returned.
    const accountUnavailable = error && error.message !== "Unauthorized";
    return (
      <div className={styles.guest}>
        {accountUnavailable && (
          <span className={styles.error} role="status">
            Account unavailable
          </span>
        )}
        <a className={styles.signIn} href={LOGIN_URL}>
          Sign in
        </a>
        <a className={styles.createAccount} href={SIGNUP_URL}>
          Create account
        </a>
      </div>
    );
  }

  const email = typeof user.email === "string" ? user.email : null;
  const name =
    (typeof user.name === "string" && user.name.trim()) ||
    (typeof user.nickname === "string" && user.nickname.trim()) ||
    email?.split("@")[0] ||
    "Your account";
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toUpperCase();

  return (
    <div
      className={styles.account}
      ref={containerRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        className={styles.accountButton}
        type="button"
        aria-label={`Account for ${name}`}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={styles.avatar} aria-hidden="true">
          {initials}
        </span>
        <span className={styles.accountName}>{name}</span>
        <span className={open ? styles.chevronOpen : styles.chevron}>
          <Icon name="chevron" size={12} />
        </span>
      </button>
      {open && (
        <div
          id={menuId}
          className={styles.menu}
          role="menu"
          aria-label="Your account"
        >
          <div className={styles.identity} role="presentation">
            <strong>{name}</strong>
            {email && <span>{email}</span>}
          </div>
          <p className={styles.storageNote} role="presentation">
            Workspaces are saved on this device.
          </p>
          <a
            ref={signOutRef}
            className={styles.signOut}
            href="/auth/logout"
            role="menuitem"
          >
            <Icon name="exit" size={14} />
            Sign out
          </a>
        </div>
      )}
    </div>
  );
}
