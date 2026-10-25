"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  isLiveCrowdSessionId, isLiveCrowdToken, LiveCrowdError,
  pauseLiveCrowdSession, sendLiveCrowdFrame,
} from "@/lib/live-crowd";
import { cameraErrorMessage, captureLiveFrame, LIVE_FRAME_INTERVAL_MS } from "@/lib/live-camera";
import Icon from "./icon";
import styles from "./live-camera.module.css";

type Credentials = { session: string; token: string };

export default function LiveCamera() {
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<"idle" | "starting" | "live" | "paused" | "ended">("idle");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("Your camera connects to the workspace that created this link.");
  const [count, setCount] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [frames, setFrames] = useState(0);
  const [pausing, setPausing] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const starting = useRef(false);
  const cameraActive = useRef(false);
  const pendingPause = useRef<Promise<unknown> | null>(null);

  function releaseCamera() {
    generation.current++;
    cameraActive.current = false;
    if (timer.current) clearTimeout(timer.current);
    request.current?.abort();
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    void wakeLock.current?.release().catch(() => undefined);
    wakeLock.current = null;
  }

  useEffect(() => {
    let connection: Credentials | null = null;
    const readConnection = () => {
      const wasActive = cameraActive.current;
      const previous = connection;
      releaseCamera();
      if (wasActive && previous) pendingPause.current = pauseLiveCrowdSession(previous.session, previous.token, { keepalive: true }).catch(() => undefined);
      const params = new URLSearchParams(window.location.hash.slice(1));
      const session = params.get("session") ?? "";
      const token = params.get("token") ?? "";
      connection = isLiveCrowdSessionId(session) && isLiveCrowdToken(token) ? { session, token } : null;
      queueMicrotask(() => {
        setCredentials(connection);
        setReady(true);
        setPhase("idle");
        setCount(null);
        setFrames(0);
        setSending(false);
        setPausing(false);
        setError("");
        setMessage("Your camera connects to the workspace that created this link.");
      });
    };
    readConnection();
    const suspend = () => {
      if (!cameraActive.current && !stream.current && !starting.current) return;
      releaseCamera();
      setPhase("paused");
      setSending(false);
      setMessage("Camera paused. Keep this page visible and tap Resume camera to continue.");
      if (connection) pendingPause.current = pauseLiveCrowdSession(connection.session, connection.token, { keepalive: true }).catch(() => undefined);
    };
    const visibility = () => { if (document.visibilityState === "hidden") suspend(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("hashchange", readConnection);
    return () => {
      const wasActive = cameraActive.current;
      releaseCamera();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("hashchange", readConnection);
      if (wasActive && connection) {
        void pauseLiveCrowdSession(connection.session, connection.token, { keepalive: true }).catch(() => undefined);
      }
    };
  }, []);

  async function pause() {
    releaseCamera();
    setPhase("paused");
    setSending(false);
    setMessage("Camera paused. Your workspace keeps the last estimate.");
    const current = generation.current;
    setPausing(true);
    if (credentials) {
      try {
        const pending = pauseLiveCrowdSession(credentials.session, credentials.token);
        pendingPause.current = pending;
        await pending;
      } catch (cause) {
        if (generation.current === current) setError(cause instanceof Error ? cause.message : "Could not notify the workspace. Your camera is stopped.");
      } finally { if (generation.current === current) setPausing(false); }
    }
  }

  async function start() {
    if (!credentials || starting.current || cameraActive.current || pausing) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError("Open this camera link over HTTPS in Safari. An ordinary local-network HTTP address cannot access the iPhone camera.");
      return;
    }
    starting.current = true;
    const current = ++generation.current;
    setPhase("starting");
    setError("");
    try {
      // Finish a background pause before resuming, so it cannot invalidate a new frame.
      await pendingPause.current?.catch(() => undefined);
      pendingPause.current = null;
      if (generation.current !== current) return;
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 } },
      });
      if (generation.current !== current || document.visibilityState === "hidden") {
        media.getTracks().forEach(track => track.stop());
        if (generation.current === current) { setPhase("paused"); setMessage("Keep this page visible, then tap Resume camera."); }
        return;
      }
      stream.current = media;
      const element = video.current;
      if (!element) throw new Error("Camera preview is unavailable. Reload this page and reconnect.");
      element.srcObject = media;
      element.muted = true;
      await element.play();
      if (generation.current !== current) return;
      if (document.hidden) {
        releaseCamera();
        setPhase("paused");
        setMessage("Keep this page visible, then tap Resume camera.");
        return;
      }
      cameraActive.current = true;
      setPhase("live");
      setMessage("Keep this page open. Your workspace updates as new estimates arrive.");
      for (const track of media.getVideoTracks()) track.addEventListener("ended", () => {
        if (generation.current !== current) return;
        void pause();
      }, { once: true });
      if ("wakeLock" in navigator) {
        void navigator.wakeLock.request("screen").then(lock => {
          if (generation.current !== current) void lock.release();
          else wakeLock.current = lock;
        }).catch(() => undefined);
      }
      let failures = 0;
      async function sample() {
        if (generation.current !== current) return;
        const controller = new AbortController();
        request.current = controller;
        setSending(true);
        try {
          const frame = await captureLiveFrame(element!);
          if (generation.current !== current) return;
          const result = await sendLiveCrowdFrame(credentials!.session, credentials!.token, frame, { signal: controller.signal });
          if (generation.current !== current) return;
          failures = 0;
          setCount(result.estimate?.count ?? null);
          setFrames(value => value + 1);
          setError("");
          setMessage("Frame received. Your workspace is getting live crowd estimates.");
        } catch (cause) {
          if (generation.current !== current) return;
          failures++;
          if (cause instanceof LiveCrowdError && [401, 403, 404, 410].includes(cause.status)) {
            releaseCamera();
            setPhase("ended");
            setError("This connection has ended or expired. Create a new live feed in your workspace and scan its QR code.");
            setSending(false);
            return;
          }
          setError(cause instanceof Error ? cause.message : "Connection interrupted. Retrying…");
          setMessage("Reconnecting. Your workspace keeps its last crowd size until a fresh estimate arrives.");
        } finally {
          if (generation.current === current) setSending(false);
        }
        // One frame in flight. Slow inference reduces sampling instead of queuing video.
        if (generation.current === current) timer.current = setTimeout(sample, Math.min(10_000, LIVE_FRAME_INTERVAL_MS * Math.max(1, failures)));
      }
      void sample();
    } catch (cause) {
      if (generation.current !== current) return;
      releaseCamera();
      setPhase("idle");
      setError(cameraErrorMessage(cause));
    } finally { starting.current = false; }
  }

  const capturing = phase === "live";
  return (
    <main className={styles.page}>
      <header className={styles.header}><Link href="/" className={styles.wordmark}>crowdy<span> / live</span></Link><span className={styles.eyebrow}><span className={capturing ? styles.liveDot : styles.idleDot} />{capturing ? "CAMERA CONNECTED" : "VENUE CAMERA"}</span></header>
      <div className={styles.content}>
        <div className={styles.intro}><span className={styles.eyebrow}>YOUR PHONE. A LIVE HEADCOUNT.</span><h1>See the crowd.<br /><span>Plan with the present.</span></h1><p>Point your camera at the venue. Live estimates appear in your Crowdy workspace.</p></div>
        <div className={styles.viewfinder}>
          <video ref={video} autoPlay muted playsInline aria-label="Live venue camera preview" className={capturing ? styles.video : `${styles.video} ${styles.hiddenVideo}`} />
          {!capturing ? <div className={styles.placeholder}><Icon name="video" size={38} /><p>{phase === "paused" ? "Camera paused" : phase === "ended" ? "Connection ended" : "Ready when you are"}</p><span>Rear camera · no audio</span></div> : <>
            <div className={styles.viewfinderTop}><span><span className={styles.liveDot} />LIVE</span><span>{sending ? "ESTIMATING…" : "CONNECTED"}</span></div>
            <div className={styles.corners} aria-hidden="true" />
            <div className={styles.cameraCount}><strong>{count ?? "—"}</strong><span>people in this frame</span></div>
          </>}
        </div>
        {!ready ? <p className={styles.message} role="status">Opening camera connection…</p> : !credentials ? <p className={styles.error} role="alert">This camera link is incomplete. In your workspace, choose Connect live camera and scan the QR code with your iPhone.</p> : <>
          {capturing ? <button type="button" className={styles.pause} onClick={() => void pause()}><Icon name="pause" size={17} />Pause camera</button> : <button type="button" className={styles.start} disabled={pausing || phase === "starting" || phase === "ended"} onClick={() => void start()}><Icon name="video" size={19} />{pausing ? "Pausing…" : phase === "starting" ? "Opening camera…" : phase === "paused" ? "Resume camera" : phase === "ended" ? "Create a new connection" : "Start camera"}<Icon name="arrow" size={18} /></button>}
          <p className={styles.message} role="status">{message}</p>
        </>}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.facts}><div><Icon name="clock" size={16} /><span>About every 2 seconds<small>Adapts to connection speed</small></span></div><div><Icon name="people" size={16} /><span>{frames ? `${frames} frame${frames === 1 ? "" : "s"} estimated` : "Visible people only"}<small>Hidden people may be missed</small></span></div></div>
        <p className={styles.privacy}>Keep this page visible in Safari. No audio or recording is saved. Only the latest frame and estimate are held temporarily. The connection expires after 30 minutes.</p>
      </div>
      <footer className={styles.footer}>A clearer picture of the space you’re in.<span>CROWDY / CAL HACKS 13</span></footer>
    </main>
  );
}
