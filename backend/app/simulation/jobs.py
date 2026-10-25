"""Bounded, process-local full-agent jobs; no queue or abandoned native work."""

import secrets
import threading
import time


class SimulationJobs:
    def __init__(self, ttl=600, retained=3):
        self.ttl, self.retained = ttl, retained
        self.lock = threading.Lock()
        self.jobs = {}

    def _prune(self, reserve=0):
        now = time.monotonic()
        for identifier, job in list(self.jobs.items()):
            if job["status"] != "running" and now - job.get("finished", job["started"]) > self.ttl:
                del self.jobs[identifier]
        completed = sorted((job.get("finished", job["started"]), identifier) for identifier, job in self.jobs.items() if job["status"] != "running")
        for _, identifier in completed[:max(0, len(self.jobs) - self.retained + reserve)]:
            del self.jobs[identifier]

    def submit(self, worker, on_finished, *, population_count):
        identifier = secrets.token_hex(16)
        job = {"status": "running", "started": time.monotonic(), "cancelled": threading.Event(),
               "progress": {"phase": "starting", "population_count": population_count,
                            "simulation_time": 0, "evacuated_count": 0}}
        with self.lock:
            self._prune(reserve=1)
            self.jobs[identifier] = job

        def progress(value):
            with self.lock:
                job["progress"].update(value)

        def run():
            try:
                result = worker(job["cancelled"], progress)
                with self.lock:
                    if job["cancelled"].is_set():
                        job.update(status="failed", error="Simulation cancelled.")
                    else:
                        job.update(status="complete", result=result)
            except (ValueError, RuntimeError) as error:
                with self.lock:
                    job.update(status="failed", error=str(error)[:600])
            except Exception:
                with self.lock:
                    job.update(status="failed", error="The native simulation could not finish. Retry or reduce the crowd.")
            finally:
                with self.lock:
                    job["finished"] = time.monotonic()
                on_finished()

        threading.Thread(target=run, daemon=True, name=f"simulation-{identifier[:8]}").start()
        return identifier

    def snapshot(self, identifier):
        with self.lock:
            self._prune()
            job = self.jobs.get(identifier)
            if job is None:
                return None
            result = {"job_id": identifier, "status": job["status"]}
            if job["status"] == "running":
                result["progress"] = {**job["progress"], "elapsed_seconds": round(time.monotonic() - job["started"], 2)}
            elif job["status"] == "complete":
                result["result"] = job["result"]
            else:
                result["error"] = job["error"]
            return result

    def cancel(self, identifier):
        with self.lock:
            job = self.jobs.get(identifier)
            if job is None:
                return False
            if job["status"] == "running":
                job["cancelled"].set()
                job["progress"]["phase"] = "cancelling"
            else:
                del self.jobs[identifier]
            return True
