"""Build the realistic boxer GLB (body + kit, skeleton, no animation).

Run through tools/blender/build.mjs (npm run asset:boxer) or directly:
  Blender --background --python tools/blender/build_boxer.py -- <out.glb> [skin_dark.webp out]

Needs the MPFB extension installed in Blender and the MakeHuman system assets pack copied into the
MPFB user data dir (see docs/ASSETS.md). Everything that ships is MPFB / MakeHuman CC0 output plus
geometry and texture work done here: trunks, boots and gloves are modelled from scratch (fitted to the
measured body), the six-pack / pec definition, scalp stubble and skin normal map are procedural.
Writes next to the glb: skin_dark.webp (second tone) and skin_normal.webp (shared normal map).
"""
import sys, os, math, json, struct
import numpy as np
import bpy, bmesh, addon_utils
from mathutils import Vector, kdtree

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "/tmp/boxer.glb"
OUT_DIR = os.path.dirname(OUT)
SUFFIX = argv[2] if len(argv) > 2 else ""      # every texture file is <name><SUFFIX>.webp (boxer_v2 -> "_v2")
TAU = 2 * math.pi
KIT_TEX = 1024                 # kit detail textures (gloves, trunks, boots), px
LABEL_WORD = "IRONJAW"         # invented maker's mark on the glove and trunks labels (no real brand)

# ---- tunables (this is the one place the look of the body is set) ----
MACRO = {"gender": 1.0, "age": 0.5, "muscle": 0.95, "weight": 0.30, "proportions": 0.5, "height": 0.52}
DETAILS = {  # MPFB target name -> weight
    "torso-vshape-incr": 1.0,
    "torso-muscle-pectoral-incr": 0.85,
    "torso-muscle-dorsi-incr": 0.9,
    "torso-scale-depth-decr": 0.10,
    "torso-scale-horiz-incr": 0.25,
    "measure-waist-circ-decr": 0.5,
    "measure-shoulder-dist-incr": 0.6,
    "neck-scale-horiz-incr": 0.65,
    "neck-scale-vert-decr": 0.10,
    "l-upperarm-muscle-incr": 0.8, "r-upperarm-muscle-incr": 0.8,
    "l-upperarm-shoulder-muscle-incr": 1.0, "r-upperarm-shoulder-muscle-incr": 1.0,
    "l-lowerarm-muscle-incr": 0.8, "r-lowerarm-muscle-incr": 0.8,
    "l-upperleg-muscle-incr": 0.55, "r-upperleg-muscle-incr": 0.55,
    "l-lowerleg-muscle-incr": 0.6, "r-lowerleg-muscle-incr": 0.6,
    "head-scale-vert-incr": 0.3, "head-scale-horiz-incr": 0.2, "head-scale-depth-incr": 0.2,   # ~7.4 heads tall
    # a weathered fighter's face: heavy brow ridge, deep-set narrowed eyes, mouth corners down (scowl)
    "eyebrows-trans-forward": 0.7, "eyebrows-trans-down": 0.35, "eyebrows-angle-down": 0.45,
    "forehead-nubian-incr": 0.45, "forehead-temple-decr": 0.3,
    "l-eye-push1-in": 0.5, "r-eye-push1-in": 0.5, "l-eye-height1-decr": 0.35, "r-eye-height1-decr": 0.35,
    "l-eye-bag-incr": 0.35, "r-eye-bag-incr": 0.35,
    "mouth-angles-down": 0.55, "mouth-laugh-lines-out": 0.5, "mouth-lowerlip-ext-down": 0.35,
}
SKIN_TEX = "skins/young_caucasian_male/young_lightskinned_male_diffuse.png"
SKIN_TEX_DARK = "skins/young_african_male/young_darkskinned_male_diffuse.png"
TEX_SIZE = 2048
DARK_TARGET_MEAN = 0.30     # sRGB-encoded mean the dark diffuse is lifted to (the pack's own file is ~black under our lights)
LIGHT_TARGET_MEAN = 0.0     # 0 = leave the light diffuse alone
STUBBLE_RGB = (0.060, 0.046, 0.038)   # sRGB, scalp painted under the cap (close to the cap colour)
HAIR_STRENGTH = 0.9
# muscle relief, metres of height (drives the normal map; geometry gets GEO_FRAC of it)
AB_DEPTH, AB_BULGE = 0.0024, 0.0034
PEC_DEPTH = 0.0030
GEO_FRAC = 0.55
NORMAL_STRENGTH = 1.0
PORE_AMP = 0.00014

mod = "bl_ext.user_default.mpfb"
addon_utils.enable(mod, default_set=False, persistent=False)
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.locationservice import LocationService

USER_DATA = LocationService.get_user_data()
print("USER_DATA", USER_DATA)

# flat colour management so nothing we save gets tone-mapped
bpy.context.scene.view_settings.view_transform = "Standard"
bpy.context.scene.view_settings.look = "None"

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)


def select_only(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def sstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


# ---- texture helpers (all generated here; arrays are rows = v from the bottom, cols = u) ----
def tnoise(n, f_lo, f_hi, seed, ax=1.0, ay=1.0):
    """Tileable band-limited noise on an n x n grid, unit std. f in cycles per tile. ax > 1 stretches features
    along u (squeezes the u frequencies), ay > 1 along v."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((n, n))
    fy = np.fft.fftfreq(n)[:, None] * n * ay
    fx = np.fft.fftfreq(n)[None, :] * n * ax
    r = np.hypot(fx, fy)
    band = smoothstep(f_lo * 0.6, f_lo, r) * (1 - smoothstep(f_hi, f_hi * 1.5, r))
    out = np.real(np.fft.ifft2(np.fft.fft2(w) * band))
    return (out / (out.std() + 1e-12)).astype(np.float32)


def ridged(nz, sharp=5.0):
    """1 on the zero crossings of a noise field, falling off fast: crease lines."""
    return np.clip(1.0 - np.abs(nz) * 0.6, 0, 1) ** sharp


def h2n(H, su, sv, strength=1.0):
    """Tangent-space normal map from a height field H (metres); su / sv metres per texel along u / v
    (broadcastable). Same convention as the skin normal map."""
    gx = (np.roll(H, -1, 1) - np.roll(H, 1, 1)) * 0.5 / su
    gy = (np.roll(H, -1, 0) - np.roll(H, 1, 0)) * 0.5 / sv
    nx, ny = -gx * strength, -gy * strength
    ln = np.sqrt(nx * nx + ny * ny + 1.0)
    return np.stack([nx / ln * 0.5 + 0.5, ny / ln * 0.5 + 0.5, 1.0 / ln * 0.5 + 0.5, np.ones_like(ln)], -1)


def grey4(g):
    g = np.clip(g, 0, 1).astype(np.float32)
    return np.stack([g, g, g, np.ones_like(g)], -1)


def save_tex(name, arr, colorspace):
    """arr: (h, w, 4) floats. Written as public/fighter/<name><SUFFIX>.webp; returns the Blender image."""
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name + SUFFIX, w, h, alpha=False)
    img.colorspace_settings.name = colorspace
    img.pixels.foreach_set(np.clip(arr, 0, 1).astype(np.float32).ravel())
    img.file_format = "WEBP"
    img.filepath_raw = os.path.join(OUT_DIR, name + SUFFIX + ".webp")
    img.save()
    print("TEX", name + SUFFIX, w, h)
    return img


FONT = {  # 5 x 7 block letters, top row first
    "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "J": ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
}


def label_texture(w=512, h=256):
    """Cream woven label: border, the maker's word in heavy block letters, a rule, grime. Returns (h, w, 4)."""
    img = np.zeros((h, w), np.float32)   # ink coverage, top row first
    word = LABEL_WORD
    cell = int(min((w * 0.84) / (len(word) * 6 - 1), (h * 0.5) / 7))
    tw, th = cell * (len(word) * 6 - 1), cell * 7
    x0, y0 = (w - tw) // 2, int(h * 0.18)
    for li, ch in enumerate(word):
        for ry, row in enumerate(FONT[ch]):
            for rx, bit in enumerate(row):
                if bit == "1":
                    xs = x0 + (li * 6 + rx) * cell
                    ys = y0 + ry * cell
                    img[ys:ys + cell, xs:xs + cell] = 1.0
    img[int(h * 0.80):int(h * 0.80) + max(3, cell // 2), x0:x0 + tw] = 1.0
    b = max(4, h // 28)
    img[b:2 * b, b:w - b] = img[h - 2 * b:h - b, b:w - b] = 1.0
    img[b:h - b, b:2 * b] = img[b:h - b, w - 2 * b:w - b] = 1.0
    for _ in range(2):
        img = (img + np.roll(img, 1, 0) + np.roll(img, -1, 0) + np.roll(img, 1, 1) + np.roll(img, -1, 1)) / 5
    rng = np.random.default_rng(31)
    grime = np.clip(rng.standard_normal((h, w)) * 0.04, -0.08, 0.08)
    yy = np.linspace(-1, 1, h)[:, None]
    xx = np.linspace(-1, 1, w)[None, :]
    edge = np.clip(np.maximum(np.abs(xx), np.abs(yy)) - 0.75, 0, 1) * 0.5
    paper = np.array([0.86, 0.83, 0.76], np.float32) * (1 - edge[..., None]) + grime[..., None]
    ink = np.array([0.07, 0.07, 0.09], np.float32)
    rgb = paper * (1 - img[..., None]) + ink * img[..., None]
    rgb = np.flipud(rgb)                 # Blender rows are bottom-up
    return np.concatenate([rgb, np.ones((h, w, 1), np.float32)], -1)


# ---- 1. body ----
macro = TargetService.get_default_macro_info_dict()
macro.update(MACRO)
macro["race"] = {"asian": 0.0, "caucasian": 1.0, "african": 0.0}
base = HumanService.create_human(macro_detail_dict=macro)
for name, w in DETAILS.items():
    if w == 0.0:
        continue
    path = TargetService.target_full_path(name)
    if not path:
        print("MISSING TARGET", name)
        continue
    TargetService.load_target(base, path, weight=w)

rig = HumanService.add_builtin_rig(base, "mixamo")
rig.name = "Armature"
base.name = "Body"
base.data.name = "Body"
W = rig.matrix_world.copy()
INV = W.inverted()
ZOFF = rig.location.z

parts = {}
for key, rel, atype in [("Eyes", "eyes/high-poly/high-poly.mhclo", "Eyes"),
                        ("Brows", "eyebrows/eyebrow001/eyebrow001.mhclo", "Eyebrows"),
                        ("Lashes", "eyelashes/eyelashes01/eyelashes01.mhclo", "Eyelashes")]:
    o = HumanService.add_mhclo_asset(os.path.join(USER_DATA, rel), base, asset_type=atype, material_type="GAMEENGINE",
                                     subdiv_levels=0)
    o.name = key
    o.data.name = key
    parts[key] = o

select_only(base)
bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
for m in list(base.modifiers):
    if m.type == "MASK":
        bpy.ops.object.modifier_apply(modifier=m.name)
print("body after mask", len(base.data.vertices), tris(base))

BONE_PREFIX = "mixamorig:"
bone_names = set(b.name for b in rig.data.bones)
bones = rig.data.bones


def bw(name):
    return W @ bones[BONE_PREFIX + name].head_local


def dominant(me_obj):
    names = {g.index: g.name for g in me_obj.vertex_groups if g.name in bone_names}
    out = []
    for v in me_obj.data.vertices:
        best, bwt = None, 0.0
        for ge in v.groups:
            if ge.group in names and ge.weight > bwt:
                best, bwt = names[ge.group], ge.weight
        out.append(best)
    return out


ARM_BONES = set(BONE_PREFIX + s + n for s in ("Left", "Right") for n in
                ("Shoulder", "Arm", "ForeArm", "Hand", "HandIndex1", "HandIndex2", "HandIndex3", "HandMiddle1",
                 "HandMiddle2", "HandMiddle3", "HandRing1", "HandRing2", "HandRing3", "HandPinky1", "HandPinky2",
                 "HandPinky3", "HandThumb1", "HandThumb2", "HandThumb3"))
FOOT_BONES = set(BONE_PREFIX + s + n for s in ("Left", "Right") for n in ("Foot", "ToeBase"))

# ---- measure the body ----
dom = dominant(base)
Vw = np.array([tuple(W @ v.co) for v in base.data.vertices], dtype=np.float64)
is_arm = np.array([d in ARM_BONES for d in dom])
is_foot = np.array([d in FOOT_BONES for d in dom])
is_head = np.array([d == BONE_PREFIX + "Head" for d in dom])
print("HEIGHT %.3f" % Vw[:, 2].max())
for bn in ("Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
           "LeftHandMiddle1", "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"):
    h = bw(bn)
    print("JOINT %-16s %.3f %.3f %.3f" % (bn, h.x, h.y, h.z))
hips_z, knee_z, ankle_z = bw("Hips").z, bw("LeftLeg").z, bw("LeftFoot").z
sp_z, sp1_z, sp2_z, neck_z = bw("Spine").z, bw("Spine1").z, bw("Spine2").z, bw("Neck").z
tx = 0.0
ty = float(np.mean(Vw[(~is_arm) & (np.abs(Vw[:, 2] - sp1_z) < 0.03), 1]))   # torso centre in y

# which way is "front": eyes sit in front of the head centre
eyes_co = np.array([tuple(parts["Eyes"].matrix_world @ v.co) for v in parts["Eyes"].data.vertices])
skull = Vw[is_head & (Vw[:, 2] > float(eyes_co[:, 2].mean()) - 0.04)]
head_c = np.array([0.0, (skull[:, 1].min() + skull[:, 1].max()) / 2, 0.0])   # skull centre in y (mean of all head verts is dragged by the face)
FY = 1.0 if eyes_co[:, 1].mean() > head_c[1] else -1.0
EYE_Z = float(eyes_co[:, 2].mean())
print("front axis y*%+.0f, eye z %.3f, torso y %.3f" % (FY, EYE_Z, ty))

# crotch: lowest body point near the centreline
cm = (np.abs(Vw[:, 0]) < 0.012) & (~is_arm) & (Vw[:, 2] > hips_z - 0.3) & (Vw[:, 2] < hips_z + 0.02)
crotch_z = float(Vw[cm, 2].min())
print("hips %.3f knee %.3f ankle %.3f crotch %.3f" % (hips_z, knee_z, ankle_z, crotch_z))
Z_TOP = hips_z + 0.085
Z_HEM = knee_z + 0.11
BOOT_TOP = ankle_z + 0.215     # the sock cuff sits on it (0.15 broke the shaft in the guard pose; not diagnosed)

# ---- 2. muscle relief: one analytic height field, used for geometry (partly) and for the normal map ----


def gauss(x, s):
    return np.exp(-(x / s) ** 2)


def muscle_height(P):
    """P: (...,3) world positions on the body surface (metres). Returns surface height offset (metres):
    positive = bulge. Front torso only (abs, sternum, pec border, ribs); mild back (spine groove)."""
    x, y, z = P[..., 0], P[..., 1], P[..., 2]
    ax = np.abs(x)
    front = smoothstep(0.0, 0.04, (y - ty) * FY)       # 1 on the belly / chest side
    back = smoothstep(0.0, 0.04, -(y - ty) * FY)
    torso = 1.0 - smoothstep(0.15, 0.19, ax)           # keep arms out of it
    h = np.zeros_like(x)
    # abs: four rows from the pubic line to the sternum
    z0, z1 = hips_z - 0.015, sp2_z - 0.015
    rows = 4
    row_h = (z1 - z0) / rows
    t = (z - z0) / row_h
    inside_z = smoothstep(-0.25, 0.1, t) * (1 - smoothstep(rows - 0.1, rows + 0.25, t))
    cell = np.abs(t - np.floor(t) - 0.5) * 2         # 0 centre of row, 1 on the inscription
    inscr = gauss((1 - cell) * row_h * 0.5, 0.0095)   # wide soft inscriptions: narrow ones read as scars
    col_w = 0.046
    xs = (ax - col_w * 0.62) / (col_w * 0.5)
    ab_x = np.exp(-np.maximum(xs, 0) ** 4) * 1.0     # bulge width across a column
    alba = gauss(ax, 0.007)
    abs_mask = inside_z * (1 - smoothstep(col_w * 1.05, col_w * 1.35, ax))
    bulge = AB_BULGE * abs_mask * (1 - cell ** 3) * (1 - alba)
    groove = -AB_DEPTH * abs_mask * (inscr * (1 - smoothstep(col_w * 0.85, col_w * 1.15, ax)) * 0.9 + alba * 1.2)
    # oblique / side: lower edge of the abs ("v-cut") and the external obliques read as a soft ridge
    obl = 0.0016 * gauss(ax - 0.075, 0.016) * inside_z
    # sternum groove and pec lower border
    stern = -0.0022 * gauss(ax, 0.006) * smoothstep(sp2_z - 0.02, sp2_z + 0.09, z) * (1 - smoothstep(sp2_z + 0.10, sp2_z + 0.16, z))
    pec_z = sp2_z + 0.018 + 0.035 * np.minimum(ax / 0.13, 1.0) ** 1.3
    pec_in = smoothstep(0.012, 0.03, ax) * (1 - smoothstep(0.15, 0.185, ax))
    pec_border = -PEC_DEPTH * gauss(z - pec_z, 0.007) * pec_in
    pec_mass = 0.0022 * pec_in * smoothstep(-0.07, 0.0, z - pec_z) * (1 - smoothstep(0.0, 0.1, z - pec_z))
    rib = -0.0012 * gauss((z - (sp2_z - 0.045)), 0.004) * smoothstep(0.06, 0.1, ax) * torso
    h = front * torso * (bulge + groove + obl + stern + pec_border + pec_mass + rib)
    # back: spine groove
    h += back * torso * (-0.0025 * gauss(ax, 0.007) * smoothstep(hips_z, sp1_z, z) * (1 - smoothstep(neck_z - 0.05, neck_z, z)))
    # serratus: soft oblique finger ridges on the side of the rib cage under the arm
    side = torso * smoothstep(-0.03, 0.01, (y - ty) * FY)
    h += side * 0.0009 * np.cos(TAU * ((z - sp2_z) + 0.55 * (ax - 0.12)) / 0.026) * gauss(ax - 0.128, 0.018) \
        * smoothstep(sp2_z - 0.11, sp2_z - 0.07, z) * (1 - smoothstep(sp2_z - 0.005, sp2_z + 0.025, z))
    # deltoid cap and its soft lower edge on the outside of each upper arm
    for nm_ in ("Left", "Right"):
        S = np.array(tuple(bw(nm_ + "Arm")))
        E = np.array(tuple(bw(nm_ + "ForeArm")))
        ua = (E - S) / np.linalg.norm(E - S)
        d = P - S
        t = d @ ua
        radv = d - t[..., None] * ua
        rr = np.linalg.norm(radv, axis=-1)
        lat = radv[..., 0] * np.sign(S[0]) / (rr + 1e-6)
        near = gauss(rr - 0.045, 0.03)
        h += near * (0.0020 * gauss(t - 0.05, 0.05) * smoothstep(-0.3, 0.5, lat)
                     - 0.0010 * gauss(t - 0.125 - 0.02 * lat, 0.010) * smoothstep(-0.2, 0.4, lat))
    return h


# geometry: push the torso verts out by GEO_FRAC of the field (the normal map carries the rest)
select_only(base)
nrm = np.array([tuple(v.normal) for v in base.data.vertices])
nrm_w = nrm @ np.array(W.to_3x3()).T
hv = muscle_height(Vw) * GEO_FRAC
hv = hv * (np.abs(nrm_w[:, 1] * FY) > 0.3)
for v, d, n in zip(base.data.vertices, hv, nrm):
    if d != 0.0:
        v.co += Vector(n) * float(d)
Vw = np.array([tuple(W @ v.co) for v in base.data.vertices], dtype=np.float64)


# ---- 3. polar profile helpers for fitting clothing to the body ----
def profile(mask, z, band, cx, cy, n, passes=2, keep=0.97):
    m = mask & (np.abs(Vw[:, 2] - z) < band)
    pts = Vw[m]
    out = np.zeros(n)
    if len(pts):
        ang = np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx) % TAU
        r = np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)
        k = np.round(ang / TAU * n).astype(int) % n
        np.maximum.at(out, k, r)
    if (out == 0).any():
        idx = np.where(out > 0)[0]
        if len(idx) == 0:
            return np.full(n, 0.05)
        for i in np.where(out == 0)[0]:
            d = np.minimum((idx - i) % n, (i - idx) % n)
            out[i] = out[idx[np.argmin(d)]]
    raw = out.copy()
    for _ in range(passes):
        out = 0.5 * out + 0.25 * np.roll(out, 1) + 0.25 * np.roll(out, -1)
    return np.maximum(out, raw * keep)


def bbox_center(mask, z, band):
    m = mask & (np.abs(Vw[:, 2] - z) < band)
    p = Vw[m]
    if len(p) == 0:
        return 0.0, ty
    return (p[:, 0].min() + p[:, 0].max()) / 2, (p[:, 1].min() + p[:, 1].max()) / 2


def smooth_rows(a, it=2):
    a = np.array(a, dtype=np.float64)
    for _ in range(it):
        b = a.copy()
        b[1:-1] = 0.25 * a[:-2] + 0.5 * a[1:-1] + 0.25 * a[2:]
        a = b
    return a


def build_segments(name, segments, mat_fn, n, uv_fn=None):
    """segments: list of lists of rings (each ring: list of n world Vectors). Each segment is a separate
    surface (own vertices) so creases between segments stay crisp. mat_fn(seg, row, col) -> material index.
    uv_fn(seg, row, col) -> (u, v) per corner; col runs 0..n (unwrapped, so the seam column gets u = 1)."""
    bm = bmesh.new()
    uvl_ = bm.loops.layers.uv.new("UVMap")
    for si, rings in enumerate(segments):
        vs = [[bm.verts.new(INV @ p) for p in ring] for ring in rings]
        nr = len(vs)
        for i in range(len(vs) - 1):
            for k in range(n):
                k2 = (k + 1) % n
                f = bm.faces.new((vs[i][k], vs[i + 1][k], vs[i + 1][k2], vs[i][k2]))
                f.material_index = mat_fn(si, i, k)
                f.smooth = True
                corners = ((i, k), (i + 1, k), (i + 1, k + 1), (i, k + 1))
                for lp, (ri, ci) in zip(f.loops, corners):
                    lp[uvl_].uv = uv_fn(si, ri, ci) if uv_fn else (ci / n, ri / max(nr - 1, 1))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for ph in PLACEHOLDERS:      # without slots Blender drops material_index on join
        me.materials.append(ph)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.parent = rig
    return ob


PLACEHOLDERS = [bpy.data.materials.new("ph%d" % i) for i in range(4)]


def ring_pts(cx, cy, z, radii, n, off):
    offs = np.broadcast_to(np.asarray(off, dtype=np.float64), (n,))
    return [Vector((cx + (radii[k] + offs[k]) * math.cos(TAU * k / n), cy + (radii[k] + offs[k]) * math.sin(TAU * k / n), z))
            for k in range(n)]


def mesh_from_bm(name, bm, nmat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for ph in PLACEHOLDERS:      # all four slots on every kit mesh so joins keep material_index
        me.materials.append(ph)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.parent = rig
    return ob


def ribbon(bm, pts, normals, width, mat):
    """Flat strip (lace, piping) along world points; normals = surface normals at those points."""
    vs = []
    for i, (p, nn) in enumerate(zip(pts, normals)):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        side = t.cross(nn).normalized() * (width * 0.5)
        vs.append((bm.verts.new(INV @ (p - side)), bm.verts.new(INV @ (p + side))))
    for i in range(len(vs) - 1):
        f = bm.faces.new((vs[i][0], vs[i + 1][0], vs[i + 1][1], vs[i][1]))
        f.material_index = mat
        f.smooth = True


def world_bvh(ob):
    from mathutils.bvhtree import BVHTree
    b = bmesh.new()
    b.from_mesh(ob.data)
    for v in b.verts:
        v.co = W @ v.co
    t = BVHTree.FromBMesh(b)
    b.free()
    return t


def project(bvh, p, direction, reach=0.12):
    """Ray from p - direction*reach along +direction; returns (hit, normal) or (None, None)."""
    loc, nrm, _, _ = bvh.ray_cast(p - direction * reach, direction, reach * 2)
    if loc is None:
        return None, None
    if nrm.dot(direction) > 0:
        nrm = -nrm
    return loc, nrm


def patch(bm, bvh, centre, right, up, w, h, lift, mat, uvl_, nx=10, ny=6):
    """A label rectangle draped on a surface (ray-cast along -normal), UV 0..1 reading left-to-right."""
    fwd = right.cross(up).normalized()     # out of the surface, towards the viewer (right = up x outward normal)
    grid = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            p = centre + right * (w * (i / nx - 0.5)) + up * (h * (j / ny - 0.5))
            loc, nrm = project(bvh, p, -fwd)
            if loc is None:
                loc, nrm = p, fwd
            row.append((bm.verts.new(INV @ (loc + nrm * lift)), (i / nx, j / ny)))
        grid.append(row)
    for j in range(ny):
        for i in range(nx):
            q = (grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i])
            f = bm.faces.new([c[0] for c in q])
            f.material_index = mat
            f.smooth = True
            for lp, c in zip(f.loops, q):
                lp[uvl_].uv = c[1]


# weights by transfer from the body ----
def make_kd(mask):
    idx = np.where(mask)[0]
    kd = kdtree.KDTree(len(idx))
    for i in idx:
        kd.insert(Vector(Vw[i]), int(i))
    kd.balance()
    return kd


bgroups = {g.index: g.name for g in base.vertex_groups if g.name in bone_names}


def transfer_weights(ob, kd_of_vertex, k=6):
    """kd_of_vertex(world_pos) -> kd tree to query."""
    for nm in bone_names:
        pass
    groups = {}
    for v in ob.data.vertices:
        wp = W @ v.co
        acc = {}
        for (co, i, d) in kd_of_vertex(wp).find_n(wp, k):
            wt = 1.0 / (d + 0.004)
            for ge in base.data.vertices[i].groups:
                nm = bgroups.get(ge.group)
                if nm:
                    acc[nm] = acc.get(nm, 0.0) + ge.weight * wt
        top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(w for _, w in top) or 1.0
        for nm, w in top:
            if nm not in groups:
                groups[nm] = ob.vertex_groups.new(name=nm)
            groups[nm].add([v.index], w / tot, "REPLACE")


def smooth_weights(o, iters):
    me = o.data
    nb = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        nb[a].append(b)
        nb[b].append(a)
    cur = [{g.group: g.weight for g in v.groups} for v in me.vertices]
    for _ in range(iters):
        nxt = []
        for i, w in enumerate(cur):
            acc = {}
            for j in [i] + nb[i]:
                for gi, wt in cur[j].items():
                    acc[gi] = acc.get(gi, 0.0) + wt
            top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
            tot = sum(wt for _, wt in top) or 1.0
            nxt.append({gi: wt / tot for gi, wt in top})
        cur = nxt
    for g in o.vertex_groups:
        g.remove(range(len(me.vertices)))
    for i, w in enumerate(cur):
        for gi, wt in w.items():
            o.vertex_groups[gi].add([i], wt, "REPLACE")


nonarm = ~is_arm
sx_l = 1.0 if bw("LeftUpLeg").x > 0 else -1.0
kd_all = make_kd(nonarm)
kd_side = {s: make_kd(nonarm & (Vw[:, 0] * s > -0.01)) for s in (1.0, -1.0)}

# ---- 4. trunks (own mesh, loose fit) ----
NT = 40
HIP_ROWS_Z = list(np.linspace(Z_TOP - 0.05, crotch_z + 0.04, 6))
LEG_TOP = crotch_z + 0.075


NTH, NTL = 64, 56                              # columns around the hips / around each leg
ZB_TOP, ZB_BOT = Z_TOP + 0.012, Z_TOP - 0.072  # thick gathered elastic waistband, ~8.4 cm
RIBS = 5
HIP_BOT = crotch_z + 0.04
DH = ZB_BOT - HIP_BOT                          # hip tube height (texture v mapping)
DL = LEG_TOP - Z_HEM                           # leg tube height
FRONT_PH = FY * math.pi / 2                    # leg-relative angle of the front (0 = outer seam, pi = inner)


def wrap(a):
    return (a + np.pi) % TAU - np.pi


def fold_hip(th, depth, hi=False):
    """Outward cloth offset (m) on the hip tube: pipe folds hanging in columns from the gathered elastic,
    strongest at front / back centre. hi=True: the finer folds that only the textures carry."""
    hang = smoothstep(0.0, 0.06, depth)
    ctr = 0.55 + 0.45 * np.abs(np.sin(th))
    if hi:
        f = 0.5 * np.cos(19 * th + 4.0 + 11 * depth) + 0.5 * np.cos(27 * th + 1.0 - 15 * depth)
        return 0.0016 * hang * ctr * f
    f = 0.55 * np.cos(9 * th + 0.7 + 5 * depth) + 0.45 * np.cos(12 * th + 2.1 - 7 * depth)
    return 0.0045 * hang * ctr * f


def fold_leg(ph, depth, hi=False):
    """Outward offset (m) on a leg tube; ph is leg-relative (0 outer seam, pi inner). Loose pipe folds that grow
    towards the hem, diagonal 'diaper' folds sagging across the inner thigh, half-lock folds at the hip crease."""
    amp = 0.003 + 0.006 * smoothstep(0.0, 0.18, depth)
    inner = np.exp(-(wrap(ph - np.pi) / 0.9) ** 2)
    if hi:
        f = 0.5 * np.cos(17 * ph + 2.0 + 20 * depth) + 0.5 * np.cos(24 * ph + 5.0 - 25 * depth)
        lock = np.exp(-(wrap(ph - FRONT_PH) / 0.8) ** 2) * (1 - smoothstep(0.0, 0.07, depth)) * np.cos(150 * depth)
        return 0.0016 * f + 0.0022 * lock + 0.0014 * inner * np.cos(14 * ph + 55 * depth)
    low = 0.5 * np.cos(6 * ph + 1.3 + 9 * depth) + 0.5 * np.cos(10 * ph + 0.4 - 13 * depth)
    diag = inner * np.cos(8 * ph + 30 * depth)
    return amp * (0.75 * low + 0.6 * diag)


def trunks_build():
    # waistband: gathered elastic, RIBS horizontal ribs, a turned-in top edge
    zs_band = list(np.linspace(ZB_TOP, ZB_BOT, 4 * RIBS + 1))
    cy0 = float(np.mean([bbox_center(nonarm, z, 0.02)[1] for z in np.linspace(ZB_TOP, HIP_BOT, 8)]))
    prof_b = np.array([profile(nonarm, z, 0.02, 0.0, cy0, NTH) for z in zs_band])
    for k in range(NTH):
        prof_b[:, k] = smooth_rows(prof_b[:, k], 3)
    seg_band = [ring_pts(0.0, cy0, ZB_TOP - 0.008, prof_b[0], NTH, 0.006)]
    for i, z in enumerate(zs_band):
        t = i / (len(zs_band) - 1)
        rib = np.abs(math.sin(RIBS * math.pi * t)) ** 0.7
        seg_band.append(ring_pts(0.0, cy0, z, prof_b[i], NTH, 0.012 + 0.0028 * rib))
    hip_z = [ZB_BOT + 0.004] + list(np.linspace(ZB_BOT - 0.006, HIP_BOT, 10))
    prof_h = np.array([profile(nonarm, z, 0.02, 0.0, cy0, NTH) for z in hip_z])
    for k in range(NTH):
        prof_h[:, k] = smooth_rows(prof_h[:, k])
    th = np.arange(NTH) * TAU / NTH
    seg_hip = []
    for i, z in enumerate(hip_z):
        depth = max(ZB_BOT - z, 0.0)
        off = (0.010 if i == 0 else 0.016 + 0.006 * i / (len(hip_z) - 1)) + fold_hip(th, depth)
        seg_hip.append(ring_pts(0.0, cy0, z, prof_h[i], NTH, off))

    def mat_hip(si, i, k):
        if si == 0:
            return 1
        return 1 if k in (0, NTH // 2) else 0

    def uv_hip(si, i, k):
        if si == 0:
            return (k / NTH, 0.49 + 0.02 * i / len(seg_band))
        return (k / NTH, 0.98 - 0.45 * max(ZB_BOT - hip_z[i], 0.0) / DH)

    hip = build_segments("TrunksHip", [seg_band, seg_hip], mat_hip, NTH, uv_hip)
    legs = []
    for side in (1.0, -1.0):
        sel = nonarm & (Vw[:, 0] * side > -0.006) & (~is_foot)
        rows_z = list(np.linspace(LEG_TOP, Z_HEM + 0.022, 12))
        cs = np.array([bbox_center(sel, z, 0.02) for z in rows_z])
        cxs, cys = smooth_rows(cs[:, 0]), smooth_rows(cs[:, 1])
        prof = np.array([profile(sel, z, 0.02, cxs[i], cys[i], NTL) for i, z in enumerate(rows_z)])
        for k in range(NTL):
            prof[:, k] = smooth_rows(prof[:, k])
        thl = np.arange(NTL) * TAU / NTL
        ph = thl if side > 0 else np.pi - thl          # leg-relative angle, mirrored so both legs share the UVs
        body_rows = []
        for i, z in enumerate(rows_z):
            t = i / (len(rows_z) - 1)
            off = 0.015 + 0.020 * t + fold_leg(ph, LEG_TOP - z)          # loose, flaring towards the hem
            body_rows.append(ring_pts(cxs[i], cys[i], z, prof[i], NTL, off))
        # hem piping (separate segment, crisp edge) with a turned-in lip
        offl = 0.035 + fold_leg(ph, LEG_TOP - rows_z[-1])
        hem_z = [Z_HEM + 0.022, Z_HEM, Z_HEM + 0.006]
        hem = [ring_pts(cxs[-1], cys[-1], z, prof[-1], NTL, offl + d) for z, d in zip(hem_z, (0.0015, 0.0015, -0.004))]
        out_k = 0 if side > 0 else NTL // 2

        def mat_leg(si, i, k, out_k=out_k):
            if si == 1:
                return 1
            return 1 if k in (out_k, (out_k - 1) % NTL) else 0

        def uv_leg(si, i, k, side=side, rows_z=rows_z):
            u = k / NTL if side > 0 else 0.5 - k / NTL
            if si == 1:
                return (u, 0.01 * i)
            return (u, 0.47 - 0.45 * (LEG_TOP - rows_z[i]) / DL)

        leg = build_segments("TrunksLeg", [body_rows, hem], mat_leg, NTL, uv_leg)
        leg.parent = rig
        legs.append((leg, side))
    # centre-front label patch, just under the waistband
    bvh = world_bvh(hip)
    bm = bmesh.new()
    uvl_ = bm.loops.layers.uv.new("UVMap")
    up = Vector((0, 0, 1))
    nout = Vector((0, FY, 0))
    patch(bm, bvh, Vector((0.0, cy0, ZB_BOT - 0.042)), up.cross(nout).normalized(), up, 0.085, 0.040, 0.0012, 2,
          uvl_, 10, 5)
    lab = mesh_from_bm("TrunksLabel", bm, 3)
    return hip, legs, lab


hip_ob, leg_obs, tlabel_ob = trunks_build()
for ob in (hip_ob, tlabel_ob):
    transfer_weights(ob, lambda wp: kd_all)
    smooth_weights(ob, 1)
for ob, side in leg_obs:
    transfer_weights(ob, lambda wp, side=side: kd_side[side])
    smooth_weights(ob, 1)
select_only(hip_ob)
tlabel_ob.select_set(True)
for ob, _ in leg_obs:
    ob.select_set(True)
bpy.ops.object.join()
trunks = bpy.context.view_layer.objects.active
trunks.name = "Trunks"
trunks.data.name = "Trunks"
print("trunks tris", tris(trunks))

# ---- 5. boots (own mesh: sole slab, upper over the foot, shaft to mid-calf) ----
NB = 28
NS = 24


def superellipse(n_pts, n_exp):
    out = []
    for k in range(n_pts):
        a = TAU * k / n_pts
        c, s = math.cos(a), math.sin(a)
        out.append((math.copysign(abs(c) ** (2.0 / n_exp), c), math.copysign(abs(s) ** (2.0 / n_exp), s)))
    return out


def boot_build(side):
    nm = ("Left" if side > 0 else "Right")
    foot = bw(nm + "Foot")
    toe = bw(nm + "ToeBase")
    d = Vector((toe.x - foot.x, toe.y - foot.y, 0)).normalized()
    lat = Vector((-d.y, d.x, 0))
    sel = is_foot & (Vw[:, 0] * side > 0)
    F = Vw[sel]
    s_all = (F[:, 0] - foot.x) * d.x + (F[:, 1] - foot.y) * d.y
    l_all = (F[:, 0] - foot.x) * lat.x + (F[:, 1] - foot.y) * lat.y
    z_all = F[:, 2]
    z0 = max(0.0, float(z_all.min()))
    s0, s1 = float(s_all.min()), float(s_all.max())
    print(nm, "foot s %.3f..%.3f width %.3f z0 %.3f ztop %.3f" % (s0, s1, l_all.max() - l_all.min(), z0, z_all.max()))
    n_sl = 30
    ss = np.linspace(s0 - 0.004, s1 + 0.004, n_sl)
    lo, hi, tp = [], [], []
    for s in ss:
        m = np.abs(s_all - s) < 0.014
        if m.sum() < 2:
            lo.append(np.nan); hi.append(np.nan); tp.append(np.nan)
        else:
            lo.append(l_all[m].min()); hi.append(l_all[m].max()); tp.append(z_all[m].max())
    lo, hi, tp = np.array(lo), np.array(hi), np.array(tp)
    for a in (lo, hi, tp):
        bad = np.isnan(a)
        a[bad] = np.interp(np.where(bad)[0], np.where(~bad)[0], a[~bad])
    lo, hi, tp = smooth_rows(lo, 4), smooth_rows(hi, 4), smooth_rows(tp, 4)
    lc, wd = (lo + hi) / 2, (hi - lo) / 2
    toe_start = s1 - 0.075
    heel_end = s0 + 0.03
    base_ctr = Vector((foot.x, foot.y, 0))

    def at(s, l, z):
        return base_ctr + d * s + lat * l + Vector((0, 0, z))

    def taper(s):
        f = 1.0
        if s > toe_start:
            f = min(f, math.sqrt(max(0.0, 1 - ((s - toe_start) / (s1 + 0.018 - toe_start)) ** 2)))
        if s < heel_end:
            f = min(f, math.sqrt(max(0.0, 1 - ((heel_end - s) / (heel_end - s0 + 0.012)) ** 2)))
        return max(f, 0.001)

    shape_up = superellipse(NS, 3.4)
    shape_sole = superellipse(NS, 4.5)
    upper_rings, sole_rings = [], []
    for i, s in enumerate(ss):
        f = taper(s)
        # upper: a touch bigger than the foot, toe box kept fat and flat
        w_u = (wd[i] + 0.011) * f
        top = tp[i] + 0.012
        if s > s1 - 0.12:
            top = max(top, 0.052)
        top = (z0 + 0.012 + (top - z0 - 0.012) * f) if f > 0.001 else z0 + 0.012
        zc = (z0 + 0.010 + top) / 2
        hh = (top - z0 - 0.010) / 2
        upper_rings.append([at(s, lc[i] + w_u * a, zc + hh * b) for a, b in shape_up])
        w_s = (wd[i] + 0.017) * f
        sole_rings.append([at(s, lc[i] + w_s * a, z0 + 0.007 + 0.007 * b) for a, b in shape_sole])
    # shaft
    selb = nonarm & (Vw[:, 0] * side > -0.002)
    shaft_z = list(np.linspace(z0 + 0.045, BOOT_TOP - 0.03, 7))
    cs = np.array([bbox_center(selb & (is_foot | (Vw[:, 2] > ankle_z - 0.03)), z, 0.018) for z in shaft_z])
    cxs, cys = smooth_rows(cs[:, 0]), smooth_rows(cs[:, 1])
    prof = np.array([profile(selb, z, 0.018, cxs[i], cys[i], NB, passes=8, keep=0.9) + 0.004 for i, z in enumerate(shaft_z)])
    for k in range(NB):
        prof[:, k] = smooth_rows(prof[:, k])
    shaft = []
    for i, z in enumerate(shaft_z):
        t = i / (len(shaft_z) - 1)
        shaft.append(ring_pts(cxs[i], cys[i], z, prof[i], NB, 0.013 + 0.005 * t))
    collar = [ring_pts(cxs[-1], cys[-1], z, prof[-1], NB, 0.019 + dz) for z, dz in ((BOOT_TOP - 0.03, 0.0), (BOOT_TOP, 0.0))]
    kf = int(round(math.atan2(d.y, d.x) / TAU * NB)) % NB
    return upper_rings, sole_rings, shaft, collar, kf, ss, s1


def boot_objects(side):
    up, sole, shaft, collar, kf, ss, s1 = boot_build(side)
    ns = len(ss)

    def mat_up(si, i, k):
        # accent panel (trim) wrapped round the heel, lower half of the upper
        s = ss[i]
        if s < ss[0] + 0.05 and (NS * 5 // 8 <= k < NS * 7 // 8):
            return 1
        return 0

    a = build_segments("BootUpper", [up], mat_up, NS, lambda si, i, k: (k / NS, 0.48 * i / (ns - 1)))
    b = build_segments("BootSole", [sole], lambda si, i, k: 1, NS)

    def mat_shaft(si, i, k):
        return 0

    nsh = len(shaft) + len(collar)
    c = build_segments("BootShaft", [shaft, collar], mat_shaft, NB,
                       lambda si, i, k: (k / NB, 0.52 + 0.46 * (i + si * len(shaft)) / (nsh - 1)))
    # laces criss-crossing up the front of the shaft and over the instep, and a sock cuff above the collar
    nm = "Left" if side > 0 else "Right"
    foot, toe = bw(nm + "Foot"), bw(nm + "ToeBase")
    d = Vector((toe.x - foot.x, toe.y - foot.y, 0)).normalized()
    lat = Vector((-d.y, d.x, 0))
    bvs = world_bvh(c)
    bvu = world_bvh(a)
    bm = bmesh.new()
    z_lo, z_hi = shaft[0][0].z + 0.012, collar[-1][0].z - 0.012
    rungs = list(np.linspace(z_lo, z_hi, 7))
    for j in range(len(rungs) - 1):
        for sgn in (1, -1):
            pts, nrms = [], []
            for t in np.linspace(0, 1, 6):
                z = rungs[j] + (rungs[j + 1] - rungs[j]) * t
                cxy = Vector((foot.x, foot.y, z))
                p = cxy + lat * (0.011 * sgn * (1 - 2 * t))
                loc, nn = project(bvs, p + d * 0.0, -d, 0.15)
                if loc is None:
                    continue
                pts.append(loc + nn * (0.0015 + 0.0012 * math.sin(math.pi * t)))
                nrms.append(nn)
            if len(pts) > 2:
                ribbon(bm, pts, nrms, 0.0032, 2)
    # instep: three short crossings over the top of the foot towards the toe box
    for j in range(3):
        for sgn in (1, -1):
            pts, nrms = [], []
            for t in np.linspace(0, 1, 5):
                s = -0.005 + 0.022 * (j + t)
                p = Vector((foot.x, foot.y, 0.0)) + d * s + lat * (0.010 * sgn * (1 - 2 * t)) + Vector((0, 0, 0.0))
                loc, nn = project(bvu, p + Vector((0, 0, 0.25)), Vector((0, 0, -1)), 0.25)
                if loc is None:
                    continue
                pts.append(loc + nn * 0.0016)
                nrms.append(nn)
            if len(pts) > 2:
                ribbon(bm, pts, nrms, 0.0032, 2)
    laces = mesh_from_bm("BootLaces", bm, 3)
    ztop = collar[-1][0].z
    shin = nonarm & (Vw[:, 0] * side > 0.02)       # this shin only (a band too thin can come back empty and put
    cx_, cy_ = bbox_center(shin, ztop + 0.01, 0.035)   # the centre on the body midline)
    sock_rows = []
    for z, dz in ((ztop - 0.012, 0.006), (ztop + 0.004, 0.005), (ztop + 0.024, 0.003), (ztop + 0.029, 0.0005)):
        pr = profile(shin, z, 0.025, cx_, cy_, NB, passes=6, keep=0.85)
        sock_rows.append(ring_pts(cx_, cy_, z, pr, NB, dz))
    sock = build_segments("BootSock", [sock_rows], lambda si, i, k: 3, NB)
    return [a, b, c, laces, sock]


def boot_weights(ob, side, kind):
    """Boots are stiff: the shaft follows the shin and hands over to the foot across the ankle; the foot part is
    rigid on the foot bone, with the toe end following the toe bone. Deterministic, no tearing."""
    nm = "Left" if side > 0 else "Right"
    foot, toe = bw(nm + "Foot"), bw(nm + "ToeBase")
    d = Vector((toe.x - foot.x, toe.y - foot.y, 0)).normalized()
    s_ball = (toe.x - foot.x) * d.x + (toe.y - foot.y) * d.y
    gF = ob.vertex_groups.new(name=BONE_PREFIX + nm + "Foot")
    gT = ob.vertex_groups.new(name=BONE_PREFIX + nm + "ToeBase")
    gL = ob.vertex_groups.new(name=BONE_PREFIX + nm + "Leg")
    for v in ob.data.vertices:
        wp = W @ v.co
        if kind == "shaft":
            # the skin above the ankle joint is all shin: the shaft must follow it exactly or the ankle bend
            # swings the boot off the leg
            f = 1.0 - sstep(ankle_z - 0.035, ankle_z + 0.015, wp.z)
            gF.add([v.index], f, "REPLACE")
            gL.add([v.index], 1.0 - f, "REPLACE")
        else:
            s = (wp.x - foot.x) * d.x + (wp.y - foot.y) * d.y
            t = sstep(s_ball - 0.025, s_ball + 0.03, s)
            gF.add([v.index], 1.0 - t, "REPLACE")
            gT.add([v.index], t, "REPLACE")


boot_all = []
for side in (1.0, -1.0):
    for ob, kind in zip(boot_objects(side), ("foot", "foot", "shaft", "shaft", "shaft")):
        boot_weights(ob, side, kind)
        boot_all.append(ob)
select_only(boot_all[0])
for ob in boot_all:
    ob.select_set(True)
bpy.ops.object.join()
boots = bpy.context.view_layer.objects.active
boots.name = "Boots"
boots.data.name = "Boots"
print("boots tris", tris(boots))

# ---- 6. cut hands and feet off the skin (gloves and boots cover them) ----
bm = bmesh.new()
bm.from_mesh(base.data)
bm.verts.ensure_lookup_table()
kill = [v for v in bm.verts if dom[v.index] in FOOT_BONES or (dom[v.index] in ARM_BONES and "Hand" in dom[v.index])]
bmesh.ops.delete(bm, geom=kill, context="VERTS")
bm.to_mesh(base.data)
bm.free()
base.data.update()
print("body after hand/foot cut", len(base.data.vertices), tris(base))

# ---- 7. gloves (10 oz lace-ups: about 31 cm with the cuff, padded knuckle volume wider than the wrist) ----
# axial profile (a = metres from the wrist joint towards the knuckles): half-width across (thumb axis),
# half-depth (palm axis), palm-ward centre offset. The cuff tapers in to the wrist then swells into the mitt.
G_PROF = np.array([
    [-0.100, 0.057, 0.051, 0.004],
    [-0.080, 0.053, 0.048, 0.004],
    [-0.040, 0.049, 0.045, 0.004],
    [0.000, 0.048, 0.044, 0.006],
    [0.035, 0.055, 0.051, 0.008],
    [0.080, 0.066, 0.061, 0.010],
    [0.125, 0.070, 0.066, 0.012],
    [0.150, 0.070, 0.066, 0.014],
])
GLOVE_A0, GLOVE_CAP, GLOVE_TIP = -0.100, 0.150, 0.222
G_EXP = 2.5                    # superellipse exponent of the sections (2 = ellipse, higher = boxier)
G_V_MAIN, G_V_THUMB = 0.86, 0.87   # UV: shell in v 0..0.86, thumb above
G_ROWS = np.concatenate([np.linspace(GLOVE_A0, GLOVE_CAP, 24),
                         GLOVE_CAP + (GLOVE_TIP - GLOVE_CAP) * np.sin(np.linspace(0, math.pi / 2, 11)[1:-1])])
G_ROW_V = G_V_MAIN * (G_ROWS - GLOVE_A0) / (GLOVE_TIP - GLOVE_A0)


GLOVE_DET = {}


def g_prof(a):
    b = float(np.interp(a, G_PROF[:, 0], G_PROF[:, 1]))
    c = float(np.interp(a, G_PROF[:, 0], G_PROF[:, 2]))
    c0 = float(np.interp(a, G_PROF[:, 0], G_PROF[:, 3]))
    if a > GLOVE_CAP:
        u = min((a - GLOVE_CAP) / (GLOVE_TIP - GLOVE_CAP), 1.0)
        k = max(1 - u ** 3, 0.0) ** (1 / 3)        # a flattish padded knuckle face, not a dome
        b, c = b * k, c * k
        c0 += 0.020 * u                             # the front curls towards the palm
    return b, c, c0


def make_glove(side):
    hand = side + "Hand"
    wrist = Vector(bw(hand))
    mid = Vector(bw(hand + "Middle1"))
    th = Vector(bw(hand + "Thumb1"))
    dd = (mid - wrist).normalized()
    sx = 1.0 if wrist.x > 0 else -1.0
    p = Vector((-sx, 0, 0))
    p = (p - dd * p.dot(dd)).normalized()
    s = dd.cross(p).normalized()
    if s.dot(th - mid) < 0:
        s = -s

    def at(a, b, c):
        return wrist + dd * a + s * b + p * c

    def surf(a, t, sc=1.0):
        """Point on the glove shell at axial a (m from the wrist joint) and angle t (0 thumb side, +pi/2 palm,
        -pi/2 back of the hand). Superellipse sections; the palm side is flatter than the domed back."""
        b, c, c0 = g_prof(a)
        cs, sn = math.cos(t), math.sin(t)
        e = 2.0 / G_EXP
        pb = math.copysign(abs(cs) ** e, cs)
        pc = math.copysign(abs(sn) ** e, sn)
        cside = c * (1.0 - 0.12 * sstep(0.0, 0.06, a) * (1.0 if sn > 0 else 0.0))
        return at(a, b * sc * pb, c0 + cside * sc * pc)

    def snorm(a, t):
        da, dt = 0.002, 0.01
        n = (surf(a, t + dt) - surf(a, t - dt)).cross(surf(a + da, t) - surf(a - da, t)).normalized()
        b_, c_, c0_ = g_prof(a)
        if n.dot(surf(a, t) - at(a, 0.0, c0_)) < 0:
            n = -n
        return n

    bm = bmesh.new()
    uvl_ = bm.loops.layers.uv.new("UVMap")
    # main shell: a lathe from the cuff opening to the knuckle face, a fan to the tip
    nc = 36
    rows = [(GLOVE_A0 + 0.014, 0.86), (GLOVE_A0 - 0.004, 0.95)] + [(a, 1.0) for a in G_ROWS]
    ring_v = [bm.verts.new(INV @ surf(a, TAU * k / nc, sc)) for a, sc in rows for k in range(nc)]
    tip = bm.verts.new(INV @ surf(GLOVE_TIP, 0.0, 0.0))
    nr = len(rows)
    rv = [0.0, 0.0] + [float(v) for v in G_ROW_V]
    for i in range(nr - 1):
        for k in range(nc):
            k2 = (k + 1) % nc
            f = bm.faces.new((ring_v[i * nc + k], ring_v[(i + 1) * nc + k], ring_v[(i + 1) * nc + k2], ring_v[i * nc + k2]))
            f.smooth = True
            for lp, (ri, ci) in zip(f.loops, ((i, k), (i + 1, k), (i + 1, k + 1), (i, k + 1))):
                lp[uvl_].uv = (ci / nc, rv[ri])
    for k in range(nc):
        k2 = (k + 1) % nc
        f = bm.faces.new((ring_v[(nr - 1) * nc + k], tip, ring_v[(nr - 1) * nc + k2]))
        f.smooth = True
        for lp, uv in zip(f.loops, ((k / nc, rv[-1]), ((k + 0.5) / nc, G_V_MAIN), ((k + 1) / nc, rv[-1]))):
            lp[uvl_].uv = uv
    # thumb: a separate padded capsule lying along the side of the fist, its tip tucked into the knuckle
    # volume (the 'bar'), so the join reads as a sewn seam rather than a ball
    tb, tt = at(0.040, 0.054, 0.030), at(0.150, 0.047, 0.050)
    axv = (tt - tb).normalized()
    e1 = (p - axv * p.dot(axv)).normalized()
    e2 = axv.cross(e1)
    ntc, ntr = 16, 12
    th_v = []
    for i in range(ntr + 1):
        t = i / ntr
        rr = (0.025 + (0.020 - 0.025) * t) * max(1 - abs(2 * t - 1) ** 3.5, 0.0) ** (1 / 3.5)
        ctr = tb + (tt - tb) * t
        th_v.append([bm.verts.new(INV @ (ctr + (e1 * math.cos(TAU * k / ntc) + e2 * math.sin(TAU * k / ntc)) * max(rr, 0.0005)))
                     for k in range(ntc)])
    for i in range(ntr):
        for k in range(ntc):
            k2 = (k + 1) % ntc
            f = bm.faces.new((th_v[i][k], th_v[i + 1][k], th_v[i + 1][k2], th_v[i][k2]))
            f.smooth = True
            for lp, (ri, ci) in zip(f.loops, ((i, k), (i + 1, k), (i + 1, k + 1), (i, k + 1))):
                lp[uvl_].uv = (ci / ntc, G_V_THUMB + (1.0 - G_V_THUMB - 0.01) * ri / ntr)
    # label patch across the back of the wrist (material 1), reading left to right from outside
    nx_, ny_ = 10, 6
    a_lo, a_hi, half = -0.036, 0.022, 0.034
    grid = []
    for j in range(ny_ + 1):
        a = a_lo + (a_hi - a_lo) * j / ny_
        b_, c_, _ = g_prof(a)
        dt = half / max(c_, 0.02)
        row = []
        for i in range(nx_ + 1):
            t = -math.pi / 2 + dt * (i / nx_ - 0.5) * 2
            row.append((bm.verts.new(INV @ (surf(a, t) + snorm(a, t) * 0.0009)), i / nx_, j / ny_))
        grid.append(row)
    am = (a_lo + a_hi) / 2
    flip = (surf(am, -math.pi / 2 + 0.05) - surf(am, -math.pi / 2)).dot(dd.cross(snorm(am, -math.pi / 2))) < 0
    for j in range(ny_):
        for i in range(nx_):
            q = (grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i])
            f = bm.faces.new([c[0] for c in q] if not flip else [c[0] for c in reversed(q)])
            f.material_index = 1
            f.smooth = True
            qq = q if not flip else tuple(reversed(q))
            for lp, c in zip(f.loops, qq):
                lp[uvl_].uv = ((1 - c[1]) if flip else c[1], c[2])
    # laces criss-crossing the palm side of the cuff (material 2)
    rungs = list(np.linspace(GLOVE_A0 + 0.012, -0.012, 5))
    tl, tr = math.pi / 2 - 0.30, math.pi / 2 + 0.30
    for j in range(len(rungs) - 1):
        for t0, t1 in ((tl, tr), (tr, tl)):
            pts, nrms = [], []
            for u in np.linspace(0, 1, 6):
                a = rungs[j] + (rungs[j + 1] - rungs[j]) * u
                t = t0 + (t1 - t0) * u
                nn = snorm(a, t)
                pts.append(surf(a, t) + nn * (0.0014 + 0.0012 * math.sin(math.pi * u)))
                nrms.append(nn)
            ribbon(bm, pts, nrms, 0.0036, 2)
    # the right hand's frame is the mirror of the left's, which turns every face inside out: flip it back
    det = dd.cross(s).dot(p)
    GLOVE_DET.setdefault("ref", det)
    if det * GLOVE_DET["ref"] < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    ob = mesh_from_bm("Glove" + side, bm, 3)
    me = ob.data
    gh = ob.vertex_groups.new(name=BONE_PREFIX + hand)
    gf = ob.vertex_groups.new(name=BONE_PREFIX + side + "ForeArm")
    for v in me.vertices:
        a = (W @ v.co - wrist).dot(dd)
        wf = max(0.0, min(1.0, (0.01 - a) / 0.09)) * 0.75
        gh.add([v.index], 1.0 - wf, "REPLACE")
        if wf > 0.001:
            gf.add([v.index], wf, "REPLACE")
    return ob


gl, gr = make_glove("Left"), make_glove("Right")
select_only(gl)
gr.select_set(True)
bpy.ops.object.join()
gloves = bpy.context.view_layer.objects.active
gloves.name = "Gloves"
gloves.data.name = "Gloves"

# ---- 8. skin textures: diffuse tones, scalp stubble, normal map ----
uvl = base.data.uv_layers.active
me = base.data
me.calc_loop_triangles()


def rasterize_world(size):
    P = np.zeros((size, size, 3), np.float32)
    cov = np.zeros((size, size), bool)
    # use the pre-cut body: positions of vertices are in Vw (same indices; the cut removed verts, so rebuild)
    co = np.array([tuple(W @ v.co) for v in me.vertices], dtype=np.float32)
    uvd = np.array([tuple(l.uv) for l in uvl.data], dtype=np.float32)
    for lt in me.loop_triangles:
        ls = lt.loops
        vi = lt.vertices
        uv = uvd[list(ls)] * size
        x0, x1 = int(math.floor(uv[:, 0].min())), int(math.ceil(uv[:, 0].max()))
        y0, y1 = int(math.floor(uv[:, 1].min())), int(math.ceil(uv[:, 1].max()))
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, size - 1), min(y1, size - 1)
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax_, ay_), (bx_, by_), (cx_, cy_) = uv
        den = (by_ - cy_) * (ax_ - cx_) + (cx_ - bx_) * (ay_ - cy_)
        if abs(den) < 1e-9:
            continue
        l1 = ((by_ - cy_) * (gx - cx_) + (cx_ - bx_) * (gy - cy_)) / den
        l2 = ((cy_ - ay_) * (gx - cx_) + (ax_ - cx_) * (gy - cy_)) / den
        l3 = 1 - l1 - l2
        e = -0.02
        m = (l1 >= e) & (l2 >= e) & (l3 >= e)
        if not m.any():
            continue
        pos = l1[..., None] * co[vi[0]] + l2[..., None] * co[vi[1]] + l3[..., None] * co[vi[2]]
        sub = P[y0:y1 + 1, x0:x1 + 1]
        sub[m] = pos[m]
        cov[y0:y1 + 1, x0:x1 + 1] |= m
    return P, cov


print("rasterizing UVs ...")
PW, COV = rasterize_world(TEX_SIZE)
print("covered texels", int(COV.sum()))


def hair_mask(P):
    x, y, z = P[..., 0], P[..., 1], P[..., 2]
    yp = (y - head_c[1]) * FY
    ax = np.abs(x)
    z_front, z_side, z_back = EYE_Z + 0.055, EYE_Z + 0.040, EYE_Z - 0.060
    z_fs = z_front + (z_side - z_front) * smoothstep(0.05, 0.075, ax)
    w_b = smoothstep(-0.050, -0.095, yp)
    z_h = z_fs + (z_back - z_fs) * w_b
    m = smoothstep(-0.012, 0.010, z - z_h)
    inhead = (z > EYE_Z - 0.10) & (np.hypot(x, yp) < 0.15) & (z > neck_z + 0.02)
    return m * inhead


HM = hair_mask(PW) * COV


def fill_crown_holes():
    """The MPFB body can carry a small hole at the crown (where the pack's hair used to sit): close it, so the
    scalp cap and the skin never show the inside of the head."""
    bmh = bmesh.new()
    bmh.from_mesh(me)
    bmh.verts.ensure_lookup_table()
    bedges = [e for e in bmh.edges if e.is_boundary]
    adj = {}
    for e in bedges:
        for v in e.verts:
            adj.setdefault(v, []).append(e)
    seen, fill = set(), []
    for e in bedges:
        if e in seen:
            continue
        comp, stack = [], [e]
        seen.add(e)
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for v in cur.verts:
                for n in adj[v]:
                    if n not in seen:
                        seen.add(n)
                        stack.append(n)
        zc = float(np.mean([(W @ v.co).z for ce in comp for v in ce.verts]))
        print("boundary loop: %d edges, mean z %.3f" % (len(comp), zc))
        if len(comp) <= 90 and zc > EYE_Z + 0.07:
            fill += comp
    if fill:
        bmesh.ops.holes_fill(bmh, edges=fill, sides=90)
        bmh.normal_update()
    bmh.to_mesh(me)
    bmh.free()
    me.update()


fill_crown_holes()


def crown_report():
    Vc = np.array([tuple(W @ v.co) for v in me.vertices])
    zmax = Vc[:, 2].max()
    ids = np.where(Vc[:, 2] > zmax - 0.07)[0]
    vuv = {}
    uv_now = me.uv_layers.active
    for l in me.loops:
        vuv.setdefault(l.vertex_index, []).append(tuple(uv_now.data[l.index].uv))
    outside = [i for i in ids if any(u < 0 or u > 1 or v < 0 or v > 1 for u, v in vuv.get(i, [(0.5, 0.5)]))]
    nz = [me.vertices[int(i)].normal.dot(Vector((0, 0, 1))) for i in ids]
    mk = hair_mask(Vc[ids])
    print("CROWN verts %d, uv outside %d, normal.z min %.2f, mask min %.2f, mask<0.995: %d" % (
        len(ids), len(outside), min(nz), mk.min(), int((mk < 0.995).sum())))
    pts = Vc[ids][mk < 0.995]
    if len(pts):
        print("  low-mask verts around", pts.mean(axis=0), "head_c", head_c, "eyez", EYE_Z)


crown_report()


def load_tex(rel):
    img = bpy.data.images.load(os.path.join(USER_DATA, rel), check_existing=True)
    n = img.size[0]
    arr = np.empty(n * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(arr)
    arr = arr.reshape(img.size[1], img.size[0], 4)
    if n != TEX_SIZE:
        raise RuntimeError("skin texture is %d px, expected %d" % (n, TEX_SIZE))
    return arr


def lift(arr, target):
    rgb = arr[..., :3]
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    mean = float(lum[COV].mean())
    print("  diffuse mean luminance %.3f (sRGB-encoded)" % mean)
    if target > 0 and mean < target:
        g = target / mean
        arr = arr.copy()
        arr[..., :3] = np.clip(rgb * g, 0, 1)
        print("  lifted x%.2f to %.3f" % (g, target))
    return arr


rng = np.random.default_rng(7)
grain = rng.standard_normal((TEX_SIZE, TEX_SIZE)).astype(np.float32)


def blur1(a):
    return (a * 4 + np.roll(a, 1, 0) * 2 + np.roll(a, -1, 0) * 2 + np.roll(a, 1, 1) * 2 + np.roll(a, -1, 1) * 2
            + np.roll(np.roll(a, 1, 0), 1, 1) + np.roll(np.roll(a, -1, 0), 1, 1)
            + np.roll(np.roll(a, 1, 0), -1, 1) + np.roll(np.roll(a, -1, 0), -1, 1)) / 16.0


def paint_scalp(arr):
    arr = arr.copy()
    g = 0.78 + 0.22 * np.clip(grain * 0.8 + 0.5, 0, 1)
    tgt = np.array(STUBBLE_RGB, np.float32)[None, None, :] * g[..., None]
    m = (HM * HAIR_STRENGTH)[..., None]
    arr[..., :3] = arr[..., :3] * (1 - m) + tgt * m
    return arr


def make_image(name, arr, colorspace):
    img = bpy.data.images.new(name, TEX_SIZE, TEX_SIZE, alpha=False)
    img.colorspace_settings.name = colorspace
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.pack()
    return img


def save_webp(img, path, quality=88):
    img.file_format = "WEBP"
    img.filepath_raw = path
    img.save()


def noise3(P, k_lo, k_hi, nterm, seed):
    """Seamless 3D noise on world positions (sum of random plane waves), unit-ish std. k in rad/m."""
    rng = np.random.default_rng(seed)
    out = np.zeros(len(P), np.float32)
    for _ in range(nterm):
        d = rng.standard_normal(3)
        d /= np.linalg.norm(d)
        k = rng.uniform(k_lo, k_hi)
        out += np.sin(P @ (d * k) + rng.uniform(0, TAU)).astype(np.float32)
    return out / math.sqrt(nterm / 2)


def gball(P, c, r):
    return np.exp(-np.sum((P - np.asarray(c, np.float32)) ** 2, axis=-1) / (r * r))


PC = PW[COV].astype(np.float32)
EYE_L = eyes_co[eyes_co[:, 0] > 0].mean(axis=0)
EYE_R = eyes_co[eyes_co[:, 0] < 0].mean(axis=0)
_sk = Vw[is_head & (np.abs(Vw[:, 2] - (EYE_Z - 0.015)) < 0.01)]
EAR_X = float(np.abs(_sk[:, 0]).max()) if len(_sk) else 0.075
_nz = Vw[is_head & (np.abs(Vw[:, 0]) < 0.006) & (Vw[:, 2] > EYE_Z - 0.055) & (Vw[:, 2] < EYE_Z - 0.01)]
NOSE = _nz[np.argmax(_nz[:, 1] * FY)] if len(_nz) else np.array([0, head_c[1] + FY * 0.1, EYE_Z - 0.03])
BLOTCH = noise3(PC, TAU / 0.30, TAU / 0.14, 12, 61)   # large and soft: smaller scales read as a rash at play distance
FINE = noise3(PC, TAU / 0.014, TAU / 0.005, 16, 62)
ASYM = noise3(PC, TAU / 0.5, TAU / 0.25, 6, 63)


def skin_zones(arr, tone_k, sock_k):
    """Colour zones over the pack's diffuse: blotchiness, redder knees / elbows / wrists / nose / cheeks / ears,
    dark eye sockets with the brow's shadow over the upper lid. tone_k scales the redness, sock_k the sockets."""
    arr = arr.copy()
    rgb = arr[COV][:, :3]
    red = np.zeros(len(PC), np.float32)
    for nm_ in ("Left", "Right"):
        red += 0.9 * gball(PC, bw(nm_ + "Leg"), 0.055) + 0.8 * gball(PC, bw(nm_ + "ForeArm"), 0.045)
        red += 0.6 * gball(PC, bw(nm_ + "Hand"), 0.04)
    for sx_ in (1, -1):
        red += 0.7 * gball(PC, (sx_ * EAR_X, head_c[1], EYE_Z - 0.015), 0.028)
        red += 0.45 * gball(PC, (sx_ * 0.035, NOSE[1] - FY * 0.02, EYE_Z - 0.035), 0.025)
    red += 0.8 * gball(PC, NOSE, 0.02)
    red = np.clip(red, 0, 1.2) * (1 + 0.2 * ASYM)
    rgb *= (1 + 0.018 * BLOTCH)[:, None]
    rgb[:, 0] *= 1 + 0.10 * tone_k * red
    rgb[:, 1] *= 1 - 0.03 * tone_k * red
    rgb[:, 2] *= 1 - 0.05 * tone_k * red
    soc = np.zeros(len(PC), np.float32)
    for E in (EYE_L, EYE_R):
        d = PC - (E + np.array([0, 0, 0.004], np.float32))
        soc += np.exp(-(d[:, 0] / 0.025) ** 2 - (d[:, 2] / 0.017) ** 2 - (d[:, 1] / 0.022) ** 2)
    rgb *= (1 - sock_k * np.clip(soc, 0, 1))[:, None]
    arr[COV, :3] = np.clip(rgb, 0, 1)
    return arr


print("light diffuse")
light = paint_scalp(skin_zones(lift(load_tex(SKIN_TEX), LIGHT_TARGET_MEAN), 1.0, 0.62))
print("dark diffuse")
dark = paint_scalp(skin_zones(lift(load_tex(SKIN_TEX_DARK), DARK_TARGET_MEAN), 0.55, 0.6))


def skin_sweat():
    """R = sweat (clearcoat mask), G = roughness: glossy shoulders, chest, upper back, forehead, nose."""
    sh = np.zeros(len(PC), np.float32)
    for nm_ in ("Left", "Right"):
        sh += gball(PC, bw(nm_ + "Arm") + Vector((0, 0, 0.03)), 0.08)
    x, y, z = PC[:, 0], PC[:, 1], PC[:, 2]
    chest = smoothstep(sp2_z - 0.06, sp2_z, z) * (1 - smoothstep(neck_z - 0.04, neck_z, z)) * (1 - smoothstep(0.12, 0.17, np.abs(x)))
    fore = smoothstep(EYE_Z + 0.01, EYE_Z + 0.03, z) * smoothstep(0.0, 0.05, (y - head_c[1]) * FY) * (1 - HM[COV])
    sw = np.clip(sh + chest + fore + 0.8 * gball(PC, NOSE, 0.02), 0, 1) * np.clip(0.75 + 0.35 * FINE, 0, 1)
    out = np.zeros((TEX_SIZE, TEX_SIZE, 4), np.float32)
    out[..., 1] = 0.62
    out[..., 3] = 1
    out[COV, 0] = sw
    out[COV, 1] = 0.64 - 0.30 * sw
    out = out.reshape(TEX_SIZE // 2, 2, TEX_SIZE // 2, 2, 4).mean(axis=(1, 3))
    save_tex("skin_rough", out, "Non-Color")


skin_sweat()


# ---- 8b. kit detail textures (UV space; greyscale albedo multiplies the per-fighter tint) ----
def glove_textures():
    n = KIT_TEX
    v = (np.arange(n) + 0.5) / n
    u = (np.arange(n) + 0.5) / n
    main = (v <= G_V_MAIN)[:, None]
    A1 = np.where(v <= G_V_MAIN, np.interp(v, G_ROW_V, G_ROWS), 0.1)
    per = np.array([TAU * math.sqrt((g_prof(a)[0] ** 2 + g_prof(a)[1] ** 2) / 2) for a in A1])
    per = np.where(v <= G_V_MAIN, np.maximum(per, 0.03), TAU * 0.022)
    su = (per / n)[:, None]
    sv = np.where(v <= G_V_MAIN, (GLOVE_TIP - GLOVE_A0) / G_V_MAIN / n, 0.12 / (1 - G_V_THUMB) / n)[:, None]
    A = A1[:, None] * np.ones((1, n))
    TH = TAU * u[None, :] * np.ones((n, 1))
    rad = (per / TAU)[:, None]
    grain = tnoise(n, 150, 350, 21)
    cr_gen = ridged(tnoise(n, 25, 60, 22), 6)
    cr_wr = ridged(tnoise(n, 18, 45, 23, ax=3.0), 5)
    cr_palm = ridged(tnoise(n, 20, 50, 24, ax=2.5), 5)
    mott = tnoise(n, 3, 10, 25)
    scn = tnoise(n, 8, 30, 26)
    wrist_m = np.exp(-((A - 0.012) / 0.03) ** 2) * main
    palm_m = np.clip(np.sin(TH), 0, 1) ** 1.5 * smoothstep(0.08, 0.14, A) * main
    knuck = smoothstep(0.12, 0.18, A) * (0.55 + 0.45 * np.clip(-np.sin(TH), 0, 1)) * main
    # seams with double stitching: cuff-to-mitt ring, both side seams, a palm centre seam
    seam = np.zeros((n, n), np.float32)
    stitch = np.zeros((n, n), np.float32)

    def add_seam(dist, along, mask):
        nonlocal seam, stitch
        seam = np.maximum(seam, np.exp(-(dist / 0.0011) ** 2) * mask)
        dots = (np.cos(TAU * along / 0.0042) > 0.2).astype(np.float32)
        for off in (0.0025, 0.0045):
            stitch = np.maximum(stitch, np.exp(-((np.abs(dist) - off) / 0.0006) ** 2) * dots * mask)

    add_seam(A - 0.034, TH * rad, main)
    side_d = np.minimum(np.abs(wrap(TH)), np.abs(wrap(TH - np.pi))) * rad
    add_seam(side_d, A, main * smoothstep(0.03, 0.04, A) * (1 - smoothstep(0.20, 0.215, A)))
    add_seam(np.abs(wrap(TH - np.pi / 2)) * rad, A, main * smoothstep(0.04, 0.05, A) * (1 - smoothstep(0.14, 0.15, A)))
    rim = (1 - smoothstep(GLOVE_A0 + 0.002, GLOVE_A0 + 0.012, A)) * main
    tipfade = 1 - smoothstep(0.19, 0.214, A)          # no detail converging on the pole of the knuckle face
    H = (0.00003 * grain - 0.00007 * cr_gen * (1 - 0.5 * knuck) - 0.0004 * cr_wr * wrist_m - 0.00035 * cr_palm * palm_m
         - 0.0007 * seam + 0.00016 * stitch) * tipfade
    crease = np.clip(0.2 * cr_gen + cr_wr * wrist_m + cr_palm * palm_m, 0, 1) * tipfade
    scuff = np.clip(knuck * (scn * 0.6 + 0.2), 0, 1) + 0.5 * rim * np.clip(scn + 0.5, 0, 1) + 0.3 * seam
    scuff = np.clip(scuff, 0, 1)
    alb = 0.80 * (1 + 0.06 * mott) * (1 - 0.42 * crease) * (1 - 0.45 * seam) * (1 - 0.25 * stitch)
    alb = alb * (1 - 0.5 * scuff) + 0.98 * 0.5 * scuff
    thumb = (~main) * 1.0
    rough = 0.50 + 0.24 * crease - 0.16 * knuck - 0.10 * thumb + 0.12 * scuff * (1 - knuck) + 0.2 * stitch + 0.03 * mott
    save_tex("glove_c", grey4(alb), "sRGB")
    save_tex("glove_n", h2n(H, su, sv), "Non-Color")
    save_tex("glove_r", grey4(rough), "Non-Color")


def trunks_textures():
    n = KIT_TEX
    v = (np.arange(n) + 0.5) / n
    u = (np.arange(n) + 0.5) / n
    TH = TAU * u[None, :] * np.ones((n, 1))
    leg = (v < 0.485)[:, None] * np.ones((1, n))
    dl = np.clip((0.47 - v) / 0.45 * DL, 0, DL)[:, None] * np.ones((1, n))
    dh = np.clip((0.98 - v) / 0.45 * DH, 0, DH)[:, None] * np.ones((1, n))
    lo = np.where(leg > 0, fold_leg(TH, dl) / 0.009, fold_hip(TH, dh) / 0.0045)
    hi = np.where(leg > 0, fold_leg(TH, dl, True), fold_hip(TH, dh, True))
    wr = ridged(tnoise(n, 18, 55, 41, ay=2.5), 5)
    H = 0.6 * hi - 0.00006 * wr + 0.000008 * tnoise(n, 300, 480, 42)
    ao = 1 - 0.30 * np.clip(-lo, 0, 1) - 0.15 * np.clip(-hi / 0.0018, 0, 1) - 0.03 * wr
    grime = 1 - 0.07 * np.clip(tnoise(n, 4, 12, 43) + 0.3, 0, 2)
    alb = 0.95 * ao * grime
    su = np.where(v < 0.485, 0.62, 1.0)[:, None] / n
    sv = np.where(v < 0.485, DL, DH)[:, None] / 0.45 / n
    save_tex("trunks_c", grey4(alb), "sRGB")
    save_tex("trunks_n", h2n(H, su, sv), "Non-Color")


def boot_textures():
    n = KIT_TEX
    v = (np.arange(n) + 0.5) / n
    u = (np.arange(n) + 0.5) / n
    TH = TAU * u[None, :] * np.ones((n, 1))
    V = v[:, None] * np.ones((1, n))
    shaft = V > 0.5
    cr = ridged(tnoise(n, 20, 50, 51), 6)
    wr = ridged(tnoise(n, 16, 40, 52, ax=3.0), 5) * np.exp(-((V - 0.56) / 0.06) ** 2)
    rad = np.where(shaft, 0.055, 0.045)
    sd = np.minimum(np.abs(wrap(TH)), np.abs(wrap(TH - np.pi))) * rad
    seam = np.exp(-(sd / 0.0011) ** 2) * shaft
    seam = np.maximum(seam, np.exp(-(((V - 0.76) * 0.17 / 0.46) / 0.0011) ** 2))
    for vv in (0.20, 0.36):
        seam = np.maximum(seam, np.exp(-(((V - vv) * 0.27 / 0.48) / 0.0011) ** 2) * (~shaft))
    H = -0.00007 * cr - 0.0004 * wr - 0.0006 * seam + 0.00002 * tnoise(n, 150, 350, 53)
    crease = np.clip(0.2 * cr + wr, 0, 1)
    alb = 0.85 * (1 - 0.4 * crease) * (1 - 0.45 * seam)
    rough = 0.42 + 0.25 * crease + 0.15 * seam
    su = (rad * TAU / n)
    sv = np.where(shaft, 0.17 / 0.46, 0.27 / 0.48) / n
    save_tex("boot_c", grey4(alb), "sRGB")
    save_tex("boot_n", h2n(H, su, sv), "Non-Color")
    save_tex("boot_r", grey4(rough), "Non-Color")


glove_textures()
trunks_textures()
boot_textures()
IMG_LABEL = save_tex("label", label_texture(), "sRGB")

# normal map from the height field (+ pores, + stubble)
H = muscle_height(PW.astype(np.float64)).astype(np.float32) * COV
pore = blur1(blur1(grain)) * PORE_AMP * 0.8   # faint and irregular: stronger reads as a woven grid
stub = HM * 0.00035 * np.clip(grain, -2, 2)
H = H + (pore + stub) * COV
hx = np.zeros_like(H)
hy = np.zeros_like(H)
sx_ = np.zeros_like(H)
sy_ = np.zeros_like(H)
dP_x = (PW[:, 2:] - PW[:, :-2]) * 0.5
dP_y = (PW[2:, :] - PW[:-2, :]) * 0.5
okx = COV[:, 2:] & COV[:, :-2] & COV[:, 1:-1]
oky = COV[2:, :] & COV[:-2, :] & COV[1:-1, :]
hx[:, 1:-1] = np.where(okx, (H[:, 2:] - H[:, :-2]) * 0.5, 0)
hy[1:-1, :] = np.where(oky, (H[2:, :] - H[:-2, :]) * 0.5, 0)
sx_[:, 1:-1] = np.linalg.norm(dP_x, axis=2)
sy_[1:-1, :] = np.linalg.norm(dP_y, axis=2)
sx_ = np.maximum(sx_, 1e-4)
sy_ = np.maximum(sy_, 1e-4)
# pore noise has no geometric footprint so clamp the world spacing to a texel-scale floor
nx = -hx / np.maximum(sx_, 0.0008) * NORMAL_STRENGTH
ny = -hy / np.maximum(sy_, 0.0008) * NORMAL_STRENGTH
ln = np.sqrt(nx * nx + ny * ny + 1.0)
nmap = np.stack([nx / ln * 0.5 + 0.5, ny / ln * 0.5 + 0.5, 1.0 / ln * 0.5 + 0.5, np.ones_like(ln)], axis=-1)
nmap[~COV] = (0.5, 0.5, 1.0, 1.0)

os.makedirs(OUT_DIR, exist_ok=True)
img_normal = make_image("skin_normal", nmap, "Non-Color")
save_webp(img_normal, os.path.join(OUT_DIR, "skin_normal" + SUFFIX + ".webp"))
img_dark = make_image("skin_dark", dark, "sRGB")
if len(argv) > 1:
    save_webp(img_dark, argv[1])
img_light = make_image("skin_light", light, "sRGB")

# ---- 9. materials ----


def tex_node(nt, img):
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = img
    return t


def mk_mat(name, rgba, rough=0.6, metal=0.0, tex=None, img=None, alpha=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        if n.type != "OUTPUT_MATERIAL":
            nt.nodes.remove(n)
    out = nt.nodes["Material Output"]
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if tex or img:
        if tex:
            img = bpy.data.images.load(tex, check_existing=True)
            img.colorspace_settings.name = "sRGB"
        t = tex_node(nt, img)
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
        if alpha:
            nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    return m


def set_mats(o, mats):
    if len(mats) > 1 and len(o.data.materials) >= len(mats):
        for i in range(len(o.data.materials)):   # keep the slots: clearing them resets material_index to 0
            o.data.materials[i] = mats[i] if i < len(mats) else mats[0]   # spare slots carry no faces
        return
    o.data.materials.clear()
    for m in mats:
        o.data.materials.append(m)


M_SKIN = mk_mat("skin", (1, 1, 1, 1), 0.58, img=img_light)
M_GLOVE = mk_mat("glove", (0.8, 0.05, 0.05, 1), 0.38)
M_TRIM = mk_mat("trim", (0.92, 0.92, 0.9, 1), 0.5)
M_TRUNKS = mk_mat("trunks", (0.8, 0.05, 0.05, 1), 0.45)
M_BOOT = mk_mat("boot", (0.12, 0.12, 0.13, 1), 0.45)
M_HAIR = mk_mat("hair", (0.04, 0.03, 0.025, 1), 0.85)
M_EYE = mk_mat("eye", (1, 1, 1, 1), 0.15, tex=os.path.join(USER_DATA, "eyes/materials/brown_eye.png"))
M_BROW = mk_mat("brow", (1, 1, 1, 1), 0.8, tex=os.path.join(USER_DATA, "eyebrows/eyebrow001/eyebrow001.png"), alpha=True)
M_LASH = mk_mat("lash", (1, 1, 1, 1), 0.8, tex=os.path.join(USER_DATA, "eyelashes/eyelashes01/eyelashes01.png"), alpha=True)
M_LABEL = mk_mat("label", (1, 1, 1, 1), 0.75, img=IMG_LABEL)
M_LACE = mk_mat("lace", (0.80, 0.77, 0.70, 1), 0.85)
M_SOCK = mk_mat("sock", (0.86, 0.85, 0.82, 1), 0.95)
M_GUARD = mk_mat("guard", (0.10, 0.35, 0.80, 1), 0.3)

# ---- 10. scalp cap: a very thin shell on the painted scalp (the paint fades out past its edge) ----
cap = base.copy()
cap.data = base.data.copy()
cap.name = "Hair"
cap.data.name = "Hair"
bpy.context.collection.objects.link(cap)
cap.parent = rig
cbm = bmesh.new()
cbm.from_mesh(cap.data)
cbm.verts.ensure_lookup_table()
cbm.normal_update()
cw = np.array([tuple(W @ v.co) for v in cbm.verts])
# the cap's (triangle-jagged) border is kept 2 cm inside the painted hairline, so the visible hairline is the
# soft painted fade and the border only meets stubble of the same colour
cm_ = hair_mask(cw - np.array([0.0, 0.0, 0.02]))
kill = [v for v, m in zip(cbm.verts, cm_) if m < 0.995]
bmesh.ops.delete(cbm, geom=kill, context="VERTS")
cbm.verts.ensure_lookup_table()
cbm.normal_update()
for v in cbm.verts:
    wz = (W @ v.co).z      # a little volume on top of the crop, thinning to nothing at the hairline
    v.co += v.normal * (0.0008 + 0.0045 * sstep(EYE_Z + 0.09, EYE_Z + 0.13, wz))
for f in cbm.faces:
    f.smooth = True
cbm.to_mesh(cap.data)
cbm.free()
parts["Hair"] = cap
print("cap tris", tris(cap))

set_mats(base, [M_SKIN])
set_mats(gloves, [M_GLOVE, M_LABEL, M_LACE])
set_mats(trunks, [M_TRUNKS, M_TRIM, M_LABEL])
set_mats(boots, [M_BOOT, M_TRIM, M_LACE, M_SOCK])
set_mats(parts["Hair"], [M_HAIR])
set_mats(parts["Eyes"], [M_EYE])
set_mats(parts["Brows"], [M_BROW])
set_mats(parts["Lashes"], [M_LASH])

# ---- 11. tidy: only bone vertex groups, armature modifier, smooth shading ----
export_objs = [base, trunks, boots, gloves, parts["Hair"], parts["Eyes"], parts["Brows"], parts["Lashes"]]
for o in export_objs:
    for g in list(o.vertex_groups):
        if g.name not in bone_names:
            o.vertex_groups.remove(g)
    for m in list(o.modifiers):
        if m.type != "ARMATURE":
            o.modifiers.remove(m)
    if not any(m.type == "ARMATURE" for m in o.modifiers):
        am = o.modifiers.new("Armature", "ARMATURE")
        am.object = rig
    for m in o.modifiers:
        if m.type == "ARMATURE":
            m.object = rig
    o.parent = rig
    for p in o.data.polygons:
        p.use_smooth = True

for o in list(bpy.data.objects):
    if o not in export_objs and o != rig:
        bpy.data.objects.remove(o, do_unlink=True)

total = 0
for o in export_objs:
    t = tris(o)
    total += t
    print("MESH %-8s verts %6d tris %6d" % (o.name, len(o.data.vertices), t))
print("TOTAL TRIS", total)
print("BONES", len(rig.data.bones))

# ---- 12. export ----
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=False, export_animations=False,
                          export_skins=True, export_apply=False, export_yup=True, export_image_format="WEBP",
                          export_image_quality=85, export_normals=True,
                          export_texcoords=True, export_materials="EXPORT")

# ---- 13. post-process the GLB json: alpha modes, double sided kit ----
with open(OUT, "rb") as f:
    blob = f.read()
magic, ver, length = struct.unpack("<4sII", blob[:12])
jlen, jtype = struct.unpack("<I4s", blob[12:20])
js = json.loads(blob[20:20 + jlen].decode("utf8"))
rest = blob[20 + jlen:]
for m in js.get("materials", []):
    if m["name"] in ("brow", "lash"):
        m["alphaMode"] = "MASK"
        m["alphaCutoff"] = 0.4
        m["doubleSided"] = True
    if m["name"] in ("glove", "trunks", "trim", "boot", "hair", "label", "lace", "sock"):
        m["doubleSided"] = True
# the runtime (src/human/body.ts) reads this to find the kit detail textures written next to the glb
js.setdefault("asset", {})["extras"] = {"look": 2, "suffix": SUFFIX}
raw = json.dumps(js, separators=(",", ":")).encode("utf8")
raw += b" " * ((4 - len(raw) % 4) % 4)
newlen = 12 + 8 + len(raw) + len(rest)
with open(OUT, "wb") as f:
    f.write(struct.pack("<4sII", magic, ver, newlen))
    f.write(struct.pack("<I4s", len(raw), jtype))
    f.write(raw)
    f.write(rest)
print("WROTE", OUT, os.path.getsize(OUT))
