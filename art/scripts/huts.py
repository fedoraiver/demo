"""荒岛居民木屋：错位木板、褪漆门窗与局部修补屋顶，保持可使用的结构。"""

from math import pi
from random import Random


WOOD = ("weathered_wood", "weathered_wood", "weathered_dark", "wood_gray")


def _clear_intervals(start, end, holes):
    """门窗占据真实开口，不用黑色贴片覆盖完整墙面。"""
    intervals = [(start, end)]
    for left, right in holes:
        remaining = []
        for a, b in intervals:
            if right <= a or left >= b:
                remaining.append((a, b))
            else:
                if a < left:
                    remaining.append((a, left))
                if right < b:
                    remaining.append((right, b))
        intervals = remaining
    return intervals


def _planks(h, asset, name, start, end, z, fixed, front, rng, paint, damaged=False):
    """每段木板独立变色和轻微错位；破损集中在边缘，不削弱整面结构。"""
    cursor, index = start, 0
    while cursor < end - 0.05:
        width = min(rng.uniform(0.77, 1.40), end-cursor)
        gap = rng.uniform(0.007, 0.015)
        material = rng.choice(WOOD + (paint,) if rng.random() < 0.22 else WOOD)
        center = (cursor + width/2, fixed, z) if front else (fixed, cursor + width/2, z)
        size = (max(0.03, width-gap), 0.065, 0.169) if front else (0.065, max(0.03, width-gap), 0.169)
        # 局部缩短和下垂露出暗梁，仍保留墙面的主要防护。
        if damaged and index == 0:
            size = (size[0], size[1], 0.108)
            center = (center[0], center[1], center[2]-0.027)
        rotation = (0, rng.uniform(-0.012, 0.012), 0) if front else (rng.uniform(-0.012, 0.012), 0, 0)
        h.box(asset, f"{name} plank {index}", center, size, material, rotation=rotation)
        cursor += width
        index += 1


def _walls(h, asset, width, depth, rng, paint, door_x, window_x):
    door = (door_x-0.53, door_x+0.53, 0.18, 2.35)
    window = (window_x-0.60, window_x+0.60, 1.19, 2.18)
    for row in range(14):
        z = 0.265 + row*0.182
        holes = [(a,b) for a,b,bottom,top in (door,window) if bottom-0.08 < z < top+0.08]
        for interval, (start, end) in enumerate(_clear_intervals(-width/2, width/2, holes)):
            _planks(h, asset, f"Front row {row} part {interval}", start, end, z,
                    -depth/2, True, rng, paint, damaged=row in (2, 11))
        _planks(h, asset, f"Rear row {row}", -width/2, width/2, z, depth/2, True, rng, paint, damaged=row == 4)
        for side in (-1,1):
            openings = [(-0.27,0.81)] if side == 1 and 1.21 < z < 2.21 else []
            for interval, (start,end) in enumerate(_clear_intervals(-depth/2,depth/2,openings)):
                _planks(h, asset, f"Side {side} row {row} part {interval}", start,end,z,
                        side*width/2,False,rng,paint,damaged=row == 8 and side == -1)
    # 接缝后藏有框架，部分缺损木板露出内部的深色支撑。
    for side in (-1,1):
        h.box(asset,f"Rear inner support {side}",(side*1.2,depth/2-0.06,1.45),(0.12,0.11,2.54),"weathered_dark")
        h.beam(asset,f"Side inner diagonal {side}",(side*(width/2-0.05),-depth/2+0.16,0.27),
               (side*(width/2-0.05),depth/2-0.16,2.48),0.10,"weathered_dark")


def _window_front(h, asset, x, y, paint, rng):
    z, width, height = 1.685, 1.13, 0.93
    h.box(asset,"Front window deep shadow",(x,y+0.10,z),(width,0.018,height),"ink")
    h.box(asset,"Front window dull glass",(x,y+0.064,z),(width-0.11,0.018,height-0.09),"glass")
    for side in (-1,1):
        h.box(asset,f"Front window crooked jamb {side}",(x+side*width/2,y-0.046,z),
              (0.085,0.135,height+0.18),"wood_gray",rotation=(0,side*0.013,0))
        h.box(asset,f"Front window horizontal frame {side}",(x,y-0.052,z+side*height/2),
              (width+0.16,0.12,0.078),"weathered_wood",rotation=(0,0.011,0))
    h.box(asset,"Front window center bar",(x+0.026,y-0.064,z),(0.046,0.12,height),"weathered_dark",rotation=(0,0.02,0))
    h.box(asset,"Front window chipped sill",(x-0.02,y-0.10,z-height/2-0.052),(width+0.27,0.28,0.075),"wood_gray")
    # 一侧百叶缺掉一片，另一侧只剩固定板与褪漆木板。
    for side in (-1,1):
        sx = x+side*0.81
        h.box(asset,f"Shutter brace {side}",(sx,y-0.038,z),(0.083,0.07,1.01),"weathered_dark")
        for plank in range(5):
            if side == -1 and plank == 3:
                continue
            h.box(asset,f"Old shutter {side} plank {plank}",(sx,y-0.10,z-0.4+plank*0.2),
                  (0.45 if plank != 1 else 0.37,0.072,0.178),paint if plank%3 else "wood_gray",
                  rotation=(0,rng.uniform(-0.035,0.035),side*0.02))


def _window_side(h, asset, x, y, paint):
    z = 1.70
    h.box(asset,"Side window interior",(x-0.07,y,z),(0.018,1.0,0.91),"ink")
    h.box(asset,"Side window dull panes",(x-0.035,y,z),(0.018,0.9,0.79),"glass")
    for side in (-1,1):
        h.box(asset,f"Side window upright {side}",(x+0.034,y+side*0.49,z),(0.14,0.072,1.03),"wood_gray")
        h.box(asset,f"Side window lintel {side}",(x+0.038,y,z+side*0.455),(0.14,1.1,0.07),paint)
    h.box(asset,"Side window center mullion",(x+0.04,y,z),(0.14,0.045,0.91),"weathered_dark")
    h.box(asset,"Side window sill",(x+0.11,y,z-0.51),(0.29,1.2,0.085),"wood_gray")


def _door(h, asset, x, y, paint, rng):
    h.box(asset,"Door inner dark recess",(x,y+0.08,1.265),(1.01,0.018,2.14),"ink")
    for plank in range(6):
        sx = x-0.43+plank*0.173
        height = 2.00 - (0.036 if plank == 1 else 0)
        h.box(asset,f"Door faded board {plank}",(sx,y-0.007,0.20+height/2),
              (0.164,0.075,height),paint if plank%3 else "weathered_wood",
              rotation=(0,rng.uniform(-0.007,0.007),0))
    for sign in (-1,1):
        h.box(asset,f"Door skewed upright {sign}",(x+sign*0.585,y-0.045,1.29),
              (0.115,0.14,2.25),"weathered_dark",rotation=(0,-0.013,0))
        h.box(asset,f"Door old hinge {sign}",(x-0.44,y-0.066,1.18+sign*0.67),
              (0.21,0.025,0.047),"rust")
    h.box(asset,"Door mismatched lintel",(x+0.026,y-0.05,2.43),(1.35,0.16,0.13),"wood_gray",rotation=(0,0.018,0))
    h.box(asset,"Door lower crossbar",(x,y-0.06,0.64),(0.92,0.058,0.10),"weathered_dark")
    h.box(asset,"Door upper crossbar",(x,y-0.06,1.78),(0.92,0.058,0.10),"weathered_dark")
    h.beam(asset,"Door diagonal stiffener",(x-0.4,y-0.10,0.65),(x+0.4,y-0.10,1.78),0.075,"weathered_wood")
    h.box(asset,"Door iron latch",(x+0.31,y-0.11,1.14),(0.08,0.03,0.14),"rust")
    h.box(asset,"Door pull",(x+0.31,y-0.14,1.14),(0.034,0.035,0.073),"metal")
    # 门槛保持与地板顶面一致，后续游戏接入无需为居民屋另调角色高度。
    h.box(asset,"Door threshold",(x,y-0.11,0.147),(1.25,0.4,0.066),"weathered_wood")


def _roof_panel(h, asset, name, x0, x1, y0, y1, height_at, material, lift=0):
    vertices = [(x0,y0,height_at(x0)+lift),(x1,y0,height_at(x1)+lift),
                (x1,y1,height_at(x1)+lift),(x0,y1,height_at(x0)+lift)]
    vertices += [(x,y,z-0.045) for x,y,z in vertices]
    faces = [(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
    h.mesh(asset,name,vertices,faces,material)


def _roof(h, asset, width, depth, ridge_x, ridge_z, rng, paint):
    left, right = -width/2-0.21, width/2+0.21
    left_z, right_z = 2.65, 2.73
    def height_at(x):
        if x <= ridge_x:
            return left_z + (ridge_z-left_z)*(x-left)/(ridge_x-left)
        return ridge_z + (right_z-ridge_z)*(x-ridge_x)/(right-ridge_x)
    # 小木瓦逐片搭接；只留轻微参差，保证屋顶主体仍能遮雨。
    for side,(start,end) in enumerate(((left,ridge_x),(ridge_x,right))):
        for row in range(7):
            y0 = -depth/2-0.21 + row*(depth+0.42)/7
            y1 = y0+(depth+0.42)/7+0.028
            for tile in range(4):
                x0 = start+(end-start)*tile/4
                x1 = start+(end-start)*(tile+1)/4+0.017
                if side == 0 and row == 1 and tile == 0:
                    x0 += 0.13
                material = rng.choice(("weathered_dark","weathered_wood","wood_gray"))
                _roof_panel(h,asset,f"Roof wooden shingle {side}_{row}_{tile}",x0,x1,y0,y1,height_at,material,lift=0.025)
    for side in (-1,1):
        y = side*(depth/2+0.14)
        h.beam(asset,f"Roof left rafter {side}",(left,y,left_z-0.035),(ridge_x,y,ridge_z-0.035),0.105,"weathered_dark")
        h.beam(asset,f"Roof right rafter {side}",(ridge_x,y,ridge_z-0.035),(right,y,right_z-0.035),0.105,"weathered_dark")
    h.beam(asset,"Roof ridge weathered cap",(ridge_x,-depth/2-0.23,ridge_z+0.02),
           (ridge_x,depth/2+0.23,ridge_z+0.02),0.085,"weathered_dark")
    patches = ((left+0.25,left+1.34,-0.8,0.21),(ridge_x+0.48,right-0.13,0.35,1.43))
    for patch,(x0,x1,y0,y1) in enumerate(patches):
        _roof_panel(h,asset,f"Roof old iron repair {patch}",x0,x1,y0,y1,height_at,"rust" if patch else "roof",lift=0.092)
        for rib in range(5):
            y = y0+(y1-y0)*(rib+0.5)/5
            h.beam(asset,f"Roof corrugated patch {patch} rib {rib}",(x0,y,height_at(x0)+0.107),
                   (x1,y,height_at(x1)+0.107),0.022,"rust")
    # 前后山墙也用短木板收口，不以单块纯色三角形替代木板立面。
    for end in (-1,1):
        for row in range(6):
            z = 2.75+row*0.17
            if z >= ridge_z-0.035:
                continue
            x0 = left+(ridge_x-left)*(z-left_z)/(ridge_z-left_z)
            x1 = ridge_x+(right-ridge_x)*(ridge_z-z)/(ridge_z-right_z)
            _planks(h,asset,f"Gable {end} row {row}",x0,x1,z,end*depth/2,True,rng,paint)


def _hut(h, name, width, depth, ridge_x, ridge_z, paint, seed):
    asset = h.asset(name,"buildings")
    rng = Random(seed)
    for x in (-width/2+0.25,0,width/2-0.25):
        for y in (-depth/2+0.27,depth/2-0.27):
            h.box(asset,f"Hut grounded support {x}_{y}",(x,y,0.055),(0.32,0.32,0.11),"weathered_dark")
    for y in (-depth/2+0.14,0,depth/2-0.14):
        h.box(asset,f"Hut floor joist {y}",(0,y,0.11),(width,0.14,0.12),"weathered_dark")
    for row in range(22):
        y = -depth/2+(row+0.5)*depth/22
        h.box(asset,f"Hut floor board {row}",(0,y,0.14),(width,depth/22-0.008,0.08),rng.choice(WOOD))
    for x in (-width/2,width/2):
        for y in (-depth/2,depth/2):
            h.box(asset,f"Hut corner post {x}_{y}",(x,y,1.45),(0.155,0.155,2.54),"weathered_dark",rotation=(0,-0.012 if x<0 else 0.009,0))
    for y in (-depth/2,depth/2):
        h.box(asset,f"Hut horizontal wall beam {y}",(0,y,0.22),(width+0.08,0.10,0.12),"weathered_dark")
        h.box(asset,f"Hut upper wall beam {y}",(0,y,2.65),(width+0.08,0.11,0.14),"weathered_dark")
    door_x, window_x = -0.91, 1.05
    _walls(h,asset,width,depth,rng,paint,door_x,window_x)
    _window_front(h,asset,window_x,-depth/2,paint,rng)
    _window_side(h,asset,width/2,0.27,paint)
    _door(h,asset,door_x,-depth/2,paint,rng)
    _roof(h,asset,width,depth,ridge_x,ridge_z,rng,paint)
    # 墙脚保留少量不齐的补板，表现长期使用后的现场修补。
    h.box(asset,"Lower patched board",(-1.9,-depth/2-0.053,0.6),(0.82,0.065,0.143),"wood_gray",rotation=(0,-0.027,0))
    h.box(asset,"Peeling paint replacement plank",(0.04,-depth/2-0.047,2.56),(0.63,0.068,0.147),paint,rotation=(0,0.024,0))
    return asset


def build_huts(h):
    """生成两座单层风化居民木屋；地板顶为 0.18 米，建筑正面朝 -Y。"""
    return [_hut(h,"bld_residential_a",4.95,3.95,0.12,3.71,"faded_blue",8419),
            _hut(h,"bld_residential_b",4.78,4.08,-0.18,3.67,"faded_olive",5623)]
