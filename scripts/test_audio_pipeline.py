#!/usr/bin/env python3
"""在根 tmp/ 内验证音频清单维护，不改写正式媒体或来源证据。"""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
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


def build_snapshot(manifest_path):
    snapshot_path = manifest_path.parent / "audition_data.js"
    subprocess.run(
        [sys.executable, "-B", str(ROOT / "scripts/build_audition_index.py"),
         "--manifest", str(manifest_path), "--output", str(snapshot_path)],
        check=True, capture_output=True, text=True,
    )
    return read_snapshot(snapshot_path)


class AudioManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = read_json(AUDIO / "generation.json")
        cls.previous_manifest = read_json(AUDIO / "audio_manifest.json")
        cls.receipts = read_json(AUDIO / "sources/source_receipts.json")
        temporary_parent = ROOT / "tmp/audio-pipeline-tests"
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

        cls.snapshot = build_snapshot(output_audio / "audio_manifest.json")

    def test_committed_config_and_artifacts_have_no_workspace_audit(self):
        self.assertNotIn("reuse_audit", self.config.keys())
        self.assertNotIn("reuse_audit", self.previous_manifest.keys())
        self.assertNotIn("reuse_audit", read_snapshot(AUDIO / "audition_data.js").keys())

    def test_generated_manifest_and_snapshot_exclude_legacy_workspace_audit(self):
        self.assertNotIn("reuse_audit", self.manifest.keys())
        self.assertNotIn("reuse_audit", self.snapshot.keys())
        self.assertEqual(self.snapshot, self.manifest)

    def test_generation_follows_configured_assets_categories_and_event_mappings(self):
        configured = {asset["id"]: asset for asset in self.config["external_assets"]}
        self.assertEqual({asset["id"] for asset in self.manifest["assets"]}, set(configured))
        for asset in self.manifest["assets"]:
            spec = configured[asset["id"]]
            self.assertEqual(asset["category"], spec["category"])
            self.assertEqual(asset["event_ids"], spec.get("event_ids", [spec["id"]]))

    def test_generation_preserves_provenance_dates_and_media_hashes(self):
        self.assertEqual(self.manifest["created_date"], self.previous_manifest["created_date"])
        self.assertEqual(self.manifest["sources"], self.receipts)
        self.assertEqual(self.manifest["sources"], self.previous_manifest["sources"])
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


class AdditionalCategoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary_parent = ROOT / "tmp/audio-pipeline-tests"
        temporary_parent.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="categories-", dir=temporary_parent)
        cls.addClassCleanup(temporary.cleanup)
        cls.output_root = Path(temporary.name)
        cls.output_audio = cls.output_root / "assets/audio"
        cls.output_config = cls.output_audio / "generation.json"
        current = read_json(AUDIO / "generation.json")
        source = {**current["sources"][0], "id": "test-release", "title": "Test release"}
        assets = []
        for asset_id, category, event_id, looped in [
            ("fixture_effect", "sfx", "fixture_collision", False),
            ("fixture_theme", "music", "fixture_background", True),
        ]:
            assets.append({
                "id": asset_id, "title": asset_id,
                "path": f"audio/{category}/fixtures/{asset_id}.ogg",
                "category": category, "event_ids": [event_id],
                "original_entry": f"Audio/{asset_id}.ogg", "source_id": source["id"],
                "playback": {"volume": 0.5, "cooldown_seconds": 0.1,
                             "max_instances": 1, "looped": looped},
            })
        cls.config = {**current, "sources": [source], "external_assets": assets,
                      "events": [{"id": asset["event_ids"][0], "asset_ids": [asset["id"]]}
                                 for asset in assets]}
        cls.output_audio.mkdir(parents=True)
        audio_pipeline.write_json(cls.output_config, cls.config)
        archive = cls.output_root / "tmp/audio/downloads/test-release.zip"
        archive.parent.mkdir(parents=True)
        # 复用已入库字节构造隔离发布包，只验证分类与映射，不取得或发布新素材。
        original = (ROOT / "assets" / current["external_assets"][0]["path"]).read_bytes()
        with zipfile.ZipFile(archive, "w") as release:
            release.writestr("License.txt", "Audio pipeline test fixture")
            for asset in assets:
                release.writestr(asset["original_entry"], original)
        with patch.multiple(audio_pipeline, ROOT=cls.output_root, AUDIO=cls.output_audio,
                            CONFIG=cls.output_config), patch("urllib.request.urlopen") as download:
            audio_pipeline.import_sources(cls.config, "2000-01-02", use_cache=True)
            download.assert_not_called()
            audio_pipeline.generate(cls.config)
        cls.manifest = read_json(cls.output_audio / "audio_manifest.json")

    def test_import_generation_quality_and_snapshot_support_additional_categories(self):
        self.assertEqual({asset["category"] for asset in self.manifest["assets"]}, {"sfx", "music"})
        self.assertEqual({tuple(asset["event_ids"]) for asset in self.manifest["assets"]},
                         {("fixture_collision",), ("fixture_background",)})
        with patch.multiple(audio_pipeline, ROOT=self.output_root, AUDIO=self.output_audio,
                            CONFIG=self.output_config):
            result = audio_pipeline.check(self.config, shutil.which("ffmpeg"), shutil.which("ffprobe"))
        self.assertEqual(result, 0)
        manifest = read_json(self.output_audio / "audio_manifest.json")
        self.assertTrue(all(asset["quality"]["original_release_bytes_match"] for asset in manifest["assets"]))
        self.assertEqual(build_snapshot(self.output_audio / "audio_manifest.json"), manifest)

    def test_audition_categories_paths_and_loop_policy_follow_manifest(self):
        # 使用现有离线页面 DOM 执行真实页面脚本，音频元素由数据桩代替。
        script = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const { scriptsIn, testDocument } = await import(pathToFileURL(path.join(input.root, 'docs/diagrams/tests/test-dom.mjs')).href);
const html = fs.readFileSync(path.join(input.root, 'assets/audio/audition.html'), 'utf8');
const document = testDocument(html);
document.createTextNode = value => { const node = document.createElement('#text'); node.textContent = value; return node; };
const audio = document.getElementById('audio');
audio.paused = true;
audio.pause = () => { audio.paused = true; };
audio.load = () => {};
audio.play = () => { audio.paused = false; return Promise.resolve(); };
const context = vm.createContext({ document, URL, location: { protocol: 'file:' }, window: { AUDIO_MANIFEST: input.manifest } });
for (const { attributes, script } of scriptsIn(html)) if (!attributes.includes('src=')) vm.runInContext(script, context);
const tabs = () => document.getElementById('category-tabs').children;
const cards = () => document.querySelectorAll('.card').map(card => card.dataset.assetId);
assert.deepEqual(tabs().map(tab => tab.dataset.category), ['', 'music', 'sfx']);
assert.deepEqual(cards(), ['fixture_theme', 'fixture_effect']);
tabs().find(tab => tab.dataset.category === 'sfx').click();
assert.deepEqual(cards(), ['fixture_effect']);
document.getElementById('search').value = 'fixture_theme';
tabs()[0].click();
assert.deepEqual(cards(), ['fixture_theme']);
document.getElementById('search').value = '';
const effect = input.manifest.assets.find(asset => asset.category === 'sfx');
assert.equal(context.assetUrl(effect), 'sfx/fixtures/fixture_effect.ogg');
assert.equal(context.assetUrl({ ...effect, path: 'audio/sfx/nested/effect one.ogg' }), 'sfx/nested/effect%20one.ogg');
for (const invalid of ['audio/../outside.ogg', 'audio/sfx/../outside.ogg', 'audio//file.ogg', 'audio/music/wrong.ogg', 'https://example.invalid/effect.ogg', 'audio/sfx/effect.ogg?query']) {
  assert.throws(() => context.assetUrl({ ...effect, path: invalid }), /Invalid asset/);
}
const theme = input.manifest.assets.find(asset => asset.category === 'music');
await context.playAsset(theme);
assert.equal(audio.loop, true);
await context.playAsset(effect);
assert.equal(audio.loop, false);
context.stop();
assert.equal(audio.paused, true);
tabs().find(tab => tab.dataset.category === 'sfx').click();
context.setManifest({ assets: [{ ...effect, id: 'another', category: 'ambient', path: 'audio/ambient/another.ogg' }] }, 'replacement');
assert.equal(tabs()[0].getAttribute('aria-pressed'), 'true');
assert.deepEqual(cards(), ['another']);
context.setManifest({ assets: [
  { ...effect, id: 'all_category', category: 'all', path: 'audio/all/fixture.ogg' },
  { ...effect, id: 'ambient_category', category: 'ambient', path: 'audio/ambient/fixture.ogg' },
  { ...effect, id: 'constructor_category', category: 'constructor', path: 'audio/constructor/fixture.ogg' },
] }, 'category names');
assert.equal(tabs().find(tab => tab.dataset.category === 'constructor').textContent, 'constructor');
tabs().find(tab => tab.dataset.category === 'all').click();
assert.deepEqual(cards(), ['all_category']);
tabs()[0].click();
assert.equal(cards().length, 3);
"""
        subprocess.run(
            ["node", "--input-type=module", "-e", script],
            input=json.dumps({"root": str(ROOT), "manifest": self.manifest}),
            check=True, capture_output=True, text=True,
        )


if __name__ == "__main__":
    unittest.main()
