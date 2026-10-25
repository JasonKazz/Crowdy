"""Full-population scaling contracts; native throughput benchmarks run separately."""

import copy
import json
import os
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from shapely import points
from shapely.strtree import STRtree

from app import api
from app.schemas.layout import Layout
from app.schemas.rooms import PopulationConfig
from app.schemas.scenario import Population
from app.simulation.editor_adapter import editor_to_scenario
from app.simulation.engine import run_simulation
from app.simulation.jobs import SimulationJobs
from app.simulation.response import bound_simulation_result
from app.simulation.workspace_layout import editor_native_layout, native_to_editor
from app.services.floorplans.layout import compile_layout
from test_exterior_exits import room
from test_workspace_api import room_request

DEMO = Path(__file__).resolve().parents[2] / "frontend/src/lib/demos/pofa-verified.json"


class LargeCrowdTests(unittest.TestCase):
    def test_actual_pofa_places_all_5000_without_overlapping_or_extrapolating(self):
        plan = json.loads(DEMO.read_text())["plan"]
        settings = {"occupancy": 5000, "mobility": "standard", "distribution": "normal", "seed": 42}
        scenario = editor_to_scenario(plan, settings)
        self.assertEqual(len(scenario.occupants), 5000)
        self.assertEqual(len({person.id for person in scenario.occupants}), 5000)
        coordinates = points([person.position for person in scenario.occupants])
        near = STRtree(coordinates).query(coordinates, predicate="dwithin", distance=.46-1e-8)
        self.assertTrue(all(first == second for first, second in zip(*near)), "Only each person's own center may be closer than one body width.")

    def test_capacity_is_preserved_as_warning_metadata_and_input_limit_is_10000(self):
        layout = room()
        layout.capacity = 5
        plan = native_to_editor(layout.model_dump(mode="json"))
        self.assertEqual(plan["capacity"], 5)
        self.assertEqual(editor_native_layout(plan)[0].capacity, 5)
        payload = api.SimulationRequest(plan=plan, scenario={"occupancy": 6, "mobility": "standard", "distribution": "uniform"})
        result = api.run_editor_simulation(payload)
        self.assertTrue(result["editor_metadata"]["over_capacity"])
        self.assertEqual(result["summary"]["evacuated_count"], 6)
        self.assertEqual(Population(count=10000, spawn_area_ids=["floor"]).count, 10000)
        self.assertEqual(PopulationConfig(room_counts={"hall": 10000}).room_counts["hall"], 10000)
        with self.assertRaises(ValueError):
            api.EditorSettings(occupancy=10001, mobility="standard", distribution="normal")

    def test_wall_budget_retains_actual_incomplete_native_outcome(self):
        result = run_simulation(compile_layout(room()), runtime_deadline=time.monotonic()-1)
        self.assertEqual(result["status"], "timed_out")
        self.assertEqual(result["summary"]["remaining_count"], 1)
        self.assertEqual(result["summary"]["evacuated_count"], 0)
        self.assertIsNone(result["summary"]["clearance_time"])
        self.assertEqual(result["execution"]["stop_reason"], "wall_time_limit")
        self.assertEqual(len(result["frames"][-1]["agents"]), 1)

    def test_temporal_thinning_retains_all_people_and_first_and_final_frames(self):
        people = [{"id": str(i), "x": i/10, "y": 1} for i in range(300)]
        result = {"execution": {"population_count": 300}, "assignments": [{"agent_id": p["id"], "path": []} for p in people],
                  "frames": [{"time": i, "agents": copy.deepcopy(people)} for i in range(100)]}
        bounded = bound_simulation_result(result, limit=60_000)
        self.assertLess(len(json.dumps(bounded, separators=(",", ":")).encode()), 60_000)
        self.assertEqual([bounded["frames"][0]["time"], bounded["frames"][-1]["time"]], [0, 99])
        self.assertTrue(bounded["execution"]["playback_temporally_thinned"])
        self.assertTrue(all(frame["agents"] == people for frame in bounded["frames"]))


class AsyncSimulationTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(api.app)
        self.addCleanup(self.client.close)
        self.environment = patch.dict(os.environ, {"CROWDY_BACKEND_TOKEN": ""})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def wait_for_job(self, identifier):
        deadline = time.monotonic()+3
        while time.monotonic() < deadline:
            reply = self.client.get("/api/simulations", params={"job_id": identifier})
            if reply.json()["status"] != "running":
                return reply.json()
            time.sleep(.005)
        self.fail("The bounded fixture worker did not finish")

    def test_async_job_progress_completion_and_single_native_admission(self):
        release, started = threading.Event(), threading.Event()
        def work(payload, cancelled, progress):
            progress({"phase": "simulating", "population_count": payload.scenario.occupancy, "simulation_time": 2})
            started.set()
            release.wait(2)
            return {"fixture": "completed native worker"}
        payload = {**room_request(), "async_run": True}
        with patch("app.api.run_editor_simulation", side_effect=work):
            reply = self.client.post("/api/simulations", json=payload)
            identifier = reply.json()["job_id"]
            try:
                self.assertEqual(reply.status_code, 202)
                self.assertTrue(started.wait(1))
                state = self.client.get("/api/simulations", params={"job_id": identifier}).json()
                self.assertEqual(state["progress"]["phase"], "simulating")
                self.assertEqual(self.client.post("/api/simulations", json=payload).status_code, 429)
            finally:
                release.set()
            self.assertEqual(self.wait_for_job(identifier)["status"], "complete")

    def test_delete_cancels_real_worker_admission_and_releases_native_lock(self):
        started = threading.Event()
        def work(_payload, cancelled, _progress):
            started.set()
            if not cancelled.wait(2):
                raise AssertionError("Cancellation was not delivered")
            raise ValueError("Simulation cancelled.")
        with patch("app.api.run_editor_simulation", side_effect=work):
            reply = self.client.post("/api/simulations", json={**room_request(), "async_run": True})
            identifier = reply.json()["job_id"]
            self.assertTrue(started.wait(1))
            self.assertEqual(self.client.delete("/api/simulations", params={"job_id": identifier}).status_code, 204)
            self.assertEqual(self.wait_for_job(identifier)["status"], "failed")
        self.assertEqual(self.client.get("/health").json()["status"], "ready")

    def test_starting_progress_has_requested_population_before_worker_callback(self):
        release = threading.Event()
        def work(_payload, _cancelled, _progress):
            release.wait(2)
            return {"fixture": "completed native worker"}
        payload = {**room_request(), "async_run": True}
        with patch("app.api.run_editor_simulation", side_effect=work):
            reply = self.client.post("/api/simulations", json=payload)
            identifier = reply.json()["job_id"]
            try:
                state = self.client.get("/api/simulations", params={"job_id": identifier}).json()
                self.assertEqual(state["status"], "running")
                self.assertEqual(state["progress"]["phase"], "starting")
                self.assertEqual(state["progress"]["population_count"], payload["scenario"]["occupancy"])
                self.assertEqual(state["progress"]["simulation_time"], 0)
                self.assertEqual(state["progress"]["evacuated_count"], 0)
                self.assertGreaterEqual(state["progress"]["elapsed_seconds"], 0)
            finally:
                release.set()
            self.assertEqual(self.wait_for_job(identifier)["status"], "complete")

    def test_job_polling_and_cancellation_require_backend_auth(self):
        with patch.dict(os.environ, {"CROWDY_BACKEND_TOKEN": "fixture-private"}):
            for method in (self.client.get, self.client.delete):
                self.assertEqual(method("/api/simulations", params={"job_id": "a"*32}).status_code, 401)

    def test_completed_jobs_expire_and_retained_results_are_bounded(self):
        jobs = SimulationJobs(ttl=10, retained=2)
        identifiers = []
        with patch("app.simulation.jobs.time.monotonic", return_value=0) as clock:
            for _ in range(3):
                clock.return_value = len(identifiers)/10
                done = threading.Event()
                identifiers.append(jobs.submit(lambda _cancelled, _progress: {"ok": True}, done.set, population_count=1))
                self.assertTrue(done.wait(1))
            self.assertIsNone(jobs.snapshot(identifiers[0]))
            self.assertEqual(jobs.snapshot(identifiers[-1])["status"], "complete")
        with patch("app.simulation.jobs.time.monotonic", return_value=11):
            self.assertIsNone(jobs.snapshot(identifiers[-1]))


if __name__ == "__main__":
    unittest.main()
