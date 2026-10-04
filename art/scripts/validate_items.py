"""离线检查道具 GLB、米制尺寸、接口节点与制作清单，不启动游戏。"""

import argparse
import json
from pathlib import Path
import sys

BASE = Path(__file__).resolve().parents[2]
sys.pycache_prefix = str(BASE / "tmp/python-cache")
from validate_assets import Glb, InvalidGlb, multiply, require


def validate_entry(root, entry):
    """按真实 GLB 网格与世界变换验证，避免只检查文件是否存在。"""
    path = (root / entry["file"]).resolve()
    require(path.is_relative_to((root / "assets/models/items").resolve()), "Item file is outside items directory")
    require(path.stem == entry["id"], "Item file stem differs from asset ID")
    model = Glb(path)
    result = model.check()
    require(not model.document.get("images") and not model.document.get("textures"), "Items must use embedded color materials")
    require(not model.document.get("cameras"), "Preview camera leaked into GLB")
    require("KHR_lights_punctual" not in model.document.get("extensions", {}), "Preview light leaked into GLB")
    require(result["triangles"] == entry["triangles"], "Triangle count differs from manifest")
    require(path.stat().st_size == entry["bytes"], "GLB byte size differs from manifest")
    require(50 <= result["triangles"] <= 25000, "Item triangle count outside low-poly budget")
    roots = [node for node in model.document["nodes"] if node.get("extras", {}).get("asset_id") == entry["id"]]
    require(len(roots) == 1 and roots[0].get("extras", {}).get("item_id") == entry["item_id"], "Item root metadata missing")
    require(roots[0]["extras"].get("variant") == entry["variant"], "Variant metadata differs from manifest")
    minimum, maximum = model.bounds()
    blender_min, blender_max = entry["bounds_blender_m"]["min"], entry["bounds_blender_m"]["max"]
    # Blender(x,y,z)转换为glTF(x,z,-y)，检查真实顶点包围盒而非访问器局部尺寸。
    expected_min = (blender_min[0], blender_min[2], -blender_max[1])
    expected_max = (blender_max[0], blender_max[2], -blender_min[1])
    require(all(abs(actual - expected) < 0.0005 for actual, expected in zip(minimum, expected_min)), "GLB minimum bounds differ from source")
    require(all(abs(actual - expected) < 0.0005 for actual, expected in zip(maximum, expected_max)), "GLB maximum bounds differ from source")
    require(-0.025 <= minimum[1] <= 0.025, "Item base is not grounded at origin")
    names = {node.get("name") for node in model.document["nodes"]}
    node_ids = {node.get("name"): index for index, node in enumerate(model.document["nodes"])}
    conversion = ((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1))
    inverse = ((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1))
    for socket in entry["sockets"]:
        require(socket["node"] in names, "Named socket was omitted from export")
        source = socket["matrix_blender_column_major"]
        matrix = tuple(tuple(source[column * 4 + row] for column in range(4)) for row in range(4))
        expected = multiply(multiply(conversion, matrix), inverse)
        actual = model.transforms[node_ids[socket["node"]]]
        require(all(abs(actual[row][column] - expected[row][column]) < 0.00005
                    for row in range(4) for column in range(4)), "Exported socket matrix differs from source")
    for pivot in entry["mechanical_pivots"]:
        require(pivot in names, "Named mechanical pivot was omitted from export")
    require(not any("Studio" in name or "Camera_Items" in name for name in names if name), "Preview studio leaked into GLB")
    if entry["category"] == "items/industrial":
        require(any("socket_input" in name for name in names if name), "Industrial input socket missing")
        require(any("socket_output" in name for name in names if name), "Industrial output socket missing")
    if entry["category"] == "items/magic":
        require(any("socket_effect" in name for name in names if name), "Magic effect socket missing")
    if entry["equip_slot"] in ("hands", "feet") and entry["id"] != "itm_reach_grabber":
        require(any("part_left" in name for name in names if name)
                and any("part_right" in name for name in names if name), "Paired equipment subroots missing")
    result["bounds_y_up_m"] = [minimum, maximum]
    result["bytes"] = path.stat().st_size
    result["socket_matrices_checked"] = len(entry["sockets"])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=BASE)
    parser.add_argument("--report", type=Path, default=BASE / "tmp/item-assets/validation.json")
    options = parser.parse_args()
    root = options.root.resolve()
    manifest = json.loads((root / "art/items/asset_manifest.json").read_text(encoding="utf-8"))
    entries = manifest["assets"]
    require(len({entry["id"] for entry in entries}) == len(entries), "Duplicate item asset IDs")
    require(len({entry["item_id"] for entry in entries}) == 18, "Expected eighteen main items")
    require(manifest["main_item_count"] == 18, "Main item count differs from manifest")
    report = {"status": "passed", "assets": [], "errors": []}
    for entry in entries:
        try:
            record = {"id": entry["id"], "status": "passed", **validate_entry(root, entry)}
        except (InvalidGlb, KeyError, TypeError, ValueError, OSError) as error:
            record = {"id": entry["id"], "status": "failed", "error": str(error)}
            report["errors"].append(f"{entry['id']}: {error}")
        report["assets"].append(record)
    expected_files = {(root / entry["file"]).resolve() for entry in entries}
    discovered = set((root / "assets/models/items").rglob("*.glb"))
    if expected_files != discovered:
        report["errors"].append("Item GLB files differ from manifest")
    if report["errors"]:
        report["status"] = "failed"
    options.report.parent.mkdir(parents=True, exist_ok=True)
    options.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "assets_checked": len(entries), "errors": report["errors"]}))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
