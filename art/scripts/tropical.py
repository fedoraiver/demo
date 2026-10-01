"""荒岛植被：弯曲棕榈与高野草，使用实体折面几何而不依赖贴图。"""

from math import cos, pi, sin, sqrt
from random import Random


def _add(a, b):
    return tuple(a[i] + b[i] for i in range(3))


def _scale(vector, amount):
    return tuple(v * amount for v in vector)


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _unit(vector):
    length = sqrt(sum(v * v for v in vector))
    return tuple(v / length for v in vector)


def _frame(tangent):
    """沿弯曲树干建立截面；底部单独使用水平截面以保持地面轴心。"""
    tangent = _unit(tangent)
    reference = (0, 1, 0) if abs(tangent[1]) < 0.9 else (1, 0, 0)
    x_axis = _unit(_cross(reference, tangent))
    return x_axis, _cross(tangent, x_axis)


def _ring(center, radius, tangent, phase, vertices=8):
    x_axis, y_axis = _frame(tangent)
    return [_add(center, _add(_scale(x_axis, cos(phase + i * 2 * pi / vertices) * radius),
                              _scale(y_axis, sin(phase + i * 2 * pi / vertices) * radius)))
            for i in range(vertices)]


def _tube(h, asset, name, lower, upper, material, cap=True):
    """相邻环共享位置，棱面接缝构成逐段弯曲的细长树干。"""
    count = len(lower)
    faces = [(i, (i + 1) % count, count + (i + 1) % count, count + i) for i in range(count)]
    if cap:
        faces.extend((tuple(reversed(range(count))), tuple(range(count, 2 * count))))
    return h.mesh(asset, name, lower + upper, faces, material)


def _trunk(h, asset, knots, base_radius, seed):
    """截面逐渐收细，褐色窄环替代纹理表现老树干的环状叶痕。"""
    rng = Random(seed)
    phase = rng.uniform(0, pi / 4)
    height = knots[-1][2]
    tangents = []
    for i, point in enumerate(knots):
        if i == 0:
            tangent = (0, 0, 1)
        else:
            previous = knots[i-1]
            following = knots[min(i+1, len(knots)-1)]
            tangent = tuple(following[k] - previous[k] for k in range(3))
        tangents.append(_unit(tangent))
    radii = [base_radius * (1 - 0.63 * point[2] / height) for point in knots]
    radii[0] *= 1.32
    rings = [_ring(point, radius, tangent, phase) for point, radius, tangent in zip(knots, radii, tangents)]
    for i in range(len(knots)-1):
        material = "wood_dark" if i % 5 == 3 else "wood"
        _tube(h, asset, f"Bent trunk segment {i:02d}", rings[i], rings[i+1], material)
    distance = 0.32
    scar = 0
    while distance < height - 0.22:
        segment = next(i for i in range(len(knots)-1) if knots[i][2] <= distance <= knots[i+1][2])
        start, end = knots[segment], knots[segment+1]
        fraction = (distance-start[2])/(end[2]-start[2])
        center = tuple(start[k]+(end[k]-start[k])*fraction for k in range(3))
        tangent = _unit(tuple(end[k]-start[k] for k in range(3)))
        radius = radii[segment]*(1-fraction)+radii[segment+1]*fraction
        lower = _ring(_add(center, _scale(tangent, -0.014)), radius + 0.007, tangent, phase)
        upper = _ring(_add(center, _scale(tangent, 0.014)), radius + 0.016, tangent, phase)
        _tube(h, asset, f"Old leaf scar {scar:02d}", lower, upper, "wood_dark", cap=False)
        distance += rng.uniform(0.28, 0.46)
        scar += 1
    return knots[-1]


def _frond(h, asset, name, crown, angle, length, width, rise, droop, seed, material):
    """叶片为有厚度的折面；不对称锯齿和断尖打破整齐放射状叶冠。"""
    rng = Random(seed)
    forward = (cos(angle), sin(angle), 0)
    lateral = (-sin(angle), cos(angle), 0)
    stations = 11
    thickness = 0.013
    top, centerline = [], []
    broken = seed % 4 == 0
    for i in range(stations):
        t = i / (stations-1)
        sideways = sin(t*pi) * length * rng.uniform(-0.075, 0.075)
        lift = rise * sin(t*pi) - droop * t*t
        center = _add(crown, _add(_scale(forward, length*t), _add(_scale(lateral, sideways), (0, 0, lift))))
        # 外缘每隔一段深切，形成参差的宽叶；叶尖可保留撕裂后的不对称断面。
        profile = sin(pi * min(t, 0.999)) ** 0.72
        serration = 0.60 if i % 2 == 0 and 0 < i < stations-1 else 1.0
        half_width = width * profile * serration
        left_width = half_width * rng.uniform(0.80, 1.10)
        right_width = half_width * rng.uniform(0.65, 1.08)
        if i == 0:
            left_width = right_width = 0.022
        if i == stations-1:
            left_width, right_width = (0.07, 0.021) if broken else (0.008, 0.008)
        edge_drop = 0.06 * profile
        left = _add(center, _add(_scale(lateral, left_width), (0, 0, -edge_drop)))
        right = _add(center, _add(_scale(lateral, -right_width), (0, 0, -edge_drop * 1.35)))
        top.extend((left, center, right))
        centerline.append(center)
    bottom = [_add(v, (0, 0, -thickness)) for v in top]
    vertices = top + bottom
    offset = len(top)
    faces = []
    for i in range(stations-1):
        a, b = i*3, (i+1)*3
        upper_faces = ((a, a+1, b+1), (a, b+1, b),
                       (a+1, a+2, b+2), (a+1, b+2, b+1))
        faces.extend(upper_faces)
        faces.extend(tuple(index+offset for index in reversed(face)) for face in upper_faces)
        faces.extend(((a, b, b+offset, a+offset),
                      (a+2, a+2+offset, b+2+offset, b+2)))
    # 封口按中央折脊拆分，保留实际厚度并避免边缘形成几何裂口。
    faces.extend(((0, offset, offset+1, 1), (1, offset+1, offset+2, 2),
                  (offset-3, offset-2, 2*offset-2, 2*offset-3),
                  (offset-2, offset-1, 2*offset-1, 2*offset-2)))
    h.mesh(asset, name, vertices, faces, material)
    # 细叶脉比叶面略高，鲜绿宽叶在侧光下仍有清楚的折面脊线。
    ribs = []
    for i, center in enumerate(centerline):
        rib_width = 0.014 * (1 - 0.75 * i / (stations-1))
        ribs.extend((_add(center, _add(_scale(lateral, rib_width), (0, 0, 0.010))),
                     _add(center, _add(_scale(lateral, -rib_width), (0, 0, 0.010)))))
    rib_faces = [(i*2, i*2+1, (i+1)*2+1, (i+1)*2) for i in range(stations-1)]
    h.mesh(asset, name + " central vein", ribs, rib_faces, "leaf_light" if material != "leaf_light" else "olive")


def _palm(h, name, knots, radius, frond_count, seed, frond_length):
    asset = h.asset(name, "environment")
    rng = Random(seed)
    crown = _trunk(h, asset, knots, radius, seed)
    for i in range(frond_count):
        angle = i*2*pi/frond_count + rng.uniform(-0.23, 0.25)
        length = frond_length * rng.uniform(0.64, 1.13)
        leaf_crown = _add(crown, (rng.uniform(-0.06, 0.06), rng.uniform(-0.05, 0.05), rng.uniform(-0.10, 0.09)))
        _frond(h, asset, f"Wild palm frond {i:02d}", leaf_crown, angle, length,
               rng.uniform(0.29, 0.48), rng.uniform(0.14, 0.72), rng.uniform(0.43, 1.26),
               seed + i*13, ("leaf_light", "leaf", "leaf_light", "olive")[i % 4])
    # 少量枯叶柄与椰果围绕冠心分散，避免叶冠像机械排列的叶片集合。
    for i in range(4):
        angle = i*pi/2 + 0.37
        _frond(h, asset, f"Broken brown petiole {i}", _add(crown, (0, 0, -0.13)), angle,
               rng.uniform(0.28, 0.47), 0.07, 0.02, 0.32, seed + 100 + i, "wood_dark")
    for i in range(3):
        angle = i*2.0 + 0.4
        loc = _add(crown, (cos(angle)*0.14, sin(angle)*0.14, -0.25 - i*0.035))
        h.ico(asset, f"Small coconut {i}", loc, (0.10, 0.085, 0.13), "wood_dark", subdivisions=1)
    return asset


def _grass_blade(h, asset, name, origin, angle, height, width, lean, twist, material):
    """草叶是闭合薄实体，纵向弯折后依然保留双侧可见轮廓。"""
    forward = (cos(angle), sin(angle), 0)
    side = (-sin(angle), cos(angle), 0)
    vertices = []
    for fraction, advance, taper in ((0, 0, 1), (0.48, lean*0.2, 0.64)):
        center = _add(origin, _add(_scale(forward, advance), _add(_scale(side, twist*fraction), (0, 0, height*fraction))))
        for lateral, thickness in ((-width*taper/2, -0.003), (width*taper/2, -0.003), (width*taper/2, 0.003), (-width*taper/2, 0.003)):
            vertices.append(_add(center, _add(_scale(side, lateral), _scale(forward, thickness))))
    vertices.append(_add(origin, _add(_scale(forward, lean), _add(_scale(side, twist), (0, 0, height)))))
    faces = [(3, 2, 1, 0), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
             (4, 5, 8), (5, 6, 8), (6, 7, 8), (7, 4, 8)]
    # 截面按厚度方向排列后为顺时针；反转绕序使薄草叶的表面法线朝外。
    h.mesh(asset, name, vertices, [tuple(reversed(face)) for face in faces], material)


def _wild_grass(h):
    asset = h.asset("prop_wild_grass_patch", "environment")
    rng = Random(61927)
    clusters = ((-0.54, -0.24), (-0.18, 0.25), (0.13, -0.11), (0.40, 0.30), (0.61, -0.23), (-0.47, 0.43), (0.05, 0.53))
    for cluster, (x, y) in enumerate(clusters):
        for leaf in range(9):
            angle = rng.uniform(0, 2*pi)
            origin = (x + rng.uniform(-0.07, 0.07), y + rng.uniform(-0.06, 0.06), 0)
            height = rng.uniform(0.76, 1.72) * (1.06 if cluster in (1, 2) else 0.92)
            material = rng.choice(("leaf", "leaf_light", "olive", "olive"))
            _grass_blade(h, asset, f"Tall wild blade {cluster}_{leaf}", origin, angle, height,
                         rng.uniform(0.029, 0.064), rng.uniform(0.16, 0.54), rng.uniform(-0.16, 0.16), material)
    # 边缘的短枯叶丰富荒地轮廓，避免整片野草高度完全一致。
    for i in range(8):
        angle = rng.uniform(0, 2*pi)
        origin = (rng.uniform(-0.60, 0.67), rng.uniform(-0.35, 0.56), 0)
        _grass_blade(h, asset, f"Dry bent blade {i}", origin, angle, rng.uniform(0.32, 0.61),
                     0.039, rng.uniform(0.30, 0.62), 0.05, "gold" if i % 3 == 0 else "olive")
    return asset


def build_tropical(h):
    """生成三种独立不规则棕榈与野草簇；所有根节点位于底部原点。"""
    leaning = ((0, 0, 0), (0.02, 0.015, 0.36), (0.09, 0.04, 1.0),
               (0.30, 0.10, 1.9), (0.63, 0.14, 2.9), (1.04, 0.12, 3.9),
               (1.43, 0.04, 4.85), (1.75, -0.08, 5.65), (1.94, -0.16, 6.05))
    crooked = ((0, 0, 0), (-0.015, 0.035, 0.34), (-0.13, 0.16, 1.02),
               (-0.39, 0.33, 1.95), (-0.72, 0.40, 2.95), (-0.91, 0.24, 3.93),
               (-0.85, 0.03, 4.90), (-0.57, -0.02, 5.73), (-0.22, 0.07, 6.35))
    young = ((0, 0, 0), (0.035, -0.015, 0.30), (0.10, -0.12, 1.1),
             (0.12, -0.33, 2.0), (0.02, -0.51, 2.9), (-0.13, -0.63, 3.9),
             (-0.21, -0.59, 4.70), (-0.13, -0.48, 5.05))
    return [_palm(h, "prop_palm_leaning", leaning, 0.205, 8, 7183, 2.80),
            _palm(h, "prop_palm_crooked", crooked, 0.22, 9, 9257, 2.56),
            _palm(h, "prop_palm_young", young, 0.165, 7, 4327, 2.18),
            _wild_grass(h)]
