"use client";

import { useEffect, useId, useRef, useState } from "react";
import Icon from "./icon";
import { useLiveCrowd } from "./live-crowd-provider";
import styles from "./live-crowd-feed.module.css";

export default function LiveCrowdFeed({ busy, blockedReason, onUseCrowdEstimate, purpose = "occupancy" }: {
  busy: boolean;
  blockedReason: string;
  onUseCrowdEstimate?: (count: number) => void;
  purpose?: "occupancy" | "analytics";
}) {
  const {
    session, snapshot, count, sampleCount, creating, ending, error, terminal, canReconnect, qr,
    cameraUrl, phoneReachable, copied, copyError, fresh, stale, live, age, connect, end, copyCameraLink,
  } = useLiveCrowd();
  const [automatic, setAutomatic] = useState(true);
  const lastApplied = useRef<{ sessionId: string; count: number } | null>(null);
  const callback = useRef(onUseCrowdEstimate);
  const id = useId();
  const analytics = purpose === "analytics";

  useEffect(() => { callback.current = onUseCrowdEstimate; }, [onUseCrowdEstimate]);
  useEffect(() => {
    if (analytics || !automatic || !fresh || busy || blockedReason || count === null || !session ||
      lastApplied.current?.sessionId === session.session_id && lastApplied.current.count === count) return;
    lastApplied.current = { sessionId: session.session_id, count };
    callback.current?.(count);
  }, [analytics, automatic, fresh, busy, blockedReason, count, session]);

  const stateLabel = terminal ? "Connection ended" : error ? "Reconnecting" : snapshot?.status === "paused" ? "Camera paused" : stale ? "Feed interrupted" : live ? "Live camera" : "Connect your iPhone";
  const statusText = analytics
    ? terminal ? "The camera is disconnected. Connect again to resume live evacuation estimates."
      : blockedReason || (snapshot?.status === "paused" || stale ? "Waiting for a fresh camera frame to update the evacuation estimate."
        : "This camera feeds the live evacuation estimate. Frames are sampled about every 2 seconds, as inference allows.")
    : terminal ? "Create a new connection to resume. Your last starting crowd is kept."
      : blockedReason || (busy ? "Updates pause while the workspace is busy." : stale || snapshot?.status === "paused" ? "Waiting for a fresh frame. Your starting crowd is unchanged."
        : fresh && automatic ? "Live estimates are updating your starting crowd." : "Frames are sampled about every 2 seconds, as inference allows.");

  return (
    <div className={styles.root}>
      {!session ? <button type="button" className={styles.connect} disabled={busy || creating || ending} onClick={() => void connect()}>
        <span className={styles.cameraIcon}><Icon name="video" size={18} /></span>
        <span><strong>{creating ? "Preparing connection…" : "Connect live camera"}</strong><small>{analytics ? "Use your iPhone for live evacuation estimates" : "Use your iPhone to count the crowd"}</small></span>
        <Icon name="arrow" size={16} />
      </button> : <section className={styles.card} aria-labelledby={`${id}-title`}>
        <div className={styles.topline}><h4 id={`${id}-title`}><span className={`${styles.dot} ${live ? styles.liveDot : ""}`} />{stateLabel}</h4><button type="button" className={styles.end} disabled={ending || creating} onClick={() => void end()}>{ending ? "Ending…" : "End feed"}</button></div>
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
        {snapshot?.estimate?.count === 0 || count === 0 ? <p className={styles.message}>{analytics ? "No people detected in the latest frame. Waiting for a crowd estimate before simulating." : "No people detected in the latest frame. Starting crowd is unchanged."}</p>
          : snapshot?.estimate && snapshot.estimate.count > 200 || count !== null && count > 200 ? <p className={styles.message}>{analytics ? "Above the 200-person simulation limit. Waiting for an estimate within range." : "Above the 200-person simulation limit. Starting crowd is unchanged."}</p> : null}
        {!analytics ? <label className={styles.auto}><input type="checkbox" checked={automatic} onChange={event => { lastApplied.current = null; setAutomatic(event.target.checked); }} />Automatically update starting crowd</label> : null}
        <p className={styles.note} role="status">{statusText}</p>
        {terminal && canReconnect ? <button type="button" className={styles.reconnect} disabled={busy || creating || ending} onClick={() => void connect()}>{creating ? "Preparing connection…" : "Create a new connection"}</button> : null}
        <div className={styles.links}><button type="button" disabled={terminal} onClick={() => void copyCameraLink()}>{copied ? "Link copied" : "Copy camera link"}</button><a href={terminal ? undefined : cameraUrl} target="_blank" rel="noopener noreferrer">Open camera<Icon name="external" size={11} /></a></div>
        <p className={styles.privacy}>No audio or recording is saved. Only the latest frame and count are held for this connection.</p>
      </section>}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {copyError ? <p className={styles.message} role="status">{copyError}</p> : null}
    </div>
  );
}
