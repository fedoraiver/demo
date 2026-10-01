"""荒凉海岛的天然细节；无道路、公园或规则街区布置。"""

from math import cos, hypot, pi, sin
from random import Random


COAST = (
    (-52, -20), (-48, -31), (-32, -37), (-23, -31), (-17, -39), (-5, -44),
    (7, -39), (13, -30), (25, -32), (35, -24), (48, -22), (53, -8),
    (45, 1), (50, 14), (39, 23), (29, 24), (21, 39), (8, 43),
    (-1, 32), (-13, 35), (-18, 25), (-34, 29), (-41, 20), (-39, 10),
    (-50, 4), (-46, -6), (-56, -11),
)
BUILDINGS = ((-9, 3), (3, 10), (13, 0), (-23, 19), (23, 22))


def _inside(x, y, scale=0.85):
    """奇偶射线检查不规则岸线，不再使用椭圆边界。"""
    points = [(px * scale, py * scale) for px, py in COAST]
    inside = False
    j = len(points) - 1
    for i, (xi, yi) in enumerate(points):
        xj, yj = points[j]
        if (yi > y) != (yj > y):
            cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < cross:
                inside = not inside
        j = i
    return inside


def _available(x, y, margin=7.0):
    """树根留在平坦内陆，并留出店门台阶和南侧码头接岸位置。"""
    if not _inside(x, y):
        return False
    for bx, by in BUILDINGS:
        if hypot(x - bx, y - by) < margin:
            return False
        if abs(x - bx) < 4.2 and by - 7.0 < y < by:
            return False
    return not (abs(x + 5) < 4.0 and y < -33)


def _patch(h, a, name, center, scale, rng, material):
    """不规则多边形地表斑块，形状不连成道路或规则圆形。"""
    x, y = center
    points = []
    count = rng.randint(8, 11)
    phase = rng.uniform(0, 2 * pi)
    for i in range(count):
        angle = phase + i * 2 * pi / count
        jitter = rng.uniform(0.46, 1.0)
        px, py = x + cos(angle) * scale[0] * jitter, y + sin(angle) * scale[1] * jitter
        if not _available(px, py, 6.0):
            px, py = x + (px - x) * 0.45, y + (py - y) * 0.45
        points.append((px, py, 0.018 + rng.uniform(0, 0.008)))
    vertices = [(x, y, 0.021)] + points
    faces = [(0, i + 1, (i + 1) % count + 1) for i in range(count)]
    h.mesh(a, name, vertices, faces, material)


def _driftwood(h, a, name, x, y, angle, scale):
    """风化木枝平躺地面，断枝长度与方向不对称。"""
    def point(t, side=0, z=0.13):
        return (x + cos(angle) * t * scale - sin(angle) * side * scale,
                y + sin(angle) * t * scale + cos(angle) * side * scale, z * scale)
    h.beam(a, f"{name}_trunk", point(-1.20), point(1.15, 0.15, 0.18), 0.20 * scale, "weathered_wood")
    h.beam(a, f"{name}_branch_a", point(0.25), point(0.75, 0.66, 0.15), 0.09 * scale, "wood_gray")
    h.beam(a, f"{name}_branch_b", point(-0.56), point(-0.80, -0.39, 0.12), 0.07 * scale, "weathered_dark")
    h.ico(a, f"{name}_broken_end", point(-1.22), (0.13 * scale, 0.13 * scale, 0.12 * scale),
          "wood_gray", subdivisions=1)


def build_district(h):
    """生成一个荒野细节资产，所有自然细节以地形中心为坐标原点。"""
    a = h.asset("env_wilderness_details", "environment")
    rng = Random(415782)
    for i, (center, scale, material) in enumerate((
        ((-28, -13), (11, 5.5), "dry_sand"), ((-15, -23), (8, 6), "soil"),
        ((28, -12), (8, 5), "dry_sand"), ((31, 9), (7, 4.3), "soil"),
        ((-32, 8), (7, 4), "dry_sand"), ((8, 27), (8, 5), "soil"),
        ((-6, -20), (5, 3.2), "dry_sand"),
    )):
        _patch(h, a, f"Dry_ground_patch_{i}", center, scale, rng, material)
    rocks = ((-38, -13), (-32, -24), (-27, -8), (-13, -31), (5, -30),
             (25, -23), (37, -13), (34, 9), (18, 29), (9, 31),
             (-9, 23), (-30, 15), (-39, 4), (0, -10))
    for i, (x, y) in enumerate(rocks):
        if not _available(x, y, 6.8):
            continue
        size = rng.uniform(0.52, 1.12)
        rock = h.ico(a, f"Loose_rock_{i}", (x, y, 0.38 * size),
                     (0.99 * size, 0.63 * size, 0.42 * size),
                     "rock_light" if i % 3 else "rock", subdivisions=1)
        # 对象独立扭转，保留散落而非重复阵列的外观。
        rock.rotation_euler = (rng.uniform(-0.14, 0.14), rng.uniform(-0.13, 0.13), rng.uniform(0, 2 * pi))
        for pebble in range(rng.randint(1, 3)):
            h.ico(a, f"Loose_pebble_{i}_{pebble}",
                  (x + rng.uniform(-1.5, 1.5), y + rng.uniform(-1.1, 1.1), 0.10),
                  (0.25, 0.17, 0.14), "rock", subdivisions=1)
    for i, (x, y) in enumerate(((-35, -17), (-22, -28), (21, -21), (37, -6), (-37, 8), (8, 30))):
        if _available(x, y, 6.8):
            _driftwood(h, a, f"Driftwood_{i}", x, y, rng.uniform(0, 2 * pi), rng.uniform(0.7, 1.2))
    for i, (x, y) in enumerate(((-31, 1), (29, 5), (14, 28))):
        if not _available(x, y):
            continue
        h.beam(a, f"Dead_stump_{i}", (x, y, 0.06), (x + 0.20, y - 0.16, 1.05), 0.22, "weathered_dark")
        h.beam(a, f"Dead_branch_{i}", (x + 0.12, y - 0.10, 0.64),
               (x - 0.46, y + 0.23, 0.96), 0.08, "wood_gray")
    return [a]


def dress_district(h, lookup, collection):
    """偏向疏密不一的棕榈与荒草群落，留出大片沙色空地。"""
    def place(key, name, location, yaw=0, scale=1):
        if key in lookup:
            h.instance(lookup[key], "Wilderness_" + name, location, yaw, scale, collection)

    place("env_wilderness_details", "details", (0, 0, 0))
    rng = Random(781035)
    # 群落分布绕过建筑；各群的数量、中心和半径刻意不保持对称。
    palm_groves = (((-30, -16), 7, 7.5), ((-38, -2), 4, 5.5),
                   ((-7, 23), 5, 5.4), ((12, 28), 4, 5.8),
                   ((32, 7), 3, 5.8), ((29, -15), 5, 7.0), ((-11, -28), 3, 4.7))
    palms = ("prop_palm_leaning", "prop_palm_crooked", "prop_palm_young")
    palm_index = 0
    for (cx, cy), count, radius in palm_groves:
        accepted = 0
        for _attempt in range(150):
            if accepted == count:
                break
            angle = rng.uniform(0, 2 * pi)
            spread = radius * rng.random() ** 0.5
            x, y = cx + cos(angle) * spread, cy + sin(angle) * spread
            if not _available(x, y, 7.0):
                continue
            key = rng.choices(palms, (4, 4, 2))[0]
            place(key, f"palm_{palm_index}", (x, y, 0), rng.uniform(0, 2 * pi), rng.uniform(0.85, 1.18))
            palm_index += 1
            accepted += 1
    grass_groves = (((-28, -17), 20, 8), ((-38, 1), 11, 6), ((-5, 24), 13, 7),
                    ((13, 27), 14, 7), ((30, 7), 14, 8), ((28, -16), 17, 8),
                    ((-12, -27), 13, 7), ((-4, -12), 8, 5))
    grass_index = 0
    for (cx, cy), count, radius in grass_groves:
        accepted = 0
        for _attempt in range(200):
            if accepted == count:
                break
            # 三角分布让荒草成片但边缘破碎，不采用等距网格。
            x, y = cx + rng.triangular(-radius, radius, -1), cy + rng.triangular(-radius, radius, 1)
            if not _available(x, y, 7.2):
                continue
            place("prop_wild_grass_patch", f"grass_{grass_index}", (x, y, 0.012),
                  rng.uniform(0, 2 * pi), rng.uniform(0.45, 0.90))
            grass_index += 1
            accepted += 1
    for i, (x, y) in enumerate(((-34, -8), (-24, -23), (30, -9), (-8, 27), (16, 27), (-40, -4))):
        if _available(x, y, 7.4):
            place("prop_shrub", f"scrub_{i}", (x, y, 0), rng.uniform(0, 2 * pi), rng.uniform(0.60, 0.85))
