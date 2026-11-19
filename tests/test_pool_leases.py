"""A request owns its worker across idle protocol gaps, until its response is ready."""

import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from tavotto.engine import pool


class _Worker:
    """Control-plane-independent fake; real protocol coverage is below."""

    def __init__(self, script_name, figures_dir, entry):
        self.script_name = script_name
        self.entry = entry
        self.python = sys.executable
        self.last_used = time.time()
        self.closed = threading.Event()

    def alive(self):
        return not self.closed.is_set()

    def shutdown(self):
        self.closed.set()


@pytest.fixture
def isolated_pool(monkeypatch, tmp_path):
    pool.shutdown_all(wait=True)
    assert not pool._worker_users
    monkeypatch.setattr(pool, "ENGINE_CACHE", tmp_path / "cache")
    monkeypatch.setattr(pool, "ENVIRONMENT_DECIDERS", [])
    monkeypatch.setattr(
        pool, "resolve_worker_python", lambda *a, **k: (sys.executable, pool.SOURCE_CURRENT)
    )
    monkeypatch.setattr(pool, "_schedule_prune", lambda: None)
    monkeypatch.setattr(pool, "MAX_ALIVE", 3)
    for name in ("active", "second", "third", "fourth"):
        (tmp_path / f"{name}.py").write_text(
            "import matplotlib.pyplot as plt\n"
            "def main():\n"
            "    fig, ax = plt.subplots(figsize=(2, 1.5))\n"
            "    ax.plot([0, 1], [0, 1])\n"
            "    fig.savefig('panel.pdf')\n",
            encoding="utf-8",
        )
    yield tmp_path
    pool.shutdown_all(wait=True)
    assert not pool._worker_users


@pytest.fixture
def fake_pool(isolated_pool, monkeypatch):
    monkeypatch.setattr(pool, "_new_worker", _Worker)
    return str(isolated_pool)


def test_idle_workers_still_obey_lru(fake_pool):
    first = pool.get("active.py", fake_pool, "main")
    for name in ("second", "third", "fourth"):
        pool.get(f"{name}.py", fake_pool, "main")
    assert first.closed.wait(5)
    assert pool.peek("active.py", fake_pool) is None
    assert len(pool._workers) == 3


def test_busy_pool_exceeds_budget_then_shrinks_as_each_owner_finishes(fake_pool):
    ready = threading.Barrier(7)
    release = [threading.Event() for _ in range(6)]

    def use(index):
        with pool.worker_scope():
            worker = pool.get(f"figure{index}.py", fake_pool, "main")
            ready.wait(timeout=10)
            assert release[index].wait(10)
            assert worker.alive()

    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = [executor.submit(use, i) for i in range(6)]
        try:
            ready.wait(timeout=10)
            assert len(pool._workers) == 6
            assert len(pool._worker_users) == 6
            for i, future in enumerate(futures):
                release[i].set()
                future.result(timeout=10)
                assert len(pool._workers) == max(3, 5 - i)
        finally:
            for signal in release:
                signal.set()
    assert not pool._worker_users


def test_two_threads_owning_same_worker_release_independently(fake_pool):
    ready = threading.Barrier(3)
    release = [threading.Event(), threading.Event()]
    workers = []

    def use(index):
        with pool.worker_scope():
            worker = pool.get("active.py", fake_pool, "main")
            workers.append(worker)
            ready.wait(timeout=10)
            assert release[index].wait(10)
            assert worker.alive()

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(use, i) for i in range(2)]
        try:
            ready.wait(timeout=10)
            assert workers[0] is workers[1]
            worker = workers[0]
            assert pool._worker_users[id(worker)] == 2
            with pool.worker_scope():
                for name in ("second", "third", "fourth"):
                    pool.get(f"{name}.py", fake_pool, "main")
                assert len(pool._workers) == 4
                release[0].set()
                futures[0].result(timeout=10)
                assert pool._worker_users[id(worker)] == 1
                assert pool.peek("active.py", fake_pool) is worker
                release[1].set()
                futures[1].result(timeout=10)
                assert pool.peek("active.py", fake_pool) is None
                assert len(pool._workers) == 3
        finally:
            for signal in release:
                signal.set()


def test_nested_scopes_keep_new_and_repeated_workers_until_outer_exit(fake_pool):
    with pytest.raises(RuntimeError, match="outer failed"), pool.worker_scope():
        with pool.worker_scope():
            worker = pool.get("active.py", fake_pool, "main")
        with pytest.raises(ValueError, match="inner failed"), pool.worker_scope():
            assert pool.get("active.py", fake_pool, "main") is worker
            assert pool._worker_users[id(worker)] == 1
            raise ValueError("inner failed")
        for name in ("second", "third", "fourth"):
            pool.get(f"{name}.py", fake_pool, "main")
        assert pool.peek("active.py", fake_pool) is worker
        assert len(pool._workers) == 4
        raise RuntimeError("outer failed")
    assert not pool._worker_users
    assert getattr(pool._scope_local, "workers", None) is None
    assert len(pool._workers) == 3


def test_explicit_invalidation_still_wins_and_replacement_has_separate_ownership(fake_pool):
    with pool.worker_scope():
        original = pool.get("active.py", fake_pool, "main")
        pool.invalidate("active.py", fake_pool)
        assert original.closed.wait(5)
        replacement = pool.get("active.py", fake_pool, "main")
        assert replacement is not original
        assert pool._worker_users[id(original)] == 1
        assert pool._worker_users[id(replacement)] == 1
    assert not pool._worker_users
    assert replacement.alive()


@pytest.mark.parametrize("fail", [False, True])
def test_request_hooks_release_workers_on_success_and_error(fake_pool, monkeypatch, fail):
    from tavotto import app as mod

    endpoint = next(
        rule.endpoint for rule in mod.app.url_map.iter_rules() if rule.rule == "/api/version"
    )
    seen = []

    def use_worker():
        with pool.worker_scope():
            worker = pool.get("active.py", fake_pool, "main")
        assert pool._worker_users[id(worker)] == 1
        seen.append(worker)
        if fail:
            raise RuntimeError("request failed after acquisition")
        return {"ok": True}

    monkeypatch.setitem(mod.app.view_functions, endpoint, use_worker)
    monkeypatch.setitem(mod.app.config, "TESTING", True)
    with mod.app.test_client() as client:
        response = client.get("/api/version")
        assert response.status_code == (500 if fail else 200)
        assert len(seen) == 1
        assert not pool._worker_users
    assert getattr(pool._scope_local, "workers", None) is None


def test_bound_background_job_releases_workers_after_error(fake_pool):
    from tavotto import app as mod

    previous = getattr(mod._BOUND_CTX, "ctx", None)
    project = object()
    with pytest.raises(RuntimeError, match="background failed"), mod.bound_project(project):
        worker = pool.get("active.py", fake_pool, "main")
        assert pool._worker_users[id(worker)] == 1
        assert mod.current_ctx() is project
        raise RuntimeError("background failed")
    assert getattr(mod._BOUND_CTX, "ctx", None) is previous
    assert not pool._worker_users


def test_rejected_request_never_enters_worker_scope(fake_pool, monkeypatch):
    from tavotto import app as mod, security

    state = security.SessionState("test-nonce")
    state.port = 5194
    monkeypatch.setitem(mod.app.config, security.STATE_KEY, state)

    def unexpected_scope():
        pytest.fail("unauthenticated request acquired a worker scope")

    monkeypatch.setattr(pool, "worker_scope", unexpected_scope)
    with mod.app.test_client() as client:
        response = client.get("/api/panels", base_url="http://127.0.0.1:5194")
        assert response.status_code == 401
        assert response.json["code"] == "session_auth_required"
    assert not pool._worker_users


@pytest.mark.parametrize("gap", ["acquire_to_request", "build_to_override"])
def test_active_worker_survives_lru_in_protocol_gaps(isolated_pool, monkeypatch, gap):
    """Real Python worker, stopped at an exact gap; no timing/sleep assumption.

    Old LRU closes this worker with exit 0 even though its caller still owns it.
    The assertion measures the caller's complete override, not the protocol lock.
    """
    try:
        worker_python, source = pool.select_worker_python()
    except pool.WorkerError:
        pytest.skip("No Python with matplotlib is available for the real worker regression")
    monkeypatch.setattr(pool, "resolve_worker_python", lambda *a, **k: (worker_python, source))
    ready = threading.Event()
    resume = threading.Event()
    owned = []

    def pause():
        ready.set()
        assert resume.wait(30), "test did not release the protocol gap"

    def render():
        with pool.worker_scope():
            worker = pool.get("active.py", str(isolated_pool), "main")
            owned.append(worker)
            if gap == "acquire_to_request":
                pause()
            else:
                original = worker.ensure_built

                def build_then_pause():
                    result = original()
                    pause()
                    return result

                worker.ensure_built = build_then_pause
            return worker.override("panel", [])

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(render)
        try:
            assert ready.wait(30), "worker never reached the intended protocol gap"
            for name in ("second", "third", "fourth"):
                pool.get(f"{name}.py", str(isolated_pool), "main")
            worker = owned[0]
            if pool.peek("active.py", isolated_pool) is not worker:
                # Await the old implementation's shutdown so exit 0 is proven,
                # rather than hiding the race behind a generic missing-worker error.
                assert worker.proc.wait(timeout=15) == 0
            resume.set()
            response = future.result(timeout=30)
            assert response["ok"]
            assert response["manifest"]["elements"]
        finally:
            resume.set()
