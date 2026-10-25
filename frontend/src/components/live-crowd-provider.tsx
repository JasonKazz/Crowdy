"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import {
  createLiveCrowdSession, endLiveCrowdSession, getLiveCrowdSession, LiveCrowdError,
  type LiveCrowdSession, type LiveCrowdSnapshot,
} from "@/lib/live-crowd";
import { canApplyLiveCount, LIVE_FRAME_INTERVAL_MS, LIVE_STALE_AFTER_MS, smoothedCrowdCount } from "@/lib/live-camera";
import type { LiveCrowdObservation } from "@/lib/live-evacuation";

type LiveCrowdContextValue = {
  observation: LiveCrowdObservation;
  session: LiveCrowdSession | null;
  snapshot: LiveCrowdSnapshot | null;
  count: number | null;
  sampleCount: number;
  creating: boolean;
  ending: boolean;
  error: string;
  terminal: boolean;
  canReconnect: boolean;
  qr: string;
  cameraUrl: string;
  phoneReachable: boolean;
  copied: boolean;
  copyError: string;
  now: number;
  fresh: boolean;
  stale: boolean;
  live: boolean;
  age: number | null;
  connect: () => Promise<void>;
  end: () => Promise<void>;
  copyCameraLink: () => Promise<void>;
};

const LiveCrowdContext = createContext<LiveCrowdContextValue | null>(null);

/** One private camera connection for every camera view in a workspace. */
export function LiveCrowdProvider({ children, scope = "" }: { children: ReactNode; scope?: string }) {
  const scopeToken = useMemo(() => ({ scope }), [scope]);
  const [connectionScope, setConnectionScope] = useState(scopeToken);
  const [session, setSession] = useState<LiveCrowdSession | null>(null);
  const [snapshot, setSnapshot] = useState<LiveCrowdSnapshot | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState("");
  const [terminal, setTerminal] = useState(false);
  const [ended, setEnded] = useState(false);
  const [qr, setQr] = useState("");
  const [cameraUrl, setCameraUrl] = useState("");
  const [phoneReachable, setPhoneReachable] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [now, setNow] = useState(0);
  const active = useRef<LiveCrowdSession | null>(null);
  const mounted = useRef(false);
  const starting = useRef(false);
  const closing = useRef(false);
  const generation = useRef(0);
  const pollController = useRef<AbortController | null>(null);
  const history = useRef<number[]>([]);
  const lastSequence = useRef(-1);
  const lastFrameAt = useRef<string | null>(null);
  const currentScope = useRef(scopeToken);
  const matchesScope = connectionScope === scopeToken;

  useEffect(() => {
    mounted.current = true;
    if (currentScope.current !== scopeToken) {
      currentScope.current = scopeToken;
      const currentGeneration = generation.current;
      queueMicrotask(() => {
        if (!mounted.current || generation.current !== currentGeneration) return;
        setSession(null);
        setSnapshot(null);
        setCount(null);
        setSampleCount(0);
        setCreating(false);
        setEnding(false);
        setError("");
        setTerminal(false);
        setEnded(false);
        setQr("");
        setCameraUrl("");
        setPhoneReachable(true);
        setCopied(false);
        setCopyError("");
        setNow(0);
        setConnectionScope(scopeToken);
      });
    }
    return () => {
      mounted.current = false;
      generation.current += 1;
      pollController.current?.abort();
      const previous = active.current;
      active.current = null;
      starting.current = false;
      closing.current = false;
      history.current = [];
      lastSequence.current = -1;
      lastFrameAt.current = null;
      if (previous) void endLiveCrowdSession(previous.session_id, previous.viewer_token, { keepalive: true }).catch(() => undefined);
    };
  }, [scopeToken]);

  useEffect(() => {
    if (!matchesScope || !session || terminal) return;
    const controller = new AbortController();
    pollController.current = controller;
    const currentGeneration = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    const isCurrent = () => !controller.signal.aborted && mounted.current &&
      generation.current === currentGeneration && active.current?.session_id === session.session_id;

    async function poll() {
      try {
        const next = await getLiveCrowdSession(session!.session_id, session!.viewer_token, { signal: controller.signal });
        if (!isCurrent()) return;
        // A delayed response must not replace a newer frame or rewind pause state.
        const regressedFrame = lastFrameAt.current !== null && (next.updated_at === null || Date.parse(next.updated_at) < Date.parse(lastFrameAt.current));
        if (next.sequence >= lastSequence.current && !regressedFrame) {
          const isNewSequence = next.sequence > lastSequence.current;
          lastSequence.current = next.sequence;
          setNow(Date.now());
          setError("");
          if (isNewSequence) setSnapshot(next);
          // Pausing increments sequence while retaining the previous frame. Only
          // a new live frame contributes another sample to the median.
          if (isNewSequence && next.status === "live" && next.estimate && next.updated_at &&
            (!lastFrameAt.current || Date.parse(next.updated_at) > Date.parse(lastFrameAt.current))) {
            const recent = lastFrameAt.current && Date.parse(next.updated_at) - Date.parse(lastFrameAt.current) < LIVE_STALE_AFTER_MS ? history.current : [];
            history.current = [...recent, next.estimate.count].slice(-3);
            lastFrameAt.current = next.updated_at;
            setCount(smoothedCrowdCount(history.current));
            setSampleCount(history.current.length);
          }
        }
      } catch (cause) {
        if (!isCurrent()) return;
        setError(cause instanceof Error ? cause.message : "Live feed is unavailable. Reconnecting…");
        if (cause instanceof LiveCrowdError && [401, 403, 404, 410].includes(cause.status)) {
          active.current = null;
          setTerminal(true);
          return;
        }
      }
      if (isCurrent()) timer = setTimeout(poll, LIVE_FRAME_INTERVAL_MS);
    }
    void poll();
    return () => {
      controller.abort();
      if (pollController.current === controller) pollController.current = null;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [matchesScope, scopeToken, session, terminal]);

  async function connect() {
    if (!mounted.current || !matchesScope || currentScope.current !== scopeToken || starting.current || closing.current || active.current) return;
    starting.current = true;
    const currentGeneration = ++generation.current;
    setCreating(true);
    setError("");
    setCopyError("");
    try {
      const next = await createLiveCrowdSession();
      if (!mounted.current || generation.current !== currentGeneration) {
        void endLiveCrowdSession(next.session_id, next.viewer_token, { keepalive: true }).catch(() => undefined);
        return;
      }
      active.current = next;
      history.current = [];
      lastSequence.current = -1;
      lastFrameAt.current = null;
      setSnapshot(null);
      setCount(null);
      setSampleCount(0);
      setTerminal(false);
      setEnded(false);
      setCopied(false);
      setQr("");
      setNow(Date.now());
      const url = new URL("/live-camera", window.location.origin);
      url.hash = new URLSearchParams({ session: next.session_id, token: next.camera_token }).toString();
      setCameraUrl(url.href);
      setPhoneReachable(url.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
      setSession(next);
      // Pairing credentials stay on this origin; QR generation is entirely local.
      try {
        const image = await QRCode.toDataURL(url.href, { width: 208, margin: 2, color: { dark: "#293b26", light: "#ffffff" } });
        if (mounted.current && generation.current === currentGeneration) setQr(image);
      } catch { /* The private camera link remains usable without a QR image. */ }
    } catch (cause) {
      if (mounted.current && generation.current === currentGeneration)
        setError(cause instanceof Error ? cause.message : "The live camera connection could not be created.");
    } finally {
      if (generation.current === currentGeneration) {
        starting.current = false;
        if (mounted.current) setCreating(false);
      }
    }
  }

  async function end() {
    if (!matchesScope || currentScope.current !== scopeToken || !session || closing.current || starting.current) return;
    closing.current = true;
    const currentGeneration = ++generation.current;
    // Invalidate the camera observation before waiting for DELETE. A response
    // already in flight cannot resume occupancy updates or launch analytics.
    pollController.current?.abort();
    setEnding(true);
    setTerminal(true);
    setEnded(true);
    setError("");
    setCopyError("");
    try {
      await endLiveCrowdSession(session.session_id, session.viewer_token);
      if (mounted.current && generation.current === currentGeneration) clearConnection();
    } catch (cause) {
      if (!mounted.current || generation.current !== currentGeneration) return;
      if (cause instanceof LiveCrowdError && [401, 403, 404, 410].includes(cause.status)) clearConnection();
      else setError(cause instanceof Error ? cause.message : "Could not end this feed. Try again.");
    } finally {
      if (generation.current === currentGeneration) {
        closing.current = false;
        if (mounted.current) setEnding(false);
      }
    }
  }

  function clearConnection() {
    active.current = null;
    setSession(null);
    setSnapshot(null);
    setCount(null);
    setSampleCount(0);
    setCameraUrl("");
    setQr("");
    setError("");
  }

  async function copyCameraLink() {
    if (!matchesScope || currentScope.current !== scopeToken || !cameraUrl || terminal) return;
    const currentGeneration = generation.current;
    try {
      await navigator.clipboard.writeText(cameraUrl);
      if (mounted.current && generation.current === currentGeneration) { setCopied(true); setCopyError(""); }
    } catch {
      if (mounted.current && generation.current === currentGeneration) setCopyError("Copy is unavailable. Use the camera link below.");
    }
  }

  const frameAge = matchesScope && snapshot?.updated_at ? now - Date.parse(snapshot.updated_at) : null;
  const stale = frameAge !== null && (!Number.isFinite(frameAge) || frameAge < -5_000 || frameAge >= LIVE_STALE_AFTER_MS);
  const live = matchesScope && !ending && !terminal && !error && snapshot?.status === "live" && !stale;
  const fresh = live && snapshot.estimate !== null && snapshot.estimate.count > 0 && snapshot.estimate.count <= 200 &&
    canApplyLiveCount(count, snapshot.updated_at, now);
  const age = frameAge === null ? null : Math.max(0, Math.floor(frameAge / 1_000));
  const status: LiveCrowdObservation["status"] = !matchesScope ? "disconnected" : terminal || ended ? "ended" : error ? "error" : !session ? "disconnected" :
    snapshot?.status === "paused" ? "paused" : stale ? "stale" : snapshot?.status ?? "waiting";
  const observation = useMemo<LiveCrowdObservation>(() => ({
    count: matchesScope ? count : null, rawCount: matchesScope ? snapshot?.estimate?.count ?? null : null,
    updatedAt: matchesScope ? snapshot?.updated_at ?? null : null,
    sessionId: matchesScope ? session?.session_id ?? null : null, status, sequence: matchesScope ? snapshot?.sequence ?? 0 : 0,
  }), [matchesScope, count, snapshot, session, status]);

  return <LiveCrowdContext.Provider value={{
    observation, session: matchesScope ? session : null, snapshot: matchesScope ? snapshot : null,
    count: matchesScope ? count : null, sampleCount: matchesScope ? sampleCount : 0,
    creating: matchesScope && creating, ending: matchesScope && ending, error: matchesScope ? error : "", terminal: matchesScope && terminal,
    canReconnect: !matchesScope || !session || terminal && !ended, qr: matchesScope ? qr : "", cameraUrl: matchesScope ? cameraUrl : "",
    phoneReachable: !matchesScope || phoneReachable, copied: matchesScope && copied, copyError: matchesScope ? copyError : "",
    now: matchesScope ? now : 0, fresh, stale, live, age, connect, end, copyCameraLink,
  }}>{children}</LiveCrowdContext.Provider>;
}

export function useLiveCrowd() {
  const context = useContext(LiveCrowdContext);
  if (!context) throw new Error("useLiveCrowd must be used within a LiveCrowdProvider.");
  return context;
}

export default LiveCrowdProvider;
