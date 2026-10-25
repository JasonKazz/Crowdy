"""A shared monotonic work budget for placement, routing and native runs."""

from contextlib import contextmanager
from contextvars import ContextVar
import time

_deadline = ContextVar("simulation_deadline", default=None)
_cancelled = ContextVar("simulation_cancelled", default=None)


class SimulationDeadlineExceeded(ValueError):
    pass


def check_simulation_budget():
    cancelled = _cancelled.get()
    if cancelled is not None and cancelled.is_set():
        raise ValueError("Simulation cancelled.")
    deadline = _deadline.get()
    if deadline is not None and time.monotonic() >= deadline:
        raise SimulationDeadlineExceeded("Population placement or routing reached its processing time limit. Reduce the crowd or simplify the layout.")


@contextmanager
def simulation_budget(deadline, cancelled=None):
    previous = _deadline.get()
    token = _deadline.set(min(previous, deadline) if previous is not None else deadline)
    cancellation_token = _cancelled.set(cancelled)
    try:
        check_simulation_budget()
        yield
    finally:
        _deadline.reset(token)
        _cancelled.reset(cancellation_token)
