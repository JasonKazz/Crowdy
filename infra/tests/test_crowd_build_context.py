import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "crowd_context", Path(__file__).resolve().parents[1] / "scripts/stage-crowd-estimation.py"
)
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)


class CrowdBuildContextTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="crowdy-context-test.")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.destination = self.root / "context"
        (self.source / "app/nested").mkdir(parents=True)
        self.destination.mkdir()
        for name in ("Dockerfile", "pyproject.toml", "uv.lock", "app/__init__.py", "app/nested/main.py"):
            (self.source / name).write_text(f"# Public build source: {name}\n")

    def test_private_umask_and_sources_produce_nonroot_readable_image_inputs(self):
        for item in self.source.rglob("*"):
            item.chmod(0o700 if item.is_dir() else 0o600)
        previous_umask = os.umask(0o077)
        try:
            context.stage_context(self.source, self.destination)
        finally:
            os.umask(previous_umask)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o700)
        for item in self.destination.rglob("*"):
            with self.subTest(path=item.relative_to(self.destination)):
                self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o755 if item.is_dir() else 0o644)
                if item.is_file():
                    original = self.source / item.relative_to(self.destination)
                    self.assertEqual(item.read_bytes(), original.read_bytes())
                    self.assertEqual(stat.S_IMODE(original.stat().st_mode), 0o600)

    def test_excludes_credentials_weights_uploads_caches_and_other_assets(self):
        for name in (".env", "models/local.pt", "uploads/crowd.jpg", "app/.env", "app/.hidden/token.py",
                     "app/__pycache__/main.pyc", "app/__pycache__/secret.py", "app/nested/image.jpg",
                     "app/nested/weights.pt", "app/nested/credentials.json"):
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("EXCLUDED FIXTURE\n")
        context.stage_context(self.source, self.destination)
        self.assertEqual(
            sorted(str(item.relative_to(self.destination)) for item in self.destination.rglob("*") if item.is_file()),
            ["Dockerfile", "app/__init__.py", "app/nested/main.py", "pyproject.toml", "uv.lock"],
        )

    def test_rejects_symlinks_in_build_inputs(self):
        outside = self.root / "outside.py"
        outside.write_text("# Must never be packaged\n")
        for relative in ("Dockerfile", "app/nested/main.py", "app/nested/external"):
            with self.subTest(path=relative):
                target = self.source / relative
                previous = target.read_bytes() if target.is_file() else None
                if target.exists():
                    target.unlink()
                target.symlink_to(outside)
                destination = self.root / f"symlink-context-{len(list(self.root.iterdir()))}"
                destination.mkdir()
                with self.assertRaisesRegex(ValueError, "symlink"):
                    context.stage_context(self.source, destination)
                target.unlink()
                if previous is not None:
                    target.write_bytes(previous)

    def test_rejects_nonempty_destination(self):
        (self.destination / ".env").write_text("Unrelated existing file\n")
        with self.assertRaisesRegex(ValueError, "empty ordinary directory"):
            context.stage_context(self.source, self.destination)


if __name__ == "__main__":
    unittest.main()
