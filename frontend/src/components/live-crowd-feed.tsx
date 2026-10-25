"use client";

import { useEffect, useId, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  createLiveCrowdSession, endLiveCrowdSession, getLiveCrowdSession, LiveCrowdError,
  type LiveCrowdSession, type LiveCrowdSnapshot,
} from "@/lib/live-crowd";
import { canApplyLiveCount, LIVE_STALE_AFTER_MS, smoothedCrowdCount } from "@/lib/live-camera";
import Icon from "./icon";
import styles from "./live-crowd-feed.module.css";

export default function LiveCrowdFeed({ busy, blockedReason, onUseCrowdEstimate }: {
  busy: boolean;
  blockedReason: string;
  onUseCrowdEstimate: (count: number) => void;
}) {
  const [session, setSession] = useState<LiveCrowdSession | null>(null);
  const [snapshot, setSnapshot] = useState<LiveCrowdSnapshot | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [sampleCount, setSampleCount] = useState(0);
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState("");
  const [terminal, setTerminal] = useState(false);
  const [qr, setQr] = useState("");
  const [cameraUrl, setCameraUrl] = useState("");
  const [phoneReachable, setPhoneReachable] = useState(true);
  const [copied, setCopied] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const [now, setNow] = useState(0);
  const active = useRef<LiveCrowdSession | null>(null);
  const mounted = useRef(false);
  const starting = useRef(false);
  const history = useRef<number[]>([]);
  const lastSequence = useRef(0);
  const lastFrameAt = useRef<string | null>(null);
  const lastApplied = useRef<number | null>(null);
  const callback = useRef(onUseCrowdEstimate);
  const id = useId();

  useEffect(() => { callback.current = onUseCrowdEstimate; }, [onUseCrowdEstimate]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const previous = active.current;
      if (previous) void endLiveCrowdSession(previous.session_id, previous.viewer_token, { keepalive: true }).catch(() => undefined);
      active.current = null;
    };
  }, []);

  useEffect(() => {
    if (!session || terminal) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    async function poll() {
      try {
        const next = await getLiveCrowdSession(session!.session_id, session!.viewer_token, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (next.sequence < lastSequence.current) {
          timer = setTimeout(poll, 2_000);
          return;
        }
        lastSequence.current = next.sequence;
        setSnapshot(next);
        setNow(Date.now());
        setError("");
        if (next.status === "live" && next.estimate && next.updated_at !== lastFrameAt.current) {
          const recent = lastFrameAt.current && Date.parse(next.updated_at!) - Date.parse(lastFrameAt.current) < LIVE_STALE_AFTER_MS ? history.current : [];
          history.current = [...recent, next.estimate.count].slice(-3);
          lastFrameAt.current = next.updated_at;
          setCount(smoothedCrowdCount(history.current));
          setSampleCount(history.current.length);
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Live feed is unavailable. Reconnecting…");
        if (cause instanceof LiveCrowdError && [401, 403, 404, 410].includes(cause.status)) {
          setTerminal(true);
          return;
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2_000);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); clearInterval(clock); };
  }, [session, terminal]);

  const fresh = !ending && !terminal && !error && snapshot?.status === "live" && snapshot.estimate !== null &&
    snapshot.estimate.count > 0 && snapshot.estimate.count <= 200 && canApplyLiveCount(count, snapshot.updated_at, now);
  const stale = !!snapshot?.updated_at && now - Date.parse(snapshot.updated_at) >= LIVE_STALE_AFTER_MS;
  useEffect(() => {
    if (!automatic || !fresh || busy || blockedReason || count === null || lastApplied.current === count) return;
    lastApplied.current = count;
    callback.current(count);
  }, [automatic, fresh, busy, blockedReason, count]);

  async function connect() {
    if (starting.current || busy) return;
    starting.current = true;
    setCreating(true);
    setError("");
    try {
      const next = await createLiveCrowdSession();
      if (!mounted.current) {
        void endLiveCrowdSession(next.session_id, next.viewer_token).catch(() => undefined);
        return;
      }
      active.current = next;
      history.current = [];
      lastSequence.current = 0;
      lastFrameAt.current = null;
      lastApplied.current = null;
      setSnapshot(null);
      setCount(null);
      setSampleCount(0);
      setTerminal(false);
      setAutomatic(true);
      setCopied(false);
      const url = new URL("/live-camera", window.location.origin);
      url.hash = new URLSearchParams({ session: next.session_id, token: next.camera_token }).toString();
      setCameraUrl(url.href);
      setPhoneReachable(url.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
      setSession(next);
      // Pairing credentials stay on this origin; QR generation is entirely local.
      try { setQr(await QRCode.toDataURL(url.href, { width: 208, margin: 2, color: { dark: "#293b26", light: "#ffffff" } })); }
      catch { setQr(""); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "The live camera connection could not be created.");
    } finally {
      starting.current = false;
      if (mounted.current) setCreating(false);
    }
  }

  async function end() {
    if (!session || ending) return;
    setEnding(true);
    try {
      await endLiveCrowdSession(session.session_id, session.viewer_token);
      active.current = null;
      setSession(null);
      setSnapshot(null);
      setCameraUrl("");
      setQr("");
      setError("");
    } catch (cause) {
      if (cause instanceof LiveCrowdError && [401, 404, 410].includes(cause.status)) {
        active.current = null;
        setSession(null);
        setError("");
      } else setError(cause instanceof Error ? cause.message : "Could not end this feed. Try again.");
    } finally { setEnding(false); }
  }

  const live = !terminal && !error && snapshot?.status === "live" && !stale;
  const stateLabel = terminal ? "Connection ended" : error ? "Reconnecting" : snapshot?.status === "paused" ? "Camera paused" : stale ? "Feed interrupted" : live ? "Live camera" : "Connect your iPhone";
  const age = snapshot?.updated_at ? Math.max(0, Math.floor((now - Date.parse(snapshot.updated_at)) / 1_000)) : null;

  return (
    <div className={styles.root}>
      {!session ? <button type="button" className={styles.connect} disabled={busy || creating} onClick={() => void connect()}>
        <span className={styles.cameraIcon}><Icon name="video" size={18} /></span>
        <span><strong>{creating ? "Preparing connection…" : "Connect live camera"}</strong><small>Use your iPhone to count the crowd</small></span>
        <Icon name="arrow" size={16} />
      </button> : <section className={styles.card} aria-labelledby={`${id}-title`}>
        <div className={styles.topline}><h4 id={`${id}-title`}><span className={`${styles.dot} ${live ? styles.liveDot : ""}`} />{stateLabel}</h4><button type="button" className={styles.end} disabled={ending} onClick={() => void end()}>{ending ? "Ending…" : "End feed"}</button></div>
        {snapshot?.preview ? <div className={styles.preview}>
          {/* The latest frame is an ephemeral, bounded data URL from our estimator. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={snapshot.preview} alt="Latest frame from the connected venue camera" width={640} height={360} />
          <span className={styles.previewLabel}>{live ? "LIVE" : "LAST FRAME"}</span>
        </div> : null}
        {!snapshot?.estimate && !terminal ? <div className={styles.pairing}>
          {qr ? <div className={styles.qr}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} width={148} height={148} alt="Scan with your iPhone camera to connect this venue feed" />
          </div> : null}
          <p>Scan with your iPhone camera, open the link, then tap <strong>Start camera</strong>.</p>
          <p className={styles.note}>Keep Safari open and point the rear camera at your venue. This private link expires in 30 minutes.</p>
          {!phoneReachable ? <p className={styles.message}>For iPhone pairing, open this workspace at an HTTPS address your phone can reach. This computer’s local address works only on this computer.</p> : null}
        </div> : null}
        {count !== null ? <div className={styles.countRow}><p>{count}<span>people visible</span></p><div><Icon name="people" size={20} /><small>{age === null ? "" : age < 2 ? "Just updated" : `${age}s ago`}</small></div></div> : null}
        {snapshot?.estimate ? <p className={styles.note}>Median of the latest {sampleCount} frame{sampleCount === 1 ? "" : "s"}. Hidden or distant people may be missed.</p> : null}
        {snapshot?.estimate?.count === 0 || count === 0 ? <p className={styles.message}>No people detected in the latest frame. Starting crowd is unchanged.</p> : snapshot?.estimate && snapshot.estimate.count > 200 || count !== null && count > 200 ? <p className={styles.message}>Above the 200-person simulation limit. Starting crowd is unchanged.</p> : null}
        <label className={styles.auto}><input type="checkbox" checked={automatic} onChange={event => { lastApplied.current = null; setAutomatic(event.target.checked); }} />Automatically update starting crowd</label>
        <p className={styles.note} role="status">{terminal ? "Create a new connection to resume. Your last starting crowd is kept." : blockedReason || (busy ? "Updates pause while the workspace is busy." : stale || snapshot?.status === "paused" ? "Waiting for a fresh frame. Your starting crowd is unchanged." : fresh && automatic ? "Live estimates are updating your starting crowd." : "Frames are sampled about every 2 seconds, as inference allows.")}</p>
        <div className={styles.links}><button type="button" disabled={terminal} onClick={async () => {
          try { await navigator.clipboard.writeText(cameraUrl); setCopied(true); }
          catch { setError("Copy is unavailable. Use the camera link below."); }
        }}>{copied ? "Link copied" : "Copy camera link"}</button><a href={terminal ? undefined : cameraUrl} target="_blank" rel="noopener noreferrer">Open camera<Icon name="external" size={11} /></a></div>
        <p className={styles.privacy}>No audio or recording is saved. Only the latest frame and count are held for this connection.</p>
      </section>}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
  );
}
