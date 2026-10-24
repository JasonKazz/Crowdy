import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class BackendBuildContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="crowdy-backend-context-test.")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "backend"
        self.destination = self.root / "context"
        (self.source / "app/nested").mkdir(parents=True)
        self.destination.mkdir()
        self.expected_files = {
            "Dockerfile", "pyproject.toml", "uv.lock", "app/__init__.py",
            "app/nested/server.py", "app/nested/editor.js", "app/nested/editor.html",
            "app/nested/style.css", "app/nested/readme.txt", "app/nested/icon.svg",
        }
        for name in self.expected_files:
            (self.source / name).write_text(f"Public source fixture: {name}\n")
        script = (Path(__file__).resolve().parents[1] / "scripts/deploy.sh").read_text()
        marker = 'python3 - "$repo_dir/backend" "$build_context" <<\'PY\'\n'
        self.assertEqual(script.count(marker), 1, "Test must execute the actual backend staging block.")
        self.staging_code = script.split(marker, 1)[1].split("\nPY\n", 1)[0]

    def stage(self):
        return subprocess.run(
            [sys.executable, "-", str(self.source), str(self.destination)],
            input=self.staging_code, capture_output=True, text=True, umask=0o077,
        )

    def test_actual_staging_block_normalizes_private_source_and_umask(self):
        for item in self.source.rglob("*"):
            item.chmod(0o700 if item.is_dir() else 0o600)
        result = self.stage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o700)
        for item in self.destination.rglob("*"):
            with self.subTest(path=item.relative_to(self.destination)):
                self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o755 if item.is_dir() else 0o644)
                if item.is_file():
                    original = self.source / item.relative_to(self.destination)
                    self.assertEqual(item.read_bytes(), original.read_bytes())
                    self.assertEqual(stat.S_IMODE(original.stat().st_mode), 0o600)

    def test_actual_staging_keeps_runtime_assets_and_excludes_private_files(self):
        for name in (".env", "data/uploads/source.txt", ".venv/private.py", "app/.env",
                     "app/.hidden/credential.py", "app/__pycache__/secret.py",
                     "app/nested/source.pyc", "app/nested/source.png", "app/nested/private.json"):
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("EXCLUDED FIXTURE\n")
        result = self.stage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            {str(item.relative_to(self.destination)) for item in self.destination.rglob("*") if item.is_file()},
            self.expected_files,
        )

    def test_actual_staging_rejects_symlinked_application_source(self):
        outside = self.root / "outside.py"
        outside.write_text("Must never be packaged\n")
        (self.source / "app/nested/external.py").symlink_to(outside)
        result = self.stage()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlinks", result.stderr)
        self.assertFalse((self.destination / "app/nested/external.py").exists())


if __name__ == "__main__":
    unittest.main()
