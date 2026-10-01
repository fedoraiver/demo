#!/usr/bin/env python3
"""零预算音频资产的导入、可重现合成和无播放技术检查。"""

import argparse
import array
import hashlib
import io
import json
import math
import platform
import random
import shutil
import struct
import subprocess
import sys
import urllib.request
import wave
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIO = ROOT / "assets/audio"
CONFIG = AUDIO / "generation.json"
VERSION = "1.0.0"
RATE = 44100


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def import_sources(config, acquired_date, use_cache):
    """只导入官方完整发布包；临时包保留在根 tmp/audio 下。"""
    cache = ROOT / "tmp/audio/downloads"
    cache.mkdir(parents=True, exist_ok=True)
    receipts = []
    for source in config["sources"]:
        archive = cache / (source["id"] + ".zip")
        if not use_cache:
            with urllib.request.urlopen(source["download"], timeout=60) as response:
                data = response.read()
            archive.write_bytes(data)
        if not archive.is_file():
            raise FileNotFoundError(f"Missing release archive: {archive}")
        blob = archive.read_bytes()
        with zipfile.ZipFile(archive) as release:
            license_blob = release.read("License.txt")
            license_path = AUDIO / "sources" / (source["id"] + "-License.txt")
            license_path.parent.mkdir(parents=True, exist_ok=True)
            license_path.write_bytes(license_blob)
            selected = []
            for asset in config["external_assets"]:
                if asset["source_id"] != source["id"]:
                    continue
                original = release.read(asset["original_entry"])
                destination = ROOT / "assets" / asset["path"]
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(original)
                selected.append({"id": asset["id"], "original_entry": asset["original_entry"],
                                 "original_sha256": sha256(original), "output_sha256": sha256(original)})
        receipts.append({**source, "status": "downloaded", "acquired_date": acquired_date,
                         "archive_bytes": len(blob), "archive_sha256": sha256(blob),
                         "archive_cache": archive.relative_to(ROOT).as_posix(),
                         "license_evidence": license_path.relative_to(ROOT / "assets").as_posix(),
                         "license_evidence_sha256": sha256(license_blob), "selected_files": selected,
                         "processing": ["download official full release ZIP", "extract selected OGG bytes unchanged", "copy release License.txt unchanged"]})
    write_json(AUDIO / "sources/source_receipts.json", receipts)
    print(f"Imported {sum(len(x['selected_files']) for x in receipts)} official release files")


def synthesize(spec):
    """每条音效独立种子；正弦谐波避免方波混叠，包络抑制起止点击。"""
    rng = random.Random(spec["seed"])
    length = round(spec["duration_seconds"] * RATE)
    samples = [0.0] * length
    if spec["recipe"] == "periodic_breeze":
        # 整数周期谐波在 6 秒内闭合；这是合成背景候选，不冒充海浪录音。
        for harmonic in spec["harmonics"]:
            phase = rng.random() * math.tau
            frequency = harmonic["cycles"] / spec["duration_seconds"]
            for i in range(length):
                samples[i] += harmonic["amplitude"] * math.sin(math.tau * frequency * i / RATE + phase)
    else:
        for note in spec["notes"]:
            phase = rng.random() * math.tau
            start = round(note["start_seconds"] * RATE)
            count = round(note["duration_seconds"] * RATE)
            for index in range(count):
                target = start + index
                if target >= length:
                    break
                position = index / max(1, count - 1)
                frequency = note["frequency_start_hz"] + (note["frequency_end_hz"] - note["frequency_start_hz"]) * position
                phase += math.tau * frequency / RATE
                attack = min(1.0, index / max(1, round(note["attack_seconds"] * RATE)))
                release = min(1.0, (count - 1 - index) / max(1, round(note["release_seconds"] * RATE)))
                envelope = attack * release * math.exp(-note["decay"] * position)
                signal = math.sin(phase) + note["second_harmonic"] * math.sin(2 * phase)
                samples[target] += signal * envelope * note["amplitude"]
    # 去 DC 后再对一次性音效应用短边缘渐变，不在循环背景的接缝添加静音。
    mean = sum(samples) / length
    samples = [x - mean for x in samples]
    if spec["recipe"] != "periodic_breeze":
        edge = round(spec["edge_fade_seconds"] * RATE)
        for index in range(edge):
            gain = index / max(1, edge - 1)
            samples[index] *= gain
            samples[-index - 1] *= gain
    peak = max(abs(x) for x in samples)
    gain = spec["target_peak"] / peak if peak else 0.0
    return [round(x * gain * 32767) for x in samples]


def render_wav(spec):
    """相同配方可在内存复现文件字节，检查时不覆盖正式成品。"""
    buffer = io.BytesIO()
    samples = synthesize(spec)
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(struct.pack("<" + "h" * len(samples), *samples))
    return buffer.getvalue()


def generate(config):
    """生成原始 PCM 文件，并让清单准确描述外部发布 OGG 与本地合成 WAV。"""
    receipts = read_json(AUDIO / "sources/source_receipts.json")
    sources = {x["id"]: x for x in receipts}
    assets = []
    for spec in config["procedural_assets"]:
        destination = ROOT / "assets" / spec["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(render_wav(spec))
        assets.append({"id": spec["id"], "event_ids": [spec["id"]], "title": spec["title"],
                       "category": spec["category"], "path": spec["path"], "kind": "procedural",
                       "format": {"container": "wav", "codec": "pcm_s16le", "lossy": False,
                                  "provenance": "original locally synthesized PCM", "sample_rate": RATE, "channels": 1, "bit_depth": 16},
                       "source": {"page": None, "author": "demo project local procedural generator",
                                  "license": "project-original", "license_version": None, "acquired_date": None,
                                  "created_date": config["created_date"], "note": "No external samples; rights remain with the project. This is not a third-party CC0 claim."},
                       "generator": {"path": "scripts/audio_pipeline.py", "version": VERSION,
                                     "config": "assets/audio/generation.json", "recipe": spec["recipe"], "seed": spec["seed"],
                                     "parameters": {key: value for key, value in spec.items()
                                                    if key not in ("id", "title", "category", "path", "playback")}},
                       "processing": ["local mathematical synthesis using recorded recipe and per-asset seed", "remove DC mean", "edge fade for one-shots only", "scale to recorded target peak", "quantize once to signed PCM16 WAV"],
                       "playback": spec["playback"], "sha256": sha256(destination.read_bytes())})
    for spec in config["external_assets"]:
        source = sources[spec["source_id"]]
        destination = ROOT / "assets" / spec["path"]
        assets.append({"id": spec["id"], "event_ids": [spec["id"]], "title": spec["title"],
                       "category": spec["category"], "path": spec["path"], "kind": "external_release",
                       "format": {"container": "ogg", "codec": "vorbis", "lossy": True,
                                  "provenance": "official release OGG (not a web preview, not asserted lossless)"},
                       "source": {"id": source["id"], "page": source["page"], "download": source["download"],
                                  "author": source["author"], "pack_version": source["pack_version"],
                                  "license": source["license"], "license_version": source["license_version"],
                                  "license_url": source["license_url"], "acquired_date": source["acquired_date"],
                                  "original_entry": spec["original_entry"], "license_evidence": source["license_evidence"]},
                       "generator": None, "processing": ["extract official ZIP entry unchanged", "rename only; no decoding, transcoding, trimming or normalization of delivered bytes", "apply volume only at playback"],
                       "playback": spec["playback"], "sha256": sha256(destination.read_bytes())})
    assets.sort(key=lambda x: (x["category"], x["id"]))
    manifest = {"schema_version": 1, "created_date": config["created_date"],
                "policy": {"budget": 0, "paid_generation_api": False, "external_license_allowlist": ["CC0-1.0"],
                           "preview_to_lossless_conversion": False, "ambience_default_enabled": False,
                           "subjective_listening_status": "not_performed", "game_runtime_status": "not_performed"},
                "reuse_audit": config["reuse_audit"], "events": config["events"], "assets": assets,
                "sources": receipts, "pending_sources": config["pending_sources"],
                "generator_environment": {"version": VERSION, "python": platform.python_version(),
                                          "dependencies": "Python standard library only",
                                          "platform": platform.platform(),
                                          "script_sha256": sha256(Path(__file__).read_bytes()),
                                          "config_sha256": sha256(CONFIG.read_bytes())}}
    write_json(AUDIO / "audio_manifest.json", manifest)
    print(f"Generated {len(config['procedural_assets'])} original PCM assets; manifest has {len(assets)} assets")


def decode(path, ffmpeg, ffprobe):
    """解码到内存用于测量，检查过程绝不输出伪造的无损源文件。"""
    probe = subprocess.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
                            "stream=codec_name,sample_rate,channels,bits_per_sample:format=format_name,duration",
                            "-of", "json", str(path)], check=True, capture_output=True)
    metadata = json.loads(probe.stdout)
    stream = metadata["streams"][0]
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "-"], check=True, capture_output=True).stdout
    samples = array.array("f")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    return stream, samples


def check(config, ffmpeg, ffprobe):
    """检查格式、静音、削波、DC、哈希和循环接缝；听感验收仍需用户试听。"""
    manifest = read_json(AUDIO / "audio_manifest.json")
    limits = config["quality_limits"]
    records = []
    for asset in manifest["assets"]:
        path = ROOT / "assets" / asset["path"]
        stream, samples = decode(path, ffmpeg, ffprobe)
        channels = stream["channels"]
        rate = int(stream["sample_rate"])
        frames = len(samples) // channels
        amplitudes = [max(abs(x) for x in samples[i * channels:(i + 1) * channels]) for i in range(frames)]
        active = [i for i, x in enumerate(amplitudes) if x > limits["silence_amplitude"]]
        peak = max(amplitudes, default=0.0)
        leading = active[0] / rate if active else frames / rate
        trailing = (frames - 1 - active[-1]) / rate if active else frames / rate
        dc = max(abs(sum(samples[c::channels]) / frames) for c in range(channels))
        clipped = sum(abs(x) >= limits["clipping_amplitude"] for x in samples)
        digest = sha256(path.read_bytes())
        warnings = []
        if digest != asset["sha256"]:
            warnings.append("hash_mismatch")
        original_bytes_match = None
        regenerated_bytes_match = None
        if asset["kind"] == "external_release":
            receipt = next(x for x in manifest["sources"] if x["id"] == asset["source"]["id"])
            original = next(x for x in receipt["selected_files"] if x["id"] == asset["id"])
            original_bytes_match = digest == original["original_sha256"]
            if not original_bytes_match:
                warnings.append("release_bytes_changed")
        else:
            spec = next(x for x in config["procedural_assets"] if x["id"] == asset["id"])
            regenerated_bytes_match = sha256(render_wav(spec)) == digest
            if not regenerated_bytes_match:
                warnings.append("regenerated_bytes_changed")
        expected_codec = asset["format"]["codec"]
        if stream["codec_name"] != expected_codec or rate not in (44100, 48000) or channels not in (1, 2):
            warnings.append("unexpected_format")
        if not active:
            warnings.append("silent_file")
        if clipped:
            warnings.append("decoded_clipping")
        if leading > limits["max_head_silence_seconds"]:
            warnings.append("long_head_silence")
        if trailing > limits["max_tail_silence_seconds"]:
            warnings.append("long_tail_silence")
        if dc > limits["max_dc_amplitude"]:
            warnings.append("dc_offset")
        seam = None
        if asset["playback"]["looped"]:
            delta = max(abs(samples[c] - samples[-channels + c]) for c in range(channels))
            slope_delta = max(abs((samples[channels + c] - samples[c]) - (samples[-channels + c] - samples[-2 * channels + c])) for c in range(channels))
            seam = {"boundary_delta": round(delta, 8), "slope_delta": round(slope_delta, 8),
                    "listening_status": "not_performed", "method": "sample boundary and first derivative; no subjective claim"}
            if delta > limits["max_loop_boundary_delta"] or slope_delta > limits["max_loop_slope_delta"]:
                warnings.append("loop_seam_discontinuity")
        record = {"id": asset["id"], "path": asset["path"], "status": "pass" if not warnings else "review_required",
                  "warnings": warnings, "codec": stream["codec_name"], "sample_rate": rate, "channels": channels,
                  "frames": frames, "duration_seconds": round(frames / rate, 6), "peak_amplitude": round(peak, 8),
                  "peak_dbfs": round(20 * math.log10(peak), 3) if peak else None,
                  "rms_dbfs": round(20 * math.log10(math.sqrt(sum(x * x for x in samples) / len(samples))), 3) if peak else None,
                  "head_silence_seconds": round(leading, 6), "tail_silence_seconds": round(trailing, 6),
                  "clipped_samples": clipped, "dc_amplitude": round(dc, 8), "loop_seam": seam,
                  "sha256": digest, "hash_match": digest == asset["sha256"],
                  "original_release_bytes_match": original_bytes_match,
                  "regenerated_bytes_match": regenerated_bytes_match}
        records.append(record)
        asset["quality"] = record
    report = {"schema_version": 1, "checked_date": datetime.now(timezone(timedelta(hours=8))).date().isoformat(), "checker_version": VERSION,
              "limits": limits, "tools": {"python": platform.python_version(),
              "ffmpeg": subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, check=True).stdout.splitlines()[0],
              "ffprobe": subprocess.run([ffprobe, "-version"], capture_output=True, text=True, check=True).stdout.splitlines()[0]},
              "technical_status": "pass" if all(x["status"] == "pass" for x in records) else "review_required",
              "subjective_listening_status": "not_performed", "game_runtime_status": "not_performed", "assets": records}
    write_json(AUDIO / "quality_report.json", report)
    write_json(AUDIO / "audio_manifest.json", manifest)
    print(json.dumps({"technical_status": report["technical_status"], "assets": len(records), "warnings": {x["id"]: x["warnings"] for x in records if x["warnings"]}}, ensure_ascii=False))
    return 0 if report["technical_status"] == "pass" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import-sources")
    importer.add_argument("--acquired-date", required=True, help="Actual date of obtaining the release archives (YYYY-MM-DD)")
    importer.add_argument("--use-cache", action="store_true", help="Use already obtained tmp/audio/downloads official ZIPs")
    commands.add_parser("generate")
    checker = commands.add_parser("check")
    checker.add_argument("--ffmpeg", default=shutil.which("ffmpeg"))
    checker.add_argument("--ffprobe", default=shutil.which("ffprobe"))
    arguments = parser.parse_args()
    config = read_json(CONFIG)
    if config["generator_version"] != VERSION:
        raise ValueError("Generator version mismatch")
    if arguments.command == "import-sources":
        import_sources(config, arguments.acquired_date, arguments.use_cache)
    elif arguments.command == "generate":
        generate(config)
    else:
        if not arguments.ffmpeg or not arguments.ffprobe:
            raise RuntimeError("Existing ffmpeg and ffprobe are required for technical checks; pass their paths explicitly")
        return check(config, arguments.ffmpeg, arguments.ffprobe)
    return 0


if __name__ == "__main__":
    sys.exit(main())
