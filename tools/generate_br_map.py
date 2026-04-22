"""
Battle Royale Map Generator for Blender (Simple Version)
=========================================================
Run in Blender: File > Scripting > Open > Run Script
Generates a flat ground with simple box houses spread across.
No ramps, no elevation. Pure navmesh-friendly geometry.
"""

import bpy
import math
import random

SEED = 42
MAP_SIZE = 200  # half-extent → 400x400
WALL_H = 3.0
WALL_THICK = 0.2
FLOOR_H = 0.1
DOOR_W = 2.0
DOOR_H = 2.5

random.seed(SEED)


# ─── HELPERS ──────────────────────────────────────────────────────────
def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)


def get_col(name):
    if name in bpy.data.collections:
        return bpy.data.collections[name]
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def box(name, loc, sx, sy, sz, col, mat=None):
    """Box centered at loc, with full extents sx, sy, sz."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(
        loc[0], loc[1], loc[2] + sz / 2))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(scale=True)
    for c in obj.users_collection:
        c.objects.unlink(obj)
    col.objects.link(obj)
    if mat:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    return obj


def make_mat(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs[0].default_value = (*rgb, 1)
    return m


def wall_with_door(prefix, cx, cy, cz, total_w, facing, col, mat):
    """
    Build a wall segment with a centered door opening.
    facing: 'x' means wall runs along X axis, 'y' along Y axis.
    """
    half = total_w / 2
    door_half = DOOR_W / 2

    if facing == 'y':
        # Wall runs along Y. Two side pieces + lintel above door.
        side_w = (total_w - DOOR_W) / 2
        # Left piece
        box(f"{prefix}_L",
            (cx, cy - half + side_w / 2, cz),
            WALL_THICK, side_w, WALL_H, col, mat)
        # Right piece
        box(f"{prefix}_R",
            (cx, cy + half - side_w / 2, cz),
            WALL_THICK, side_w, WALL_H, col, mat)
        # Lintel
        box(f"{prefix}_T",
            (cx, cy, cz + DOOR_H),
            WALL_THICK, DOOR_W, WALL_H - DOOR_H, col, mat)
    else:
        side_w = (total_w - DOOR_W) / 2
        box(f"{prefix}_L",
            (cx - half + side_w / 2, cy, cz),
            side_w, WALL_THICK, WALL_H, col, mat)
        box(f"{prefix}_R",
            (cx + half - side_w / 2, cy, cz),
            side_w, WALL_THICK, WALL_H, col, mat)
        box(f"{prefix}_T",
            (cx, cy, cz + DOOR_H),
            DOOR_W, WALL_THICK, WALL_H - DOOR_H, col, mat)


# ─── HOUSE TYPES ─────────────────────────────────────────────────────
def house_small(cx, cy, col, mats, tag):
    """Small 6x6 single-room house, door on south face."""
    w, d = 6, 6
    p = f"SmH_{tag}"
    # Floor
    box(f"{p}_floor", (cx, cy, 0), w, d, FLOOR_H, col, mats['floor'])
    # North wall (solid)
    box(f"{p}_wN", (cx, cy + d/2, 0), w, WALL_THICK, WALL_H, col, mats['wall'])
    # East wall (solid)
    box(f"{p}_wE", (cx + w/2, cy, 0), WALL_THICK, d, WALL_H, col, mats['wall'])
    # West wall (solid)
    box(f"{p}_wW", (cx - w/2, cy, 0), WALL_THICK, d, WALL_H, col, mats['wall'])
    # South wall (door)
    wall_with_door(f"{p}_wS", cx, cy - d/2, 0, w, 'x', col, mats['wall'])


def house_medium(cx, cy, col, mats, tag):
    """Medium 10x8 house, doors on south and east."""
    w, d = 10, 8
    p = f"MdH_{tag}"
    box(f"{p}_floor", (cx, cy, 0), w, d, FLOOR_H, col, mats['floor'])
    # North (solid)
    box(f"{p}_wN", (cx, cy + d/2, 0), w, WALL_THICK, WALL_H, col, mats['wall'])
    # West (solid)
    box(f"{p}_wW", (cx - w/2, cy, 0), WALL_THICK, d, WALL_H, col, mats['wall'])
    # South (door)
    wall_with_door(f"{p}_wS", cx, cy - d/2, 0, w, 'x', col, mats['wall'])
    # East (door)
    wall_with_door(f"{p}_wE", cx + w/2, cy, 0, d, 'y', col, mats['wall'])
    # Internal divider wall (half-length, no door) for cover
    box(f"{p}_div", (cx, cy, 0), WALL_THICK, d * 0.4, WALL_H, col, mats['wall'])


def house_large(cx, cy, col, mats, tag):
    """Large 14x10 warehouse-style, big opening on south."""
    w, d = 14, 10
    p = f"LgH_{tag}"
    box(f"{p}_floor", (cx, cy, 0), w, d, FLOOR_H, col, mats['floor'])
    # North
    box(f"{p}_wN", (cx, cy + d/2, 0), w, WALL_THICK, WALL_H, col, mats['wall2'])
    # West
    box(f"{p}_wW", (cx - w/2, cy, 0), WALL_THICK, d, WALL_H, col, mats['wall2'])
    # East (door)
    wall_with_door(f"{p}_wE", cx + w/2, cy, 0, d, 'y', col, mats['wall2'])
    # South — wide 4m opening
    gap = 4
    side = (w - gap) / 2
    box(f"{p}_wS_L", (cx - w/2 + side/2, cy - d/2, 0),
        side, WALL_THICK, WALL_H, col, mats['wall2'])
    box(f"{p}_wS_R", (cx + w/2 - side/2, cy - d/2, 0),
        side, WALL_THICK, WALL_H, col, mats['wall2'])
    # Two internal pillars for cover
    box(f"{p}_pil1", (cx - 3, cy, 0), 0.6, 0.6, WALL_H, col, mats['wall2'])
    box(f"{p}_pil2", (cx + 3, cy, 0), 0.6, 0.6, WALL_H, col, mats['wall2'])


def house_lshape(cx, cy, col, mats, tag):
    """L-shaped house from two overlapping rectangles, doors on exposed faces."""
    p = f"LsH_{tag}"
    # Part A: 8x6 on the left
    ax, ay = cx - 3, cy
    aw, ad = 8, 6
    box(f"{p}_A_floor", (ax, ay, 0), aw, ad, FLOOR_H, col, mats['floor'])
    box(f"{p}_A_wN", (ax, ay + ad/2, 0), aw, WALL_THICK, WALL_H, col, mats['wall'])
    box(f"{p}_A_wW", (ax - aw/2, ay, 0), WALL_THICK, ad, WALL_H, col, mats['wall'])
    wall_with_door(f"{p}_A_wS", ax, ay - ad/2, 0, aw, 'x', col, mats['wall'])

    # Part B: 6x8 on the right-front
    bx, by = cx + 4, cy - 3
    bw, bd = 6, 8
    box(f"{p}_B_floor", (bx, by, 0), bw, bd, FLOOR_H, col, mats['floor'])
    box(f"{p}_B_wE", (bx + bw/2, by, 0), WALL_THICK, bd, WALL_H, col, mats['wall'])
    wall_with_door(f"{p}_B_wS", bx, by - bd/2, 0, bw, 'x', col, mats['wall'])
    box(f"{p}_B_wN", (bx, by + bd/2, 0), bw, WALL_THICK, WALL_H, col, mats['wall'])
    # East wall of A connecting to B
    conn_len = ad/2 - (bd/2 - 3)
    box(f"{p}_conn", (ax + aw/2, ay + ad/2 - conn_len/2, 0),
        WALL_THICK, conn_len, WALL_H, col, mats['wall'])


# ─── MAP GENERATION ──────────────────────────────────────────────────
def generate_map():
    clear_scene()

    col = get_col("Map")
    mats = {
        'ground': make_mat("M_Ground", (0.28, 0.38, 0.18)),
        'floor':  make_mat("M_Floor",  (0.50, 0.45, 0.40)),
        'wall':   make_mat("M_Wall",   (0.62, 0.58, 0.52)),
        'wall2':  make_mat("M_Wall2",  (0.55, 0.50, 0.45)),
    }

    # Ground plane
    bpy.ops.mesh.primitive_plane_add(size=MAP_SIZE * 2, location=(0, 0, 0))
    gnd = bpy.context.active_object
    gnd.name = "Ground"
    for c in gnd.users_collection:
        c.objects.unlink(gnd)
    col.objects.link(gnd)
    gnd.data.materials.append(mats['ground'])

    # ── House placement list: (x, y, type) ──
    houses = [
        # Central cluster
        (0, 0, 'medium'),
        (15, 5, 'small'),
        (-12, -8, 'small'),
        (8, -18, 'large'),
        (-18, 12, 'lshape'),

        # NE cluster
        (60, 55, 'large'),
        (75, 65, 'small'),
        (50, 70, 'medium'),

        # NW cluster
        (-55, 60, 'medium'),
        (-70, 50, 'small'),
        (-65, 75, 'small'),

        # SE cluster
        (65, -55, 'lshape'),
        (50, -65, 'small'),
        (80, -60, 'small'),

        # SW cluster
        (-60, -60, 'large'),
        (-50, -75, 'small'),
        (-75, -50, 'medium'),

        # Far N
        (10, 120, 'medium'),
        (-15, 130, 'small'),

        # Far S
        (-10, -120, 'lshape'),
        (15, -130, 'small'),

        # Far E
        (120, 10, 'large'),
        (130, -15, 'small'),

        # Far W
        (-120, -10, 'medium'),
        (-130, 15, 'small'),

        # Scattered singles
        (40, 20, 'small'),
        (-35, -30, 'small'),
        (25, -40, 'small'),
        (-20, 45, 'small'),
        (90, 90, 'small'),
        (-90, -90, 'small'),
        (95, -30, 'medium'),
        (-95, 35, 'small'),
    ]

    builders = {
        'small':  house_small,
        'medium': house_medium,
        'large':  house_large,
        'lshape': house_lshape,
    }

    for i, (hx, hy, htype) in enumerate(houses):
        builders[htype](hx, hy, col, mats, i)

    # ── Sun + Camera ──
    bpy.ops.object.light_add(type='SUN', location=(50, 50, 80))
    sun = bpy.context.active_object
    sun.name = "Sun"
    sun.data.energy = 3
    sun.rotation_euler = (math.radians(45), 0, math.radians(45))

    bpy.ops.object.camera_add(location=(0, -200, 150))
    cam = bpy.context.active_object
    cam.name = "MapCamera"
    cam.rotation_euler = (math.radians(50), 0, 0)
    bpy.context.scene.camera = cam

    print("=" * 40)
    print(f"Map generated: {len(houses)} houses on {MAP_SIZE*2}x{MAP_SIZE*2} flat terrain")
    print("Export: File > Export > glTF 2.0 (.glb)")
    print("=" * 40)


if __name__ == "__main__":
    generate_map()
