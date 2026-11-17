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
TAU = 2 * math.pi

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
}
SKIN_TEX = "skins/young_caucasian_male/young_lightskinned_male_diffuse.png"
SKIN_TEX_DARK = "skins/young_african_male/young_darkskinned_male_diffuse.png"
TEX_SIZE = 2048
DARK_TARGET_MEAN = 0.30     # sRGB-encoded mean the dark diffuse is lifted to (the pack's own file is ~black under our lights)
LIGHT_TARGET_MEAN = 0.0     # 0 = leave the light diffuse alone
STUBBLE_RGB = (0.085, 0.062, 0.050)   # sRGB, scalp painted under the cap
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
BOOT_TOP = ankle_z + 0.215

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
    inscr = gauss((1 - cell) * row_h * 0.5, 0.0075)
    col_w = 0.046
    xs = (ax - col_w * 0.62) / (col_w * 0.5)
    ab_x = np.exp(-np.maximum(xs, 0) ** 4) * 1.0     # bulge width across a column
    alba = gauss(ax, 0.0055)
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


def build_segments(name, segments, mat_fn, n):
    """segments: list of lists of rings (each ring: list of n world Vectors). Each segment is a separate
    surface (own vertices) so creases between segments stay crisp. mat_fn(seg, row, col) -> material index."""
    bm = bmesh.new()
    for si, rings in enumerate(segments):
        vs = [[bm.verts.new(INV @ p) for p in ring] for ring in rings]
        for i in range(len(vs) - 1):
            for k in range(n):
                k2 = (k + 1) % n
                f = bm.faces.new((vs[i][k], vs[i + 1][k], vs[i + 1][k2], vs[i][k2]))
                f.material_index = mat_fn(si, i, k)
                f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for ph in PLACEHOLDERS:      # without slots Blender drops material_index on join
        me.materials.append(ph)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.parent = rig
    return ob


PLACEHOLDERS = [bpy.data.materials.new("ph0"), bpy.data.materials.new("ph1")]


def ring_pts(cx, cy, z, radii, n, off):
    return [Vector((cx + (radii[k] + off) * math.cos(TAU * k / n), cy + (radii[k] + off) * math.sin(TAU * k / n), z))
            for k in range(n)]


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


def trunks_build():
    # hip / waist tube
    zs_band = [Z_TOP, Z_TOP - 0.022, Z_TOP - 0.045]
    band_off = [0.012, 0.019, 0.014]
    hip_z = [Z_TOP - 0.045] + HIP_ROWS_Z[1:]
    cy0 = float(np.mean([bbox_center(nonarm, z, 0.02)[1] for z in hip_z]))
    prof_h = [profile(nonarm, z, 0.02, 0.0, cy0, NT) for z in hip_z]
    prof_h = np.array(prof_h)
    for k in range(NT):
        prof_h[:, k] = smooth_rows(prof_h[:, k])
    seg_band = []
    p_top = profile(nonarm, Z_TOP, 0.02, 0.0, cy0, NT)
    p_bot = prof_h[0]
    for z, off, f in zip(zs_band, band_off, [0.0, 0.5, 1.0]):
        seg_band.append(ring_pts(0.0, cy0, z, p_top * (1 - f) + p_bot * f, NT, off))
    seg_hip = []
    for i, z in enumerate(hip_z):
        off = 0.016 + 0.006 * i / (len(hip_z) - 1)
        seg_hip.append(ring_pts(0.0, cy0, z, prof_h[i], NT, off))
    segs = [seg_band, seg_hip]

    def mat_hip(si, i, k):
        if si == 0:
            return 1
        return 1 if k in (NT - 1, 0, NT // 2 - 1, NT // 2) else 0

    hip = build_segments("TrunksHip", segs, mat_hip, NT)
    legs = []
    for side in (1.0, -1.0):
        sel = nonarm & (Vw[:, 0] * side > -0.006) & (~is_foot)
        rows_z = list(np.linspace(LEG_TOP, Z_HEM + 0.03, 8))
        cs = np.array([bbox_center(sel, z, 0.02) for z in rows_z])
        cxs, cys = smooth_rows(cs[:, 0]), smooth_rows(cs[:, 1])
        prof = np.array([profile(sel, z, 0.02, cxs[i], cys[i], NT) for i, z in enumerate(rows_z)])
        for k in range(NT):
            prof[:, k] = smooth_rows(prof[:, k])
        body_rows = []
        for i, z in enumerate(rows_z):
            t = i / (len(rows_z) - 1)
            off = 0.015 + 0.020 * t          # loose, flaring towards the hem
            body_rows.append(ring_pts(cxs[i], cys[i], z, prof[i], NT, off))
        # hem band (separate segment, crisp edge), straight
        zb = [Z_HEM + 0.03, Z_HEM]
        offh = 0.015 + 0.020 + 0.002
        hem = [ring_pts(cxs[-1], cys[-1], z, prof[-1], NT, offh) for z in zb]
        out_k = 0 if side > 0 else NT // 2

        def mat_leg(si, i, k, out_k=out_k):
            if si == 1:
                return 1
            return 1 if k in (out_k, (out_k - 1) % NT) else 0

        leg = build_segments("TrunksLeg", [body_rows, hem], mat_leg, NT)
        leg.parent = rig
        legs.append((leg, side))
    return hip, legs


hip_ob, leg_obs = trunks_build()
for ob in (hip_ob,):
    transfer_weights(ob, lambda wp: kd_all)
    smooth_weights(ob, 1)
for ob, side in leg_obs:
    transfer_weights(ob, lambda wp, side=side: kd_side[side])
    smooth_weights(ob, 1)
select_only(hip_ob)
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
        # lace strip: the two columns over the top of the foot, from the toe box back to the ankle
        s = ss[i]
        if k in (NS // 4 - 1, NS // 4) and s < s1 - 0.075 and s > ss[0] + 0.06:
            return 1
        return 0

    a = build_segments("BootUpper", [up], mat_up, NS)
    b = build_segments("BootSole", [sole], lambda si, i, k: 1, NS)

    def mat_shaft(si, i, k):
        if si == 1:
            return 1
        return 1 if k in (kf, (kf - 1) % NB) and i >= 1 else 0

    c = build_segments("BootShaft", [shaft, collar], mat_shaft, NB)
    return [a, b, c]


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
    for ob, kind in zip(boot_objects(side), ("foot", "foot", "shaft")):
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

# ---- 7. gloves (10 oz: about 26 cm with the cuff, clearly bigger than the fist) ----


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

    bm = bmesh.new()
    ret = bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=20, radius=1.0)
    for v in ret["verts"]:
        x, y, z = v.co
        a = 0.112 + 0.102 * z
        taper = 1.0 + 0.08 * z
        b = 0.071 * x * taper
        c = 0.012 + 0.069 * y * taper
        v.co = at(a, b, c)
    ret = bmesh.ops.create_uvsphere(bm, u_segments=18, v_segments=12, radius=1.0)
    for v in ret["verts"]:
        x, y, z = v.co
        v.co = at(0.078 + 0.058 * z, 0.071 + 0.026 * x, 0.040 + 0.030 * y)
    ret = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=28, radius1=0.050, radius2=0.060, depth=1.0)
    cuff_verts = ret["verts"]
    for v in cuff_verts:
        x, y, z = v.co
        a = -0.060 + 0.108 * (z + 0.5)
        v.co = at(a, x * 1.06, y)
    # lace strap over the back of the cuff
    ret = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=28, radius1=0.0625, radius2=0.0625, depth=1.0)
    strap_verts = ret["verts"]
    for v in strap_verts:
        x, y, z = v.co
        v.co = at(0.050 + 0.020 * (z + 0.5), x * 1.07, y)
    bm.verts.ensure_lookup_table()
    strap_set = set(strap_verts)
    cuff_set = set(cuff_verts)
    for f in bm.faces:
        f.smooth = True
        vs = f.verts
        if all(v in strap_set for v in vs):
            f.material_index = 1
        elif all(v in cuff_set for v in vs):
            ac = sum((v.co - wrist).dot(dd) for v in vs) / len(vs)
            f.material_index = 1 if ac < -0.05 else 0
        else:
            f.material_index = 0
    me = bpy.data.meshes.new("Glove" + side)
    for v in bm.verts:
        v.co = INV @ v.co
    bm.to_mesh(me)
    bm.free()
    for ph in PLACEHOLDERS:
        me.materials.append(ph)
    ob = bpy.data.objects.new("Glove" + side, me)
    bpy.context.collection.objects.link(ob)
    ob.parent = rig
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


print("light diffuse")
light = paint_scalp(lift(load_tex(SKIN_TEX), LIGHT_TARGET_MEAN))
print("dark diffuse")
dark = paint_scalp(lift(load_tex(SKIN_TEX_DARK), DARK_TARGET_MEAN))

# normal map from the height field (+ pores, + stubble)
H = muscle_height(PW.astype(np.float64)).astype(np.float32) * COV
pore = blur1(grain) * PORE_AMP * 2.2
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
save_webp(img_normal, os.path.join(OUT_DIR, "skin_normal.webp"))
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
    if len(mats) > 1 and len(o.data.materials) == len(mats):
        for i, m in enumerate(mats):     # keep the slots: clearing them resets material_index to 0
            o.data.materials[i] = m
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
cm_ = hair_mask(cw) * (np.arange(len(cw)) >= 0)
kill = [v for v, m in zip(cbm.verts, cm_) if m < 0.995]
bmesh.ops.delete(cbm, geom=kill, context="VERTS")
cbm.verts.ensure_lookup_table()
cbm.normal_update()
for v in cbm.verts:
    v.co += v.normal * 0.0012
for f in cbm.faces:
    f.smooth = True
cbm.to_mesh(cap.data)
cbm.free()
parts["Hair"] = cap
print("cap tris", tris(cap))

set_mats(base, [M_SKIN])
set_mats(gloves, [M_GLOVE, M_TRIM])
set_mats(trunks, [M_TRUNKS, M_TRIM])
set_mats(boots, [M_BOOT, M_TRIM])
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
    if m["name"] in ("glove", "trunks", "trim", "boot", "hair"):
        m["doubleSided"] = True
raw = json.dumps(js, separators=(",", ":")).encode("utf8")
raw += b" " * ((4 - len(raw) % 4) % 4)
newlen = 12 + 8 + len(raw) + len(rest)
with open(OUT, "wb") as f:
    f.write(struct.pack("<4sII", magic, ver, newlen))
    f.write(struct.pack("<I4s", len(raw), jtype))
    f.write(raw)
    f.write(rest)
print("WROTE", OUT, os.path.getsize(OUT))
