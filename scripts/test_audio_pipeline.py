#!/usr/bin/env python3
"""在根 tmp/ 内验证音频清单维护，不改写正式媒体或来源证据。"""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import audio_pipeline


ROOT = Path(__file__).resolve().parents[1]
AUDIO = ROOT / "assets/audio"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_snapshot(path):
    text = path.read_text(encoding="utf-8")
    return json.loads(text.split("window.AUDIO_MANIFEST = ", 1)[1].removesuffix(";\n"))


class AudioManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = read_json(AUDIO / "generation.json")
        cls.previous_manifest = read_json(AUDIO / "audio_manifest.json")
        cls.receipts = read_json(AUDIO / "sources/source_receipts.json")
        temporary_parent = ROOT / "tmp/issue-11-audio"
        temporary_parent.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="pipeline-", dir=temporary_parent)
        cls.addClassCleanup(temporary.cleanup)
        cls.output_root = Path(temporary.name)
        output_audio = cls.output_root / "assets/audio"
        (output_audio / "sources").mkdir(parents=True)
        shutil.copyfile(
            AUDIO / "sources/source_receipts.json",
            output_audio / "sources/source_receipts.json",
        )
        for spec in cls.config["external_assets"]:
            destination = cls.output_root / "assets" / spec["path"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / "assets" / spec["path"], destination)

        # 即使旧配置重新出现，生成结果也不能再把一次性工作区审计当成资产信息。
        legacy_config = {**cls.config, "reuse_audit": {"result": "obsolete_workspace_check"}}
        output_config = output_audio / "generation.json"
        output_config.write_text(json.dumps(legacy_config), encoding="utf-8")
        with patch.multiple(
            audio_pipeline,
            ROOT=cls.output_root,
            AUDIO=output_audio,
            CONFIG=output_config,
        ):
            audio_pipeline.generate(legacy_config)
        cls.manifest = read_json(output_audio / "audio_manifest.json")

        snapshot_path = output_audio / "audition_data.js"
        subprocess.run(
            [
                sys.executable,
                "-B",
                str(ROOT / "scripts/build_audition_index.py"),
                "--manifest",
                str(output_audio / "audio_manifest.json"),
                "--output",
                str(snapshot_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        cls.snapshot = read_snapshot(snapshot_path)

    def test_committed_config_and_artifacts_have_no_workspace_audit(self):
        self.assertNotIn("reuse_audit", self.config.keys())
        self.assertNotIn("reuse_audit", self.previous_manifest.keys())
        self.assertNotIn("reuse_audit", read_snapshot(AUDIO / "audition_data.js").keys())

    def test_generated_manifest_and_snapshot_exclude_legacy_workspace_audit(self):
        self.assertNotIn("reuse_audit", self.manifest.keys())
        self.assertNotIn("reuse_audit", self.snapshot.keys())
        self.assertEqual(self.snapshot, self.manifest)

    def test_generation_preserves_provenance_dates_and_media_hashes(self):
        self.assertEqual(self.manifest["created_date"], self.previous_manifest["created_date"])
        self.assertEqual(self.manifest["sources"], self.receipts)
        self.assertEqual(self.manifest["sources"], self.previous_manifest["sources"])
        self.assertEqual(self.manifest["pending_sources"], self.previous_manifest["pending_sources"])
        previous_assets = {asset["id"]: asset for asset in self.previous_manifest["assets"]}
        self.assertEqual({asset["id"] for asset in self.manifest["assets"]}, set(previous_assets))
        for asset in self.manifest["assets"]:
            with self.subTest(asset=asset["id"]):
                previous = previous_assets[asset["id"]]
                self.assertEqual(asset["source"], previous["source"])
                self.assertEqual(asset["sha256"], previous["sha256"])
                media = self.output_root / "assets" / asset["path"]
                self.assertEqual(hashlib.sha256(media.read_bytes()).hexdigest(), previous["sha256"])
        self.assertEqual(read_json(AUDIO / "sources/source_receipts.json"), self.receipts)


if __name__ == "__main__":
    unittest.main()
