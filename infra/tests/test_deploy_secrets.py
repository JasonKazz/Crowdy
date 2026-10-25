import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class DeploymentSecretPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="crowdy-deploy-secrets-test.")
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "secrets.auto.tfvars.json"
        script = (Path(__file__).resolve().parents[1] / "scripts/deploy.sh").read_text()
        marker = 'python3 - "$infra_dir/secrets.auto.tfvars.json" <<\'PY\'\n'
        self.assertEqual(script.count(marker), 1)
        self.persistence_code = script.split(marker, 1)[1].split("\nPY\n", 1)[0]

    def persist(self, updates=None):
        environment = {key: value for key, value in os.environ.items() if not key.startswith("TF_VAR_")}
        environment.update({"TF_VAR_" + key: value for key, value in (updates or {}).items()})
        return subprocess.run(
            [sys.executable, "-", str(self.path)], input=self.persistence_code,
            capture_output=True, text=True, env=environment, umask=0o077,
        )

    def test_gateway_addition_retains_native_keys_and_stays_private(self):
        existing = {"gemini_api_key": "native-gemini-fixture", "anthropic_api_key": "native-claude-fixture"}
        self.path.write_text(json.dumps(existing))
        result = self.persist({"ai_gateway_api_key": "gateway-fixture"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.path.read_text(), json.dumps({**existing, "ai_gateway_api_key": "gateway-fixture"}, indent=2) + "\n")
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(result.stdout + result.stderr, "")
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_omitted_gateway_export_preserves_saved_key_and_explicit_empty_clears_only_it(self):
        values = {"gemini_api_key": "native-gemini-fixture", "anthropic_api_key": "native-claude-fixture",
                  "ai_gateway_api_key": "gateway-fixture"}
        self.path.write_text(json.dumps(values))
        self.path.chmod(0o644)
        result = self.persist()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.path.read_text()), values)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        result = self.persist({"ai_gateway_api_key": ""})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.path.read_text()), {**values, "ai_gateway_api_key": ""})
        self.assertEqual(result.stdout + result.stderr, "")

    def test_unsupported_names_and_nonstring_values_fail_without_printing_values(self):
        for values in ({"gateway_endpoint": "private-fixture-value"}, {"ai_gateway_api_key": ["private-fixture-value"]}):
            with self.subTest(keys=list(values)):
                self.path.write_text(json.dumps(values))
                original = self.path.read_bytes()
                result = self.persist({"ai_gateway_api_key": "new-gateway-fixture"})
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("private-fixture-value", result.stdout + result.stderr)
                self.assertNotIn("new-gateway-fixture", result.stdout + result.stderr)
                self.assertEqual(self.path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
