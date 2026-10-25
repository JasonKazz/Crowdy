"""Bounded, ephemeral live-camera state for one service process."""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock
from time import monotonic
from typing import Literal

from pydantic import BaseModel

from app.estimator import Estimate

SESSION_TTL_SECONDS = 30 * 60
MAX_LIVE_SESSIONS = 16


class LiveSessionMissing(Exception):
    pass


class LiveSessionUnauthorized(Exception):
    pass


class LiveSessionLimit(Exception):
    pass


class CreatedLiveSession(BaseModel):
    session_id: str
    viewer_token: str
    camera_token: str
    expires_at: datetime


class LiveSnapshot(BaseModel):
    session_id: str
    expires_at: datetime
    sequence: int
    updated_at: datetime | None
    estimate: Estimate | None
    preview: str | None
    status: Literal["waiting", "live", "paused"]


@dataclass
class _Session:
    session_id: str
    viewer_digest: bytes
    camera_digest: bytes
    expires_at: datetime
    deadline: float
    generation: int = 0
    sequence: int = 0
    updated_at: datetime | None = None
    estimate: Estimate | None = None
    preview: str | None = None
    status: Literal["waiting", "live", "paused"] = "waiting"


@dataclass(frozen=True)
class FrameTicket:
    """An authorization checked before reading a frame, invalidated by pause."""

    session: _Session
    generation: int
    admitted_at: datetime


def _digest(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


class LiveSessions:
    def __init__(self, *, clock=monotonic, wall_clock=lambda: datetime.now(UTC)):
        self._clock = clock
        self._wall_clock = wall_clock
        self._sessions: dict[str, _Session] = {}
        self._lock = Lock()

    def _evict_expired(self):
        now = self._clock()
        for session_id in [key for key, value in self._sessions.items() if value.deadline <= now]:
            del self._sessions[session_id]

    def _authorize(self, session_id: str, token: str, *, camera: bool = False) -> _Session:
        self._evict_expired()
        session = self._sessions.get(session_id)
        if session is None:
            raise LiveSessionMissing()
        expected = session.camera_digest if camera else session.viewer_digest
        if not secrets.compare_digest(_digest(token), expected):
            raise LiveSessionUnauthorized()
        return session

    @staticmethod
    def _snapshot(session: _Session) -> LiveSnapshot:
        return LiveSnapshot(
            session_id=session.session_id, expires_at=session.expires_at,
            sequence=session.sequence, updated_at=session.updated_at,
            estimate=session.estimate, preview=session.preview, status=session.status,
        )

    def create(self) -> CreatedLiveSession:
        with self._lock:
            self._evict_expired()
            if len(self._sessions) >= MAX_LIVE_SESSIONS:
                raise LiveSessionLimit()
            session_id = secrets.token_hex(16)
            # Collision avoidance is inexpensive and protects existing state even
            # if the randomness source is replaced in a deterministic test.
            while session_id in self._sessions:
                session_id = secrets.token_hex(16)
            viewer_token = secrets.token_urlsafe(32)
            camera_token = secrets.token_urlsafe(32)
            expires_at = self._wall_clock() + timedelta(seconds=SESSION_TTL_SECONDS)
            self._sessions[session_id] = _Session(
                session_id=session_id, viewer_digest=_digest(viewer_token),
                camera_digest=_digest(camera_token), expires_at=expires_at,
                deadline=self._clock() + SESSION_TTL_SECONDS,
            )
            return CreatedLiveSession(
                session_id=session_id, viewer_token=viewer_token,
                camera_token=camera_token, expires_at=expires_at,
            )

    def snapshot(self, session_id: str, token: str) -> LiveSnapshot:
        with self._lock:
            return self._snapshot(self._authorize(session_id, token))

    def delete(self, session_id: str, token: str):
        with self._lock:
            self._authorize(session_id, token)
            del self._sessions[session_id]

    def pause(self, session_id: str, token: str) -> LiveSnapshot:
        with self._lock:
            session = self._authorize(session_id, token, camera=True)
            session.generation += 1
            session.sequence += 1
            session.status = "paused"
            return self._snapshot(session)

    def begin_frame(self, session_id: str, token: str) -> FrameTicket:
        with self._lock:
            session = self._authorize(session_id, token, camera=True)
            return FrameTicket(session=session, generation=session.generation, admitted_at=self._wall_clock())

    def finish_frame(self, ticket: FrameTicket, estimate: Estimate, preview: str) -> LiveSnapshot:
        with self._lock:
            self._evict_expired()
            session = self._sessions.get(ticket.session.session_id)
            if session is not ticket.session:
                raise LiveSessionMissing()
            # A pause may arrive while decoding/inference is running. Its
            # generation invalidates that frame; only a newly admitted frame
            # may resume the session. Deleted/expired sessions cannot reappear.
            if session.generation == ticket.generation:
                session.sequence += 1
                # Upload and inference time consume the viewer's freshness
                # window; finishing a slow estimate must not refresh its age.
                session.updated_at = ticket.admitted_at
                session.estimate = estimate
                session.preview = preview
                session.status = "live"
            return self._snapshot(session)

    def clear(self):
        with self._lock:
            self._sessions.clear()
