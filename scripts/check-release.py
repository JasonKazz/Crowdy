#!/usr/bin/env python3
"""Keep public release versions aligned without changing engine/schema versions."""
import ast
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
version = (root / "VERSION").read_text().strip()
assert re.fullmatch(r"\d+\.\d+\.\d+", version), "VERSION must be semantic"
for relative in ("backend/pyproject.toml", "services/crowd-estimation/pyproject.toml"):
    match = re.search(r'^version = "([^"]+)"$', (root / relative).read_text(), re.M)
    assert match and match[1] == version, f"Version mismatch: {relative}"
for relative in ("frontend/package.json", "frontend/package-lock.json"):
    data = json.loads((root / relative).read_text())
    assert data["version"] == version, f"Version mismatch: {relative}"
    if "packages" in data:
        assert data["packages"][""]["version"] == version
tree = ast.parse((root / "backend/app/limits.py").read_text())
runtime = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
               and any(isinstance(t, ast.Name) and t.id == "APPLICATION_VERSION" for t in n.targets))
assert runtime == version, "Backend runtime version mismatch"
service = (root / "services/crowd-estimation/app/main.py").read_text()
assert f'version="{version}"' in service or f'version = "{version}"' in service, "Detector runtime version mismatch"
print(f"Crowdy {version}: manifests and runtime versions agree.")
