"""Process-local bounded import jobs, independent of browser request lifetimes.

A restart discards jobs (polling returns 404), but saved images/observations stay
on disk. This deliberately shares the API's single-process provider slots.
"""
import threading
import time
import uuid

MAX_JOBS = 32
JOB_TTL = 3600
_guard = threading.Lock()
_jobs = {}


def create_job():
    now = time.monotonic()
    with _guard:
        for identifier, job in list(_jobs.items()):
            if job["status"] != "running" and now - job["updated"] > JOB_TTL:
                del _jobs[identifier]
        # Drop oldest completed results first. Never forget an active worker.
        if len(_jobs) >= MAX_JOBS:
            completed = [key for key, job in _jobs.items() if job["status"] != "running"]
            if completed:
                del _jobs[min(completed, key=lambda key: _jobs[key]["updated"])]
            else:
                raise ValueError("All import workers are busy. Try again after an import finishes.")
        identifier = uuid.uuid4().hex
        _jobs[identifier] = {"status": "running", "progress": "Preparing image", "started": now, "updated": now}
    return identifier


def update_job(identifier, **changes):
    with _guard:
        _jobs[identifier].update(changes, updated=time.monotonic())


def job_status(identifier):
    with _guard:
        job = _jobs.get(identifier)
        if job is None:
            return None
        return {"job_id": identifier, "status": job["status"], "progress": job["progress"],
                "elapsed_seconds": int(time.monotonic()-job["started"]),
                **{key: job[key] for key in ("result", "error") if key in job}}
