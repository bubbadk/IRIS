#!/usr/bin/env python3
"""Boot IRIS twice in a disposable profile with records from the QC-2 browser journey.

Usage: python scripts/verify-project-quality-native.py /path/to/iris /path/to/records.json
No provider configuration is imported. The records must come from the isolated,
controlled-worker browser smoke; this is storage/startup verification, not model QA.
"""

import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time

binary = str(Path(sys.argv[1]).resolve())
records = json.loads(Path(sys.argv[2]).read_text())
assert set(records) == {
    "iris.projects.graphs.v1",
    "iris.projects.task-runs.v1",
    "iris.documents.records.v1",
}
runs = json.loads(records["iris.projects.task-runs.v1"])
assert any(run.get("verification", {}).get("checkReport") for run in runs)
assert any(run.get("qualityRejections") for run in runs)
assert any(
    review.get("resolutions")
    for run in runs
    for review in run.get("qualityReviews", [])
)
root = Path(tempfile.mkdtemp(prefix="iris-qc2-native-"))
env = os.environ.copy()
for key, name in [
    ("XDG_DATA_HOME", "data"),
    ("XDG_CONFIG_HOME", "config"),
    ("XDG_CACHE_HOME", "cache"),
]:
    folder = root / name
    folder.mkdir()
    env[key] = str(folder)

results = []
for iteration in range(2):
    log_path = root / f"boot-{iteration + 1}.log"
    with log_path.open("w") as log:
        process = subprocess.Popen(
            [binary],
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 20
            database = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"IRIS exited early: {process.returncode}")
                paths = list(root.rglob("repositories.sqlite3"))
                if paths:
                    with sqlite3.connect(paths[0]) as connection:
                        try:
                            migrated = connection.execute(
                                "select count(*) from migrations where name='localstorage-v1'"
                            ).fetchone()[0]
                            integrity = connection.execute(
                                "pragma integrity_check"
                            ).fetchone()[0]
                            if migrated == 1 and integrity == "ok":
                                database = paths[0]
                                break
                        except sqlite3.OperationalError:
                            pass
                time.sleep(0.25)
            assert database, "The native UI did not initialize SQLite through IPC"
            time.sleep(2)
            assert process.poll() is None, "IRIS stopped after initialization"
            assert list(
                root.rglob("schedule-owner.lock")
            ), "The schedule owner did not initialize"
            if iteration == 1:
                with sqlite3.connect(database) as connection:
                    for key, expected in records.items():
                        actual = connection.execute(
                            "select value from documents where key=?", (key,)
                        ).fetchone()
                        assert (
                            actual and actual[0] == expected
                        ), f"Restart changed {key}"
            results.append({"boot": iteration + 1, "alive": True, "ipcDatabase": True})
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
    log_text = log_path.read_text()
    assert "panicked at" not in log_text and "PluginInitialization" not in log_text
    if iteration == 0:
        with sqlite3.connect(database) as connection:
            for key, value in records.items():
                connection.execute(
                    "insert into documents(key,value,revision) values(?,?,1) "
                    "on conflict(key) do update set value=excluded.value, revision=revision+1",
                    (key, value),
                )

print(
    json.dumps(
        {
            "directory": str(root),
            "boots": results,
            "actualBrowserJourneyRecordsRetained": True,
            "qualityReviewsAndRejectionsRetained": True,
            "scope": "Native startup and SQLite retention; controlled worker, no model verification",
        }
    )
)
