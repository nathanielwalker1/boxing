# Meshy generation -> game fighter. Run through tools/blender/build_meshy.mjs (npm run asset:meshy), never directly.
# argv after "--": <cache dir with the unzipped FBX + PNGs> <out glb> <suffix e.g. _m1> <screenshot dir> <probe|build>
#
# Steps: import the FBX (one mesh, no rig, T-pose, Z up, facing -Y), scale to 1.80 m with the feet on z=0;
# measure the joints from the mesh (cross sections); decimate to ~45k triangles (denser at the joints and face);
# build the 52-bone Mixamo-named skeleton for this body; bone-heat weights, then rule fixes (gloves, boots, trunks,
# head); bake region masks from the texture; export the glb + WebP textures (atomic rename).
import bpy, bmesh, sys, os, math, json, struct, time
import numpy as np
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
CACHE, OUT, SUFFIX, SHOTS, MODE = argv[:5]
GLOVE_CACHE, GLOVE_NAME = (argv[5], argv[6]) if len(argv) > 6 else (None, "g1")
TRUNKS_CACHE, TRUNKS_NAME = (argv[7], argv[8]) if len(argv) > 8 else (None, "t1")
UNDER = argv[9] if len(argv) > 9 else "shorts"   # what the body wears under the trunks part: moulded "shorts" or "briefs" (bare legs)
H = 1.80                    # target standing height (m)
TRI_TARGET = 45000
T0 = time.time()
def log(*a):
    print("[meshy %5.1fs]" % (time.time() - T0), *a, flush=True)

files = os.listdir(CACHE)
FBX = os.path.join(CACHE, next(f for f in files if f.lower().endswith(".fbx")))
def tex(tag):
    for f in files:
        b = f.lower()
        if b.endswith(".png") and (b.endswith("_%s.png" % tag) if tag else not any(b.endswith("_%s.png" % t) for t in ("normal", "roughness", "metallic"))):
            return os.path.join(CACHE, f)
    raise SystemExit("texture missing: " + (tag or "base colour"))
TEX_C, TEX_N, TEX_R, TEX_M = tex(""), tex("normal"), tex("roughness"), tex("metallic")

# ---------------------------------------------------------------- 1. import + normalise
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.fbx(filepath=FBX)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for o in list(bpy.data.objects):
    if o.type != "MESH":
        bpy.data.objects.remove(o, do_unlink=True)
body = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
body.name = "Body"
body.parent = None
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

def verts(o):
    a = np.empty(len(o.data.vertices) * 3, dtype=np.float32)
    o.data.vertices.foreach_get("co", a)
    return a.reshape(-1, 3)

V = verts(body)
lo, hi = V.min(0), V.max(0)
s = H / (hi[2] - lo[2])
off = np.array([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])
body.data.transform(Matrix.Translation(Vector(off.tolist())))
body.data.transform(Matrix.Scale(s, 4))
V = verts(body)
log("tris in", sum(len(p.vertices) - 2 for p in body.data.polygons), "verts", len(V), "scale", round(s, 4),
    "bbox", np.round(V.min(0), 3).tolist(), np.round(V.max(0), 3).tolist())
X, Y, Z = V[:, 0], V[:, 1], V[:, 2]

# ---------------------------------------------------------------- 2. measure the joints (cross sections)
def rng(m, a):
    return (float(a[m].min()), float(a[m].max())) if m.any() else (None, None)

def arm_profile():
    rows = []
    for xi in np.arange(0.10, 0.96, 0.01):
        m = (np.abs(X) >= xi) & (np.abs(X) < xi + 0.01) & (Z > 0.95) & (X > 0)
        zl, zh = rng(m, Z); yl, yh = rng(m, Y)
        rows.append((round(float(xi), 2), zl, zh, yl, yh))
    return rows
ARM = arm_profile()
if MODE == "probe":
    print("ARM x: zmin zmax ymin ymax (left side, z>0.95)")
    print(" ".join("%.2f:%.3f/%.3f/%.3f/%.3f" % r for r in ARM if r[1] is not None))
    print("CENTRE counts |x|<0.012 by z")
    print(" ".join("%.2f:%d" % (z, int(((np.abs(X) < 0.012) & (Z >= z) & (Z < z + 0.01)).sum())) for z in np.arange(0.60, 1.05, 0.01)))
    print("TORSO z: xwidth(|x|<0.28) ymin ymax")
    print(" ".join("%.2f:%.3f/%.3f/%.3f" % ((z,) + ((lambda m: (float(X[m].max() - X[m].min()), float(Y[m].min()), float(Y[m].max())))((np.abs(X) < 0.28) & (Z >= z) & (Z < z + 0.01))))
                   for z in np.arange(0.90, 1.80, 0.02)))
    print("LEG (x>0.02) z: xmin xmax ymin ymax")
    print(" ".join("%.2f:%.3f/%.3f/%.3f/%.3f" % ((z,) + ((lambda m: (float(X[m].min()), float(X[m].max()), float(Y[m].min()), float(Y[m].max())))((X > 0.02) & (Z >= z) & (Z < z + 0.01))))
                   for z in np.arange(0.0, 0.90, 0.02)))
    hm = Z > 1.55
    print("HEAD y range", rng(hm, Y), "nose side = the smaller y if |ymin|>|ymax|")

# ---------------------------------------------------------------- material (preview + export) and renders
def load_img(path, colour):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return img

def preview_material(o):
    mat = bpy.data.materials.new("body")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = load_img(TEX_C, True)
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    o.data.materials.clear()
    o.data.materials.append(mat)
    return mat

def render(tag, objs_hide=(), views=("front", "back", "side")):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "TEXTURE"
    sc.render.resolution_x, sc.render.resolution_y = 600, 900
    sc.render.film_transparent = False
    cam = bpy.data.objects.get("Cam")
    if cam is None:
        cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
        sc.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 2.0
    sc.camera = cam
    for v in views:
        if v == "front":   cam.location = (0, -4, 0.92); cam.rotation_euler = (math.pi / 2, 0, 0)
        elif v == "back":  cam.location = (0, 4, 0.92);  cam.rotation_euler = (math.pi / 2, 0, math.pi)
        elif v == "side":  cam.location = (4, 0, 0.92);  cam.rotation_euler = (math.pi / 2, 0, math.pi / 2)
        elif v == "face":
            cam.data.ortho_scale = 0.45; cam.location = (0, -4, 1.62); cam.rotation_euler = (math.pi / 2, 0, 0)
        elif v == "hand":
            cam.data.ortho_scale = 0.5; cam.location = (0.72, -4, 1.42); cam.rotation_euler = (math.pi / 2, 0, 0)
        sc.render.filepath = os.path.join(SHOTS, "meshy_%s_%s.png" % (tag, v))
        bpy.ops.render.render(write_still=True)
        cam.data.ortho_scale = 2.0
    log("rendered", tag, views)

preview_material(body)
if MODE == "probeglove":
    bpy.data.objects.remove(body, do_unlink=True)
    gf = [f for f in os.listdir(GLOVE_CACHE)]
    print("GLOVE files", gf)
    bpy.ops.import_scene.fbx(filepath=os.path.join(GLOVE_CACHE, next(f for f in gf if f.lower().endswith(".fbx"))))
    gm = [o for o in bpy.data.objects if o.type == "MESH"]
    for o in gm:
        print("GLOVE obj", o.name, "tris", sum(len(p.vertices) - 2 for p in o.data.polygons), "loc", tuple(o.location), "rot", tuple(o.rotation_euler), "scale", tuple(o.scale))
    g = gm[0]
    G = np.array([(g.matrix_world @ v.co)[:] for v in g.data.vertices])
    print("GLOVE bbox", np.round(G.min(0), 3).tolist(), np.round(G.max(0), 3).tolist())
    for a in range(3):
        lo_, hi_ = G[:, a].min(), G[:, a].max()
        row = []
        for k in range(10):
            m = (G[:, a] >= lo_ + (hi_ - lo_) * k / 10) & (G[:, a] < lo_ + (hi_ - lo_) * (k + 1) / 10)
            o1, o2 = [i for i in range(3) if i != a]
            row.append("%d:%.2fx%.2f" % (k, np.ptp(G[m, o1]) if m.any() else 0, np.ptp(G[m, o2]) if m.any() else 0))
        print("GLOVE axis", "xyz"[a], "slices (extent of other two axes):", " ".join(row))
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"; sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "TEXTURE"
    sc.render.resolution_x = sc.render.resolution_y = 400
    gmat = bpy.data.materials.new("g"); gmat.use_nodes = True
    t = gmat.node_tree.nodes.new("ShaderNodeTexImage"); t.image = load_img(os.path.join(GLOVE_CACHE, next(f for f in gf if f.lower().endswith("texture.png"))), True)
    gmat.node_tree.links.new(t.outputs["Color"], gmat.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    g.data.materials.clear(); g.data.materials.append(gmat)
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam")); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = "ORTHO"; cam.data.ortho_scale = 2.4
    for v, loc, rot in (("negy", (0, -5, 0), (math.pi / 2, 0, 0)), ("posz", (0, 0, 5), (0, 0, 0)), ("posx", (5, 0, 0), (math.pi / 2, 0, math.pi / 2))):
        cam.location = loc; cam.rotation_euler = rot
        sc.render.filepath = os.path.join(SHOTS, "glove_probe_%s.png" % v)
        bpy.ops.render.render(write_still=True)
    raise SystemExit(0)
if MODE == "probe":
    render("before", views=("front", "back", "side", "face", "hand"))
    Mt = bpy.data.images.load(TEX_M)
    px = np.empty(Mt.size[0] * Mt.size[1] * 4, dtype=np.float32); Mt.pixels.foreach_get(px)
    print("METALLIC max", float(px.reshape(-1, 4)[:, 0].max()), "mean", float(px.reshape(-1, 4)[:, 0].mean()))
    raise SystemExit(0)

# ---- joints, located from the cross sections above (left side, Blender coords: x left, -y front, z up) ----
def first(rows, pred):
    for i in range(1, len(rows)):
        if pred(rows[i], rows[i - 1]): return rows[i]
    raise SystemExit("joint search failed")
ARM = [r for r in ARM if r[1] is not None]
yw = lambda r: r[4] - r[3]
armpit = first(ARM, lambda r, p: r[1] > 1.2)[0]                      # the arm's underside leaves the torso
cuff = first([r for r in ARM if r[0] >= 0.5], lambda r, p: yw(r) - yw(p) > 0.006)[0]   # glove cuff: depth jumps
wrist = first([r for r in ARM if r[0] >= cuff + 0.04], lambda r, p: yw(r) - yw(p) > 0.01)[0] - 0.005  # hand part starts
tip = float(X.max())
def arm_centre(x):
    r = min(ARM, key=lambda r: abs(r[0] - x))
    return ((r[3] + r[4]) / 2, (r[1] + r[2]) / 2)    # (y, z)
sh_x = armpit - 0.015
sh_y, sh_z = arm_centre(armpit + 0.06)
wr_y, wr_z = arm_centre(wrist - 0.09)                 # forearm axis (the hand part of the glove is offset), at the MEASURED wrist
# REFERENCE SKELETON (2026-11-24): the clips, the hit tracking and humanGloveOffset are calibrated on m1, so every Meshy
# body is rigged onto m1's arm lengths and neck height (rest joints read from public/fighter/boxer_m1.glb), and its
# glove tip sits m1's distance past the hand bone. A mitten measured long (m2: wrist found 8 cm up the arm, glove tip
# 34.6 cm past the hand vs m1's 21.8) drew every guard and head punch 10-19 cm high. The mesh follows the skeleton.
REF_SH_X, REF_WRIST_X, REF_NECK_Z, REF_TIP = 0.175, 0.685, 1.51, 0.218
log("reference skeleton: shoulder x %.3f -> %.3f, wrist x %.3f -> %.3f, neck z (measured below) -> %.3f, glove tip %.3f past the wrist"
    % (sh_x, REF_SH_X, wrist, REF_WRIST_X, REF_NECK_Z, REF_TIP))
if UNDER == "briefs":
    # the new bare bodies differ in build (a fat man's arm leaves the torso 13 cm further out and his wrist sits 6 cm
    # further out). Reach is the reference skeleton's on every body, so the ARM MESH is scaled along x, armpit fixed,
    # until its measured wrist is on the reference wrist; the joints are then measured again on the scaled arm.
    _k = (REF_WRIST_X - armpit) / (wrist - armpit)
    _sel = (np.abs(X) > armpit) & (Z > 1.2)
    V[_sel, 0] = np.sign(X[_sel]) * (armpit + (np.abs(X[_sel]) - armpit) * _k)
    body.data.vertices.foreach_set("co", V.ravel()); body.data.update()
    X, Y, Z = V[:, 0], V[:, 1], V[:, 2]
    ARM = [r for r in arm_profile() if r[1] is not None]
    _w0 = wrist
    cuff = first([r for r in ARM if r[0] >= 0.5], lambda r, p: yw(r) - yw(p) > 0.006)[0]
    wrist = first([r for r in ARM if r[0] >= cuff + 0.04], lambda r, p: yw(r) - yw(p) > 0.01)[0] - 0.005
    tip = float(X.max())
    sh_y, sh_z = arm_centre(armpit + 0.06)
    wr_y, wr_z = arm_centre(wrist - 0.09)
    log("arm mesh scaled x%.3f from the armpit (%.3f): wrist %.3f -> %.3f, cuff %.3f, tip %.3f" % (_k, armpit, _w0, wrist, cuff, tip))
sh_x, wrist = REF_SH_X, REF_WRIST_X
GLOVE_TIP = wrist + REF_TIP                           # the fitted glove's tip (|x|); was the old mitten's tip
el_x = sh_x + 0.54 * (wrist - sh_x)                   # humerus : forearm ~ 0.31 : 0.26 of stature
el_y, el_z = arm_centre(el_x)
def slice_c(m):
    return (float((X[m].min() + X[m].max()) / 2), float((Y[m].min() + Y[m].max()) / 2))
tw = [(z, (lambda m: float(X[m].max() - X[m].min()))((np.abs(X) < 0.28) & (Z >= z) & (Z < z + 0.01))) for z in np.arange(1.45, 1.60, 0.01)]
neck_z = next(z for z, w in tw if w < 0.30)          # top of the shoulders: the slice narrows to the neck
log("neck z measured %.3f, rigged at the reference %.3f" % (neck_z, REF_NECK_Z))
neck_z = REF_NECK_Z
head_z = neck_z + 0.065                               # skull base, level with the mouth
_, neck_y = slice_c((np.abs(X) < 0.08) & (Z >= neck_z + 0.02) & (Z < neck_z + 0.03))
leg = lambda z0: (X > 0.02) & (Z >= z0) & (Z < z0 + 0.01)
yd = [(z, float(Y[leg(z)].max() - Y[leg(z)].min())) for z in np.arange(0.42, 0.58, 0.01)]
knee_z = float(min(yd, key=lambda t: t[1])[0])        # narrowest leg depth between thigh and calf
knee_x, knee_y = slice_c(leg(knee_z))
ank_z = 0.047 * H                                     # hidden in the boot: stature proportion
ank_x, ank_y = slice_c(leg(0.10))
toe_tip = float(Y[(Z < 0.04) & (X > 0)].min())
ball_y = ank_y + 0.71 * (toe_tip - ank_y)
boot_top = 0.15 * H                                   # boot shaft top (0.27 m in the renders)
upleg_z, hips_z = 0.517 * H, 0.545 * H                # inside the trunks: stature proportions (Mixamo / MakeHuman)
hem_z, band_z = 0.68, 1.11                            # trunks hem and waistband top (renders)
J = {
    "Hips": (0, 0.005, hips_z), "Spine": (0, 0.02, 1.09), "Spine1": (0, 0.025, 1.18), "Spine2": (0, 0.03, 1.31),
    "Neck": (0, neck_y, neck_z), "Head": (0, neck_y - 0.005, head_z),
    "LeftShoulder": (0.06, 0.03, sh_z + 0.03), "LeftArm": (sh_x, sh_y, sh_z), "LeftForeArm": (el_x, el_y, el_z),
    "LeftHand": (wrist, wr_y, wr_z),
    "LeftUpLeg": (0.095, 0.005, upleg_z), "LeftLeg": (knee_x, knee_y, knee_z), "LeftFoot": (ank_x, ank_y, ank_z),
    "LeftToeBase": (ank_x + 0.015, ball_y, 0.025),
}
# fingers inside the glove: a fist's knuckles ~9 cm past the wrist, chains straight along the arm; index at the
# front (-y), pinky at the back, so the palm line (index root -> pinky root) matches the source's T-pose
kx = wrist + 0.09
for f, dy, dz, dx in (("Index", -0.025, 0.004, 0), ("Middle", -0.005, 0.002, 0.005), ("Ring", 0.015, 0, 0), ("Pinky", 0.033, -0.004, -0.012)):
    for i in range(3):
        J["LeftHand%s%d" % (f, i + 1)] = (kx + dx + 0.03 * i, wr_y + dy, wr_z + dz)
for i, (dx, dy, dz) in enumerate(((0.025, -0.03, -0.015), (0.05, -0.045, -0.02), (0.075, -0.055, -0.022))):
    J["LeftHandThumb%d" % (i + 1)] = (wrist + dx, wr_y + dy, wr_z + dz)
for k in list(J):
    if k.startswith("Left"):
        x, y, z = J[k]
        J["Right" + k[4:]] = (-x, y, z)
# the old mitten (left): the swappable glove is fitted to this box, so the drawn glove keeps its size (= hit size)
_om = (X > cuff) & (Z > 1.2)
OLD_GLOVE = (V[_om].min(0), V[_om].max(0))
log("old mitten bbox cm: size %s  min %s max %s" % (np.round(100 * (OLD_GLOVE[1] - OLD_GLOVE[0]), 1).tolist(),
    np.round(100 * OLD_GLOVE[0], 1).tolist(), np.round(100 * OLD_GLOVE[1], 1).tolist()))
if UNDER == "briefs":
    # the new bare bodies (2026-11-24) come with any hand: a fat mitten, a bare fist. The glove is the same size on
    # every one of them, m2's (18.6 x 13.5 cm section, the size the hits were checked on), centred on this hand.
    REF_GLOVE_YZ = np.array([0.186, 0.135])
    _c = (OLD_GLOVE[0][1:] + OLD_GLOVE[1][1:]) / 2
    OLD_GLOVE[0][1:] = _c - REF_GLOVE_YZ / 2
    OLD_GLOVE[1][1:] = _c + REF_GLOVE_YZ / 2
    log("glove box set to the reference section 18.6 x 13.5 cm, centred y %.3f z %.3f" % (_c[0], _c[1]))
sm = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))

# ---- the glove source, imported early: its own proportions set where its cuff opening lands on the arm ----
# One LEFT glove (closed fist) from its own Meshy zip (GLOVE_ZIP). Fit: the fist's width / height (y, z) to the old
# mitten's box, x scaled by their mean (the model's own proportions, no stretch), the tip on the old tip. The fist
# then keeps its drawn size and place (= hit size) and the cuff ends where the model's cuff ends.
def glove_source():
    gfiles = os.listdir(GLOVE_CACHE)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(GLOVE_CACHE, next(f for f in gfiles if f.lower().endswith(".fbx"))))
    new = [o for o in bpy.data.objects if o not in before]
    gm = [o for o in new if o.type == "MESH"]
    for o in new:
        if o.type != "MESH": bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    for o in gm: o.select_set(True)
    bpy.context.view_layer.objects.active = gm[0]
    if len(gm) > 1: bpy.ops.object.join()
    hi = gm[0]; hi.parent = None; hi.name = "GloveHigh"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # source pose (probed): fingers +x, palm -y, thumb +z -> rotate +90 deg about x: palm -z, thumb -y (left T-pose hand)
    hi.data.transform(Matrix.Rotation(math.pi / 2, 4, "X"))
    hi.hide_render = True
    G = verts(hi).astype(np.float64)
    glo, ghi = G.min(0), G.max(0)
    sc_ = (OLD_GLOVE[1] - OLD_GLOVE[0]) / (ghi - glo)
    sx = 0.5 * (sc_[1] + sc_[2])
    # the cuff tube's section where the forearm goes in (first 8% of the length), in fitted body coordinates
    cm = G[:, 0] < glo[0] + 0.08 * (ghi[0] - glo[0])
    fit = lambda a, v: OLD_GLOVE[0][a] + (v - glo[a]) * sc_[a]   # y / z only (x: the tip on GLOVE_TIP)
    cuffsec = ((fit(1, G[cm, 1].min()) + fit(1, G[cm, 1].max())) / 2, (fit(2, G[cm, 2].min()) + fit(2, G[cm, 2].max())) / 2,
               np.ptp(G[cm, 1]) * sc_[1] / 2, np.ptp(G[cm, 2]) * sc_[2] / 2)
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body     # later steps act on the active object
    return hi, sc_, sx, float(GLOVE_TIP - (ghi[0] - glo[0]) * sx), cuffsec
GLOVE_HI, GLOVE_SC, GLOVE_SX, GLOVE_OPEN, GLOVE_CUFFSEC = glove_source()
GLOVE_CUT = GLOVE_OPEN + 0.015   # body faces past this (|x|, arm height) are deleted: 1.5 cm of forearm inside the cuff
if UNDER == "briefs" and not cuff < GLOVE_OPEN - 0.01:
    log("this body's own cuff starts at %.3f, inside the fitted glove (opening %.3f): the forearm is tapered into the opening from %.3f" % (cuff, GLOVE_OPEN, GLOVE_OPEN - 0.03))
    cuff = GLOVE_OPEN - 0.03
if not cuff < GLOVE_OPEN - 0.01: raise SystemExit("glove opening %.3f not past the old cuff %.3f" % (GLOVE_OPEN, cuff))
GRIP = min(wrist, GLOVE_OPEN)    # the forearm stub from here on is inside the glove: rigid to the Hand (weights, step 5)
log("glove: opening at |x| %.3f (wrist joint %.3f, old cuff %.3f), length %.1f cm; body cut at %.3f"
    % (GLOVE_OPEN, wrist, cuff, 100 * (GLOVE_TIP - GLOVE_OPEN), GLOVE_CUT))
# the old mitten between its cuff line and the new cut becomes forearm: an elliptical tube continuing the forearm's
# section just above the old cuff (tapering a little to the wrist), blended in over 3 cm so the seam does not show
for s in (1, -1):
    ref = (s * X > cuff - 0.035) & (s * X < cuff - 0.015) & (Z > 1.2)
    cy0, cz0 = (Y[ref].min() + Y[ref].max()) / 2, (Z[ref].min() + Z[ref].max()) / 2
    ry0, rz0 = (Y[ref].max() - Y[ref].min()) / 2, (Z[ref].max() - Z[ref].min()) / 2
    zone = np.nonzero((s * X > cuff - 0.015) & (s * X <= GLOVE_CUT + 0.03) & (Z > 1.2))[0]
    xs = s * X[zone]
    # centre and radii run from the forearm's (at the old cuff line) to just inside the glove's cuff (at its opening)
    gcy, gcz, gry, grz = GLOVE_CUFFSEC
    u = sm(cuff, GLOVE_OPEN, xs)
    cy_, cz_ = cy0 + u * (gcy - cy0), cz0 + u * (gcz - cz0)
    ry_, rz_ = ry0 + u * (0.88 * gry - ry0), rz0 + u * (0.88 * grz - rz0)
    dy, dz = Y[zone] - cy0, Z[zone] - cz0
    ang = np.arctan2(dz / rz0, dy / ry0)
    ny_, nz_ = cy_ + ry_ * np.cos(ang), cz_ + rz_ * np.sin(ang)
    b = sm(cuff - 0.015, cuff + 0.015, xs)
    V[zone, 1] = Y[zone] + b * (ny_ - Y[zone])
    V[zone, 2] = Z[zone] + b * (nz_ - Z[zone])
    log("forearm tube side %d: %d verts, section %.1f x %.1f cm at the old cuff -> %.1f x %.1f cm in the glove opening"
        % (s, len(zone), 200 * ry0, 200 * rz0, 200 * 0.88 * gry, 200 * 0.88 * grz))
body.data.vertices.foreach_set("co", V.astype(np.float32).ravel())
body.data.update()
V = verts(body)
X, Y, Z = V[:, 0], V[:, 1], V[:, 2]
log("joints: armpit %.3f cuff %.3f wrist %.3f tip %.3f elbow %.3f neck %.3f head %.3f knee %.3f (x %.3f) ankle x %.3f y %.3f ball y %.3f"
    % (armpit, cuff, wrist, tip, el_x, neck_z, head_z, knee_z, knee_x, ank_x, ank_y, ball_y))

PARENT = {"Hips": None, "Spine": "Hips", "Spine1": "Spine", "Spine2": "Spine1", "Neck": "Spine2", "Head": "Neck"}
for s in ("Left", "Right"):
    PARENT.update({s + "Shoulder": "Spine2", s + "Arm": s + "Shoulder", s + "ForeArm": s + "Arm", s + "Hand": s + "ForeArm",
                   s + "UpLeg": "Hips", s + "Leg": s + "UpLeg", s + "Foot": s + "Leg", s + "ToeBase": s + "Foot"})
    for f in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
        for i in (1, 2, 3):
            PARENT["%sHand%s%d" % (s, f, i)] = s + "Hand" if i == 1 else "%sHand%s%d" % (s, f, i - 1)
assert len(PARENT) == 52 and set(PARENT) == set(J)
CHILD = {"Hips": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Neck", "Neck": "Head"}
for s in ("Left", "Right"):
    CHILD.update({s + "Shoulder": s + "Arm", s + "Arm": s + "ForeArm", s + "ForeArm": s + "Hand", s + "Hand": s + "HandMiddle1",
                  s + "UpLeg": s + "Leg", s + "Leg": s + "Foot", s + "Foot": s + "ToeBase"})
    for f in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
        CHILD.update({"%sHand%s1" % (s, f): "%sHand%s2" % (s, f), "%sHand%s2" % (s, f): "%sHand%s3" % (s, f)})

# ---------------------------------------------------------------- 2b. delete the skin hidden under the shorts
# Meshy models the thighs / hips inside the trunks. A raised thigh then pokes through the hem (and the bake can pick
# the hidden skin up). A face in the trunk band is hidden when every ray into its outward hemisphere hits the mesh.
from mathutils.bvhtree import BVHTree
bm = bmesh.new()
bm.from_mesh(body.data)
bm.faces.ensure_lookup_table()
bvh = BVHTree.FromBMesh(bm)
gold = math.pi * (3 - math.sqrt(5))
DIRS = [Vector((math.cos(gold * i) * math.sqrt(1 - (1 - 2 * (i + 0.5) / 24) ** 2), math.sin(gold * i) * math.sqrt(1 - (1 - 2 * (i + 0.5) / 24) ** 2), 1 - 2 * (i + 0.5) / 24)) for i in range(24)]
hidden = []
mitten = []
for f in bm.faces:
    c = f.calc_center_median()
    if abs(c.x) > GLOVE_CUT and c.z > 1.2:
        mitten.append(f)
        continue
    if not (hem_z - 0.03 < c.z < band_z and abs(c.x) < 0.30):
        continue
    n = f.normal
    used = 0
    for d in DIRS:
        if d.dot(n) < 0.15:
            continue
        used += 1
        if bvh.ray_cast(c + n * 0.002, d, 0.5)[0] is None:
            used = -1
            break
    if used >= 4:
        hidden.append(f)
bmesh.ops.delete(bm, geom=hidden + mitten, context="FACES")
bm.to_mesh(body.data)
bm.free()
log("deleted %d hidden faces under the trunks, %d mitten faces" % (len(hidden), len(mitten)))
V = verts(body)
X, Y, Z = V[:, 0], V[:, 1], V[:, 2]

# ---------------------------------------------------------------- 3. decimate (denser at joints and the face)
vg = body.vertex_groups.new(name="dens")
P = np.stack([X, Y, Z], 1)
w = np.zeros(len(P))
for k in ("LeftArm", "LeftForeArm", "LeftUpLeg", "LeftLeg", "RightArm", "RightForeArm", "RightUpLeg", "RightLeg", "Neck"):
    d = np.linalg.norm(P - np.array(J[k]), axis=1)
    w = np.maximum(w, np.exp(-(d / 0.07) ** 2))
for s in (1, -1):   # forearms (faceted close up at 45k)
    mid = np.array([s * (el_x + wrist) / 2, (el_y + wr_y) / 2, (el_z + wr_z) / 2])
    w = np.maximum(w, 0.8 * np.exp(-(np.linalg.norm(P - mid, axis=1) / 0.12) ** 2))
w = np.maximum(w, ((Z > head_z - 0.04) & (Y < 0.0)).astype(float))          # the face
w = np.maximum(w, ((Z > head_z - 0.03) & (Z < head_z + 0.09) & (np.abs(X) > 0.055) & (np.abs(X) < 0.11)).astype(float))  # ears
w = np.maximum(w, 0.6 * ((Z > hem_z - 0.05) & (Z < hem_z + 0.20) & (np.abs(X) < 0.08)))   # crotch / trunk hem
for val in (0.25, 0.5, 0.75, 1.0):
    idx = np.nonzero((w > val - 0.25) & (w <= val))[0].tolist()
    if idx: vg.add(idx, val, "REPLACE")
tris_in = sum(len(p.vertices) - 2 for p in body.data.polygons)
# keep the original as the bake source: collapse decimation smears Meshy's UV atlas (it collapses across seams),
# so the low mesh gets fresh UVs and every texture is re-baked from the original (selected to active)
high = body.copy()
high.data = body.data.copy()
high.name = "High"
bpy.context.scene.collection.objects.link(high)
mod = body.modifiers.new("dec", "DECIMATE")
mod.decimate_type = "COLLAPSE"
mod.ratio = TRI_TARGET / tris_in
mod.use_collapse_triangulate = True
mod.use_symmetry = True
mod.symmetry_axis = "X"
mod.vertex_group = "dens"
mod.invert_vertex_group = True     # Blender's group marks where to decimate MORE; inverted, it protects these areas
mod.vertex_group_factor = 4.0
bpy.ops.object.modifier_apply(modifier=mod.name)
body.vertex_groups.remove(body.vertex_groups["dens"])
tris_out = sum(len(p.vertices) - 2 for p in body.data.polygons)
log("decimated", tris_in, "->", tris_out, "tris,", len(body.data.vertices), "verts")

# ---- fresh UVs on the low mesh, then bake colour / normal / roughness / metalness from the original ----
me = body.data
old_uv = me.uv_layers[0].name
uvn = me.uv_layers.new(name="UV")
me.uv_layers.active = uvn
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.003)
bpy.ops.uv.select_all(action="SELECT")
bpy.ops.uv.pack_islands(rotate=True, margin=0.003)
bpy.ops.object.mode_set(mode="OBJECT")
me.uv_layers.remove(me.uv_layers[old_uv])
me.uv_layers.active = me.uv_layers["UV"]
me.uv_layers["UV"].active_render = True
log("smart UV project: done")

hm = bpy.data.materials.new("high")
hm.use_nodes = True
hn = hm.node_tree
hb = hn.nodes["Principled BSDF"]
hout = hn.nodes["Material Output"]
def tnode(path, colour):
    t = hn.nodes.new("ShaderNodeTexImage"); t.image = load_img(path, colour); return t
tc, tnm, tr, tmt = tnode(TEX_C, True), tnode(TEX_N, False), tnode(TEX_R, False), tnode(TEX_M, False)
nmap = hn.nodes.new("ShaderNodeNormalMap")
hn.links.new(tnm.outputs["Color"], nmap.inputs["Color"])
hn.links.new(nmap.outputs["Normal"], hb.inputs["Normal"])
hn.links.new(tc.outputs["Color"], hb.inputs["Base Color"])
emi = hn.nodes.new("ShaderNodeEmission")
high.data.materials.clear()
high.data.materials.append(hm)

lm = bpy.data.materials.new("low")
lm.use_nodes = True
ln = lm.node_tree
limg = ln.nodes.new("ShaderNodeTexImage")
ln.links.new(limg.outputs["Color"], ln.nodes["Principled BSDF"].inputs["Base Color"])
ln.nodes.active = limg
me.materials.clear()
me.materials.append(lm)

sc = bpy.context.scene
sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = 1
sc.render.bake.margin = 8
def bake(name, n, colour, kind, src=None):
    img = bpy.data.images.new(name, n, n, alpha=False)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    limg.image = img
    if src is not None:
        hn.links.new(src.outputs["Color"], emi.inputs["Color"])
        hn.links.new(emi.outputs["Emission"], hout.inputs["Surface"])
    else:
        hn.links.new(hb.outputs["BSDF"], hout.inputs["Surface"])
    bpy.ops.object.select_all(action="DESELECT")
    high.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=0.012, max_ray_distance=0.05,
                        margin=8, normal_space="TANGENT")
    log("baked", name, n)
    return img
C = bake("bake_c", 2048, True, "EMIT", tc)
Nm = bake("bake_n", 2048, False, "NORMAL")
R = bake("bake_r", 1024, False, "EMIT", tr)
M = bake("bake_m", 1024, False, "EMIT", tmt)
limg.image = C
bpy.data.objects.remove(high, do_unlink=True)
render("after", views=("front", "back", "face", "hand"))

# ---------------------------------------------------------------- 4. skeleton
arm_data = bpy.data.armatures.new("Armature")
rig = bpy.data.objects.new("Armature", arm_data)
bpy.context.scene.collection.objects.link(rig)
bpy.ops.object.select_all(action="DESELECT")
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
eb = {}
for k in PARENT:   # dict order: parents before children
    b = arm_data.edit_bones.new("mixamorig:" + k)
    h = Vector(J[k])
    if k in CHILD:
        t = Vector(J[CHILD[k]])
    elif k == "Head":
        t = h + Vector((0, 0, 0.18))
    elif k.endswith("ToeBase"):
        t = Vector((h.x, toe_tip, h.z))
    else:   # finger tips: continue the chain
        prev = Vector(J[PARENT[k]])
        t = h + (h - prev).normalized() * 0.022
    b.head, b.tail = h, t
    if PARENT[k]: b.parent = eb[PARENT[k]]
    eb[k] = b
bpy.ops.object.mode_set(mode="OBJECT")
BONES = list(PARENT)
BI = {k: i for i, k in enumerate(BONES)}
log("skeleton", len(arm_data.bones), "bones")

# ---------------------------------------------------------------- 5. weights: bone heat, then rules
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
me = body.data
nv = len(me.vertices)
gi = {g.index: BI.get(g.name.replace("mixamorig:", ""), -1) for g in body.vertex_groups}
W = np.zeros((nv, len(BONES)))
for v in me.vertices:
    for g in v.groups:
        b = gi.get(g.group, -1)
        if b >= 0: W[v.index, b] = g.weight
P = verts(body).astype(np.float64)
X, Y, Z = P[:, 0], P[:, 1], P[:, 2]
orphan = W.sum(1) < 1e-6
log("bone heat: %d / %d vertices got no weight" % (int(orphan.sum()), nv))
def seg_dist(p, a, b):
    a, b = np.array(a), np.array(b)
    ab = b - a
    t = np.clip(((p - a) @ ab) / max(ab @ ab, 1e-9), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)
if orphan.any():   # fallback for heat failures: nearest bone segment
    body_bones = [k for k in BONES if "Hand" not in k or k.endswith("Hand")]
    D = np.stack([seg_dist(P[orphan], J[k], J[CHILD[k]] if k in CHILD else J[k]) for k in body_bones], 1)
    near = D.argmin(1)
    W[np.nonzero(orphan)[0], [BI[body_bones[i]] for i in near]] = 1.0
side = np.where(X >= 0, "Left", "Right")
ax = np.abs(X)
def one(mask, bone_of, val=1.0):
    """Set rows in mask to a one-hot bone (bone_of: name or per-row array of names), mixed in by val (scalar / array)."""
    idx = np.nonzero(mask)[0]
    names = bone_of if isinstance(bone_of, np.ndarray) else np.array([bone_of] * len(idx))
    names = names if len(names) == len(idx) else names[idx]
    v = val if np.isscalar(val) else val[idx]
    W[idx] *= (1 - v) if np.isscalar(v) else (1 - v)[:, None]
    W[idx, [BI[n] for n in names]] += v
sm = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))
# the forearm stub inside the glove (and the bare wrist before it): rigid to the Hand, blending into the ForeArm
# across the wrist joint; the bare forearm above keeps its bone-heat weights
glove = (ax > GRIP - 0.03) & (Z > 1.2)
W[glove] = 0
t = sm(GRIP - 0.03, GRIP + 0.01, ax)
one(glove, np.char.add(side, "ForeArm"), 1.0)
one(glove, np.char.add(side, "Hand"), t)
# head above the jaw line (chin at the front, rising to the jaw angle), neck blend below it
jaw = neck_z + 0.035 + np.clip(Y + 0.07, 0, 0.09) * (0.03 / 0.09)
headr = (ax < 0.13) & (Z > jaw)
W[headr] = 0; W[headr, BI["Head"]] = 1
neckr = (ax < 0.10) & (Z > neck_z + 0.005) & ~headr
one(neckr, "Head", sm(neck_z + 0.005, jaw + 0.005, Z))
# boots: foot / toe by depth, the shaft blends into the Leg
boot = (Z < boot_top + 0.01) & (ax > 0.03)
W[boot] = 0
one(boot, np.char.add(side, "Foot"), 1.0)
one(boot, np.char.add(side, "ToeBase"), sm(ball_y + 0.02, ball_y - 0.02, Y))
one(boot, np.char.add(side, "Leg"), sm(ank_z + 0.04, boot_top - 0.02, Z))
# trunks: Laplacian-smooth the weights over the cloth (waistband to below the hem) so the hem cannot tear
E = np.empty(len(me.edges) * 2, dtype=np.int64); me.edges.foreach_get("vertices", E); E = E.reshape(-1, 2)
trunks = (Z > hem_z - 0.06) & (Z < band_z + 0.02) & (ax < 0.30)
# the shorts' legs follow the thighs (the leg inside does; a pelvis-weighted hem lets a raised thigh punch through
# it), handing over to the bone-heat (pelvis / spine) weights towards the hip joints; left / right blend across x=0
legs = trunks & (Z < upleg_z + 0.05)
u = sm(upleg_z - 0.10, upleg_z + 0.05, Z)       # fully thigh up to ~10 cm below the hip joint
wl = sm(-0.05, 0.05, X)
Wleg = np.zeros_like(W)
Wleg[:, BI["LeftUpLeg"]] = wl
Wleg[:, BI["RightUpLeg"]] = 1 - wl
W[legs] = (1 - u[legs])[:, None] * Wleg[legs] + u[legs][:, None] * W[legs]
deg = np.bincount(E.ravel(), minlength=nv).astype(float)
for it in range(6):
    acc = np.zeros_like(W)
    np.add.at(acc, E[:, 0], W[E[:, 1]])
    np.add.at(acc, E[:, 1], W[E[:, 0]])
    avg = acc / np.maximum(deg, 1)[:, None]
    W[trunks] = 0.5 * W[trunks] + 0.5 * avg[trunks]
# the cloth between the legs follows the pelvis as much as the thighs
crotch = (ax < 0.06) & (Z > hem_z - 0.06) & (Z < upleg_z)
one(crotch, "Hips", 0.5 * (1 - sm(0.0, 0.06, ax)))
# limit 4 influences, normalise
order = np.argsort(-W, 1)
keep = np.zeros_like(W, dtype=bool)
np.put_along_axis(keep, order[:, :4], True, 1)
W[~keep] = 0
W[W < 0.01] = 0
W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
for g in list(body.vertex_groups):
    body.vertex_groups.remove(g)
for k in BONES:
    g = body.vertex_groups.new(name="mixamorig:" + k)
    col = W[:, BI[k]]
    for v in np.nonzero(col > 0)[0].tolist():
        g.add([v], float(col[v]), "REPLACE")
log("weights done: max influences", int((W > 0).sum(1).max()), "glove verts", int(glove.sum()), "boot verts", int(boot.sum()),
    "trunk verts", int(trunks.sum()))

# ---------------------------------------------------------------- 6. textures + region masks
OUTDIR = os.path.dirname(OUT)
STEM = os.path.splitext(os.path.basename(OUT))[0]          # boxer_m1
def save(img, name, quality):
    path = os.path.join(OUTDIR, "%s_%s.webp" % (STEM, name))
    tmp = path[:-5] + "_tmp.webp"
    img.filepath_raw = tmp
    img.file_format = "WEBP"
    img.save(filepath=tmp, quality=quality)
    os.replace(tmp, path)
    log("wrote", os.path.basename(path), os.path.getsize(path))
def px_of(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)
def new_img(name, n, arr):
    img = bpy.data.images.new(name, n, n, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    return img

# region label per UV texel: rasterise the decimated mesh's triangles, labelled by their 3D centroid
N1 = 1024
lab = np.full((N1, N1), -1, dtype=np.int8)
uvl = np.empty(len(me.loops) * 2, dtype=np.float32); me.uv_layers.active.data.foreach_get("uv", uvl); uvl = uvl.reshape(-1, 2)
me.calc_loop_triangles()
LT = np.empty(len(me.loop_triangles) * 3, dtype=np.int64); me.loop_triangles.foreach_get("loops", LT); LT = LT.reshape(-1, 3)
TV = np.empty(len(me.loop_triangles) * 3, dtype=np.int64); me.loop_triangles.foreach_get("vertices", TV); TV = TV.reshape(-1, 3)
cen = P[TV].mean(1)
cx, cz = np.abs(cen[:, 0]), cen[:, 2]
tl = np.zeros(len(TV), dtype=np.int8)                         # 0 skin / other
tl[(cz > hem_z - 0.10) & (cz < band_z + 0.03)] = 1            # hip band (trunks live here)
tl[(cz < boot_top + 0.03)] = 3                                # feet (boots)
tl[(cz > neck_z - 0.02) & (cx < 0.15)] = 4                    # head (hair)
tl[(cx > cuff - 0.02) & (cz > 1.2)] = 6                       # old mitten cuff, now bare forearm: repainted as skin

tn = np.empty(len(me.loop_triangles) * 3, dtype=np.float32); me.loop_triangles.foreach_get("normal", tn); tn = tn.reshape(-1, 3)
tsw = ((cz > 1.28) & (cz < 1.53) & (cx < 0.30)).astype(np.float32)   # sweat sheen zone: shoulders, upper chest / back
nyr = np.zeros((N1, N1), dtype=np.float32)                    # facing: + = back (Blender +y)
swr = np.zeros((N1, N1), dtype=np.float32)
zr = np.zeros((N1, N1), dtype=np.float32)                     # height of the texel's triangle (m)
xr = np.zeros((N1, N1), dtype=np.float32)                     # its x (+ left)
xt = np.zeros((N1, N1), dtype=np.float32); yt = np.zeros((N1, N1), dtype=np.float32)
zt = np.zeros((N1, N1), dtype=np.float32)                     # per-texel interpolated surface height (m)
UVp = uvl[LT] * N1 - 0.5
for ti in range(len(TV)):
    a, b, c = UVp[ti]
    x0, x1 = int(max(0, math.floor(min(a[0], b[0], c[0])))), int(min(N1 - 1, math.ceil(max(a[0], b[0], c[0]))))
    y0, y1 = int(max(0, math.floor(min(a[1], b[1], c[1])))), int(min(N1 - 1, math.ceil(max(a[1], b[1], c[1]))))
    if x1 < x0 or y1 < y0: continue
    gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
    d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(d) < 1e-12: continue
    l1 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / d
    l2 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / d
    ins = (l1 >= -0.02) & (l2 >= -0.02) & (1 - l1 - l2 >= -0.02)
    lab[gy[ins], gx[ins]] = tl[ti]
    nyr[gy[ins], gx[ins]] = tn[ti, 1]
    swr[gy[ins], gx[ins]] = tsw[ti]
    zr[gy[ins], gx[ins]] = cz[ti]
    xr[gy[ins], gx[ins]] = cen[ti, 0]
    l3 = 1 - l1 - l2
    zt[gy[ins], gx[ins]] = (l1 * P[TV[ti, 0], 2] + l2 * P[TV[ti, 1], 2] + l3 * P[TV[ti, 2], 2])[ins]   # the texel's own surface height
    xt[gy[ins], gx[ins]] = (l1 * P[TV[ti, 0], 0] + l2 * P[TV[ti, 1], 0] + l3 * P[TV[ti, 2], 0])[ins]
    yt[gy[ins], gx[ins]] = (l1 * P[TV[ti, 0], 1] + l2 * P[TV[ti, 1], 1] + l3 * P[TV[ti, 2], 1])[ins]
cover = lab >= 0
log("uv coverage %.1f%%" % (100 * cover.mean()))
cp = px_of(C).reshape(N1, 2, N1, 2, 4).mean((1, 3))[..., :3]   # base colour at 1024
mx, mn = cp.max(-1), cp.min(-1)
sat = (mx - mn) / np.maximum(mx, 1e-6)
r_, g_, b_ = cp[..., 0], cp[..., 1], cp[..., 2]
hue = np.where(mx == r_, ((g_ - b_) / np.maximum(mx - mn, 1e-6)) % 6, np.where(mx == g_, (b_ - r_) / np.maximum(mx - mn, 1e-6) + 2, (r_ - g_) / np.maximum(mx - mn, 1e-6) + 4)) / 6
lace = (sat < 0.25) & (mx > 0.45)                              # white laces / cloth
red = ((hue < 0.035) | (hue > 0.92)) & (sat > 0.45)
skinlike = (hue > 0.02) & (hue < 0.14) & (sat > 0.18) & (mx > 0.12)
m_trunks = (lab == 1) & lace
# waistband top edge, measured per direction round the body (the band tilts: lower in front, higher at the back): the
# 98th percentile height of the band's own cloth texels in 36 angle bins, smoothed. The trunks region is then cut PER
# TEXEL at that height (its interpolated surface position), not per triangle, so the top line is clean and level-ish.
_th = np.arctan2(yt, xt); _nb = 36
_edge = np.full(_nb, np.nan)
_bi = np.clip(((_th + math.pi) / (2 * math.pi) * _nb).astype(int), 0, _nb - 1)
_src = m_trunks & (zt > 0)
for _k in range(_nb):
    _q = zt[_src & (_bi == _k)]
    if _q.size > 50: _edge[_k] = np.percentile(_q, 99)
_edge = np.where(np.isnan(_edge), np.nanmedian(_edge), _edge)
for _ in range(2): _edge = 0.25 * np.roll(_edge, 1) + 0.5 * _edge + 0.25 * np.roll(_edge, -1)
_ctr = (np.arange(_nb) + 0.5) / _nb * 2 * math.pi - math.pi
def cut_z(theta): return np.interp(theta, _ctr, _edge, period=2 * math.pi)
log("waistband top edge cm by angle (front -90deg ... back +90deg):", np.round(100 * _edge[::3], 1).tolist(), "min %.1f max %.1f" % (100 * _edge.min(), 100 * _edge.max()))
m_glove = (lab == 2) & ~lace | (lab == 5) & (red | (mx < 0.12))
m_boot = (lab == 3) & (mx < 0.25) & ~skinlike
m_hair = (lab == 4) & (mx < 0.16) & (sat < 0.6)
m_skin = cover & ~m_trunks & ~m_glove & ~m_boot & ~m_hair & ~(((lab == 2) | (lab == 3) | (lab == 5)) & ~skinlike)
def box(m, r=1):
    o = np.zeros(m.shape, dtype=np.float32); mp_ = np.pad(m.astype(np.float32), r, mode="edge")
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            o += mp_[r + dy:r + dy + m.shape[0], r + dx:r + dx + m.shape[1]]
    return o / (2 * r + 1) ** 2
def clean(m):
    m = box(m) > 0.99                    # erode: drop specks
    m = box(m) > 0.01                    # dilate back
    m = box(m) > 0.01                    # close small holes
    m = box(m) > 0.99
    return box(m)                        # slight feather
def bleed(a, n=4):
    """Push values outward from covered texels into the gutter, so bilinear filtering at seams stays clean."""
    a = a.copy(); have = cover.copy()
    for _ in range(n):
        s = box(np.where(have, a, 0)); c = box(have)
        grow = ~have & (c > 0)
        a[grow] = s[grow] / c[grow]; have |= grow
    return a
# bleed into the gutter first: otherwise the clean-up erodes against the empty gutter and leaves a half-strength
# rim inside every UV island, which shows as light seam lines once a region is tinted
ch = [bleed(clean(bleed(m.astype(np.float32), 6))) for m in (m_trunks, m_glove, m_boot, m_skin, m_hair)]
# trunks only on texels whose own triangle is in the hip band (or gutter touching nothing else): the clean-up and the
# gutter bleed spread the channel across neighbouring UV islands, and a forearm island packed against a trunks island
# took the kit colour as a red streak on the skin
own = bleed((lab == 1).astype(np.float32), 6) > 0.99
ch[0] = ch[0] * own
# per-texel cut at the measured waistband top (positions bled into the gutter so seams cut at the same height)
zb, xb, yb = bleed(zt, 6), bleed(xt, 6), bleed(yt, 6)
cutb = cut_z(np.arctan2(yb, xb))
_c0 = ch[0].copy()
ch[0] = ch[0] * np.clip((cutb + 0.002 - zb) / 0.004, 0, 1)
ch[3] = np.maximum(ch[3], _c0 - ch[0])          # what the cut took from the trunks is skin
# boots: the shaft above SOCK_Z becomes a short white sock band (boxing boots read low and matte, not tall and shiny)
SOCK_Z = 0.19
zrb = bleed(zr, 6)
sock = ch[2] * sm(SOCK_Z - 0.006, SOCK_Z + 0.006, zrb)
ch[2] = ch[2] - sock
mask = np.ones((N1, N1, 4), dtype=np.float32)
mask[..., 0], mask[..., 1], mask[..., 2] = ch[0], ch[1], ch[2]
save(new_img("mask", N1, mask), "mask", 100)
sk = np.ones((N1, N1, 4), dtype=np.float32); sk[..., 0], sk[..., 1], sk[..., 2] = ch[3], ch[4], 0
save(new_img("skinmask", N1, sk), "skin", 100)
log("mask coverage of uv: trunks %.1f%% gloves %.1f%% boots %.1f%% skin %.1f%% hair %.1f%%"
    % tuple(100 * float((c > 0.5).sum()) / max(1, int(cover.sum())) for c in ch))

def blur(a, k=3, r=2):
    for _ in range(k): a = box(a, r)
    return a
# even out the baked front / back skin tone: the back's skin is pulled to the front's mean colour (per channel)
skin1 = ch[3] > 0.5
front, back = skin1 & (nyr < -0.4), skin1 & (nyr > 0.4)
gain = cp[front].mean(0) / np.maximum(cp[back].mean(0), 1e-4)
wb = blur(ch[3] * sm(-0.1, 0.5, bleed(nyr, 6)))
cpx = px_of(C)
w2 = np.repeat(np.repeat(wb, 2, 0), 2, 1)[..., None]
cpx[..., :3] = np.clip(cpx[..., :3] * (1 + w2 * (gain - 1)), 0, 1)
# old mitten cuff -> bare forearm: the skin just above the old cuff line on the same arm, times a softened version of
# the texel's own shading (so it is not one flat colour); its normal map goes flat (the mitten's creases are gone)
rep = np.zeros((N1, N1, 3), dtype=np.float32); repw = np.zeros((N1, N1), dtype=bool)
lum = cp.mean(-1)
for s in (1, -1):
    refm = skin1 & (lab == 0) & (s * xr > cuff - 0.07) & (s * xr < cuff - 0.025) & (zr > 1.2)
    zm = (lab == 6) & (s * xr > 0)
    if not (refm.any() and zm.any()): continue
    f = np.clip(blur(np.where(zm, lum / max(float(lum[zm].mean()), 1e-4), 1.0), 2, 2), 0.6, 1.5) ** 0.35
    rep[zm] = cp[refm].mean(0) * f[zm][:, None]; repw |= zm
    log("forearm repaint side %d: %d texels from %d reference skin texels, colour %s" % (s, int(zm.sum()), int(refm.sum()), np.round(cp[refm].mean(0), 3).tolist()))
# cloth-coloured texels above the waistband cut (now skin): skin colour from just above the cut, own shading kept
cutt = cut_z(np.arctan2(yt, xt))
zc = (lab == 1) & lace & (zt > 0) & (zt >= cutt - 0.002)
refc = (lab >= 0) & skinlike & (zt > cutt + 0.01) & (zt < cutt + 0.06) & (np.abs(xt) < 0.30)
if zc.any() and refc.any():
    fc = np.clip(blur(np.where(zc, lum / max(float(lum[zc].mean()), 1e-4), 1.0), 2, 2), 0.6, 1.5) ** 0.35
    rep[zc] = cp[refc].mean(0) * fc[zc][:, None]; repw |= zc
    log("waistband repaint: %d texels from %d reference skin texels, colour %s" % (int(zc.sum()), int(refc.sum()), np.round(cp[refc].mean(0), 3).tolist()))
rf = repw.astype(np.float32); gut = ~cover & (box(rf, 3) > 0)   # carry it into the island gutter (no red seam)
for k in range(3):
    rep[..., k] = np.where(gut, box(rep[..., k], 3) / np.maximum(box(rf, 3), 1e-6), rep[..., k])
repw |= gut
rep2 = np.repeat(np.repeat(rep, 2, 0), 2, 1); repw2 = np.repeat(np.repeat(repw, 2, 0), 2, 1)
cpx[..., :3][repw2] = rep2[repw2]
npx = px_of(Nm); npx[..., :3][repw2] = (0.5, 0.5, 1.0); Nm.pixels.foreach_set(npx.ravel())
s2 = np.repeat(np.repeat(sock, 2, 0), 2, 1)[..., None]       # sock band: flat off-white cotton (linear-ish sRGB)
cpx[..., :3] = cpx[..., :3] * (1 - s2) + s2 * np.array([0.84, 0.83, 0.80])
C.pixels.foreach_set(cpx.ravel())
log("back skin gain", np.round(gain, 3).tolist(), "front mean", np.round(cp[front].mean(0), 3).tolist())
save(C, "c", 88)
save(Nm, "n", 90)
# roughness: skin matte ("sweaty, not varnished"), a little sheen on shoulders / upper chest; satin trunks and
# gloves; metal dropped (Meshy fakes satin with ~0.5 metal, which reads as vinyl once tinted)
rp = px_of(R)[..., 0]
def around(m, base, k, lo, hi):
    med = float(np.median(rp[m > 0.5])) if (m > 0.5).any() else 0.5
    return np.clip(base + k * (rp - med), lo, hi)
sw = blur(bleed(swr, 6)) * ch[3]
r_skin = around(ch[3], 0.66, 0.3, 0.45, 0.9) - 0.16 * sw
r_tr, r_gl = around(ch[0], 0.5, 0.3, 0.38, 0.75), around(ch[1], 0.46, 0.3, 0.34, 0.7)
wsum = np.clip(ch[3] + ch[0] + ch[1], 0, 1)
rough = rp * (1 - wsum) + (ch[3] * r_skin + ch[0] * r_tr + ch[1] * r_gl) / np.maximum(ch[3] + ch[0] + ch[1], 1e-6) * wsum
bs = np.clip(ch[2] + sock, 0, 1)                              # boots matte leather, sock cotton
rough = rough * (1 - bs) + bs * (0.84 * ch[2] + 0.93 * sock) / np.maximum(ch[2] + sock, 1e-6)
rm = np.ones((N1, N1, 4), dtype=np.float32); rm[..., 0] = rough; rm[..., 1] = rough; rm[..., 2] = 0
save(new_img("rm", N1, rm), "r", 90)                          # G roughness, B metalness 0 (glTF packing)
log("roughness means: skin %.2f trunks %.2f gloves %.2f" % (float(rough[ch[3] > 0.5].mean()), float(rough[ch[0] > 0.5].mean()), float(rough[ch[1] > 0.5].mean())))

# ---------------------------------------------------------------- 6b. gloves: a separate, swappable part
# One LEFT glove (closed fist) from its own Meshy zip (GLOVE_ZIP): decimated, re-UV'd and baked to its own small
# texture set (public/fighter/glove_<name>_{c,n}.webp), turned to the T-pose hand (fingers +x, palm down, thumb to the
# front), fitted to the old mitten's box (same drawn size = same hit size), mirrored for the right, rigid to the Hand.
GLOVE_TRIS = 4500
GSTEM = "glove_" + GLOVE_NAME
def build_gloves():
    gfiles = os.listdir(GLOVE_CACHE)
    def gtex(tag):
        for f in gfiles:
            b = f.lower()
            if b.endswith(".png") and (b.endswith("_%s.png" % tag) if tag else not any(b.endswith("_%s.png" % t) for t in ("normal", "roughness", "metallic"))):
                return os.path.join(GLOVE_CACHE, f)
        raise SystemExit("glove texture missing: " + (tag or "base colour"))
    hi = GLOVE_HI                            # imported and turned to the T-pose hand in glove_source()
    size = float(np.ptp(verts(hi), 0).max())
    tris_hi = sum(len(p.vertices) - 2 for p in hi.data.polygons)
    lo = hi.copy(); lo.data = hi.data.copy(); lo.name = "glove_L"
    hi.hide_render = False; lo.hide_render = False      # hidden only for the body's preview renders
    bpy.context.scene.collection.objects.link(lo)
    mod = lo.modifiers.new("dec", "DECIMATE")
    mod.decimate_type = "COLLAPSE"; mod.ratio = GLOVE_TRIS / tris_hi; mod.use_collapse_triangulate = True
    bpy.ops.object.select_all(action="DESELECT"); lo.select_set(True); bpy.context.view_layer.objects.active = lo
    bpy.ops.object.modifier_apply(modifier=mod.name)
    for u in list(lo.data.uv_layers): lo.data.uv_layers.remove(u)
    lo.data.uv_layers.new(name="UV")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, margin=0.004)
    bpy.ops.object.mode_set(mode="OBJECT")
    # bake colour + normal from the full-res source (selected to active), in the source's own units
    gh = bpy.data.materials.new("glove_high"); gh.use_nodes = True
    n_ = gh.node_tree; gb = n_.nodes["Principled BSDF"]; gout = n_.nodes["Material Output"]
    tc_ = n_.nodes.new("ShaderNodeTexImage"); tc_.image = load_img(gtex(""), True)
    tn_ = n_.nodes.new("ShaderNodeTexImage"); tn_.image = load_img(gtex("normal"), False)
    nm_ = n_.nodes.new("ShaderNodeNormalMap")
    n_.links.new(tn_.outputs["Color"], nm_.inputs["Color"]); n_.links.new(nm_.outputs["Normal"], gb.inputs["Normal"])
    n_.links.new(tc_.outputs["Color"], gb.inputs["Base Color"])
    em_ = n_.nodes.new("ShaderNodeEmission")
    hi.data.materials.clear(); hi.data.materials.append(gh)
    gl = bpy.data.materials.new(GSTEM); gl.use_nodes = True
    gimg = gl.node_tree.nodes.new("ShaderNodeTexImage"); gl.node_tree.nodes.active = gimg
    lo.data.materials.clear(); lo.data.materials.append(gl)
    imgs = {}
    bpy.context.scene.render.engine = "CYCLES"     # the preview renders left Workbench on
    for name, n, colour, kind in (("c", 1024, True, "EMIT"), ("n", 1024, False, "NORMAL")):
        img = bpy.data.images.new(GSTEM + "_" + name, n, n, alpha=False)
        img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
        gimg.image = img
        if kind == "EMIT":
            n_.links.new(tc_.outputs["Color"], em_.inputs["Color"]); n_.links.new(em_.outputs["Emission"], gout.inputs["Surface"])
        else:
            n_.links.new(gb.outputs["BSDF"], gout.inputs["Surface"])
        bpy.ops.object.select_all(action="DESELECT"); hi.select_set(True); lo.select_set(True)
        bpy.context.view_layer.objects.active = lo
        bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=0.025 * size, max_ray_distance=0.07 * size,
                            margin=8, normal_space="TANGENT")
        imgs[name] = img
    bpy.data.objects.remove(hi, do_unlink=True)
    # fit (see glove_source): fist width / height to the old mitten's box, x by their mean scale (the model's own
    # proportions), tip on the old tip
    G = verts(lo).astype(np.float64)
    glo, ghi = G.min(0), G.max(0)
    sc_ = (OLD_GLOVE[1] - OLD_GLOVE[0]) / (ghi - glo)
    sx = 0.5 * (sc_[1] + sc_[2])
    nx = GLOVE_TIP - (ghi[0] - G[:, 0]) * sx
    ny = OLD_GLOVE[0][1] + (G[:, 1] - glo[1]) * sc_[1]
    nz = OLD_GLOVE[0][2] + (G[:, 2] - glo[2]) * sc_[2]
    lo.data.vertices.foreach_set("co", np.stack([nx, ny, nz], 1).astype(np.float32).ravel())
    lo.data.update()
    G = verts(lo).astype(np.float64)
    log("glove: %d -> %d tris per hand; y/z scale ratio %.3f; length %.1f cm, opening at |x| %.3f; bbox cm size %s min %s max %s"
        % (tris_hi, sum(len(p.vertices) - 2 for p in lo.data.polygons), sc_[1] / sc_[2], 100 * np.ptp(G[:, 0]), G[:, 0].min(),
           np.round(100 * np.ptp(G, 0), 1).tolist(), np.round(100 * G.min(0), 1).tolist(), np.round(100 * G.max(0), 1).tolist()))
    # a darker band at the cuff opening (the last 1.4 cm, and the inside of the tube) so the edge reads as a separate
    # glove, not skin: texels darkened by the 3D x of their triangle
    me_ = lo.data; me_.calc_loop_triangles()
    nt_ = len(me_.loop_triangles)
    LT_ = np.empty(nt_ * 3, dtype=np.int64); me_.loop_triangles.foreach_get("loops", LT_)
    TV_ = np.empty(nt_ * 3, dtype=np.int64); me_.loop_triangles.foreach_get("vertices", TV_)
    uv_ = np.empty(len(me_.loops) * 2, dtype=np.float32); me_.uv_layers.active.data.foreach_get("uv", uv_)
    tx = G[TV_.reshape(-1, 3), 0].mean(1)
    dark = 1 - 0.45 * (1 - sm(G[:, 0].min() + 0.008, G[:, 0].min() + 0.014, tx))
    cimg = imgs["c"]; n = cimg.size[0]
    fac = np.ones((n, n), dtype=np.float32)
    UV_ = uv_.reshape(-1, 2)[LT_.reshape(-1, 3)] * n - 0.5
    for ti in np.nonzero(dark < 0.999)[0].tolist():
        a, b, c = UV_[ti]
        x0, x1 = int(max(0, math.floor(min(a[0], b[0], c[0])) - 1)), int(min(n - 1, math.ceil(max(a[0], b[0], c[0])) + 1))
        y0, y1 = int(max(0, math.floor(min(a[1], b[1], c[1])) - 1)), int(min(n - 1, math.ceil(max(a[1], b[1], c[1])) + 1))
        fac[y0:y1 + 1, x0:x1 + 1] = np.minimum(fac[y0:y1 + 1, x0:x1 + 1], dark[ti])
    cpx_ = px_of(cimg); cpx_[..., :3] *= fac[..., None]; cimg.pixels.foreach_set(cpx_.ravel())
    for name, img in imgs.items():
        path = os.path.join(OUTDIR, "%s_%s.webp" % (GSTEM, name)); tmp = path[:-5] + "_tmp.webp"
        img.filepath_raw = tmp; img.file_format = "WEBP"; img.save(filepath=tmp, quality=90 if name == "c" else 92)
        os.replace(tmp, path); log("wrote", os.path.basename(path), os.path.getsize(path))
    for p in lo.data.polygons: p.use_smooth = True
    gl.node_tree.nodes.remove(gimg)          # the loader loads glove_<name>_* itself; the glb carries no image
    ro = lo.copy(); ro.data = lo.data.copy(); ro.name = "glove_R"
    bpy.context.scene.collection.objects.link(ro)
    ro.data.transform(Matrix.Diagonal(Vector((-1.0, 1.0, 1.0, 1.0))))
    ro.data.flip_normals()
    for o, s in ((lo, "Left"), (ro, "Right")):
        o.data.name = o.name
        for g in list(o.vertex_groups): o.vertex_groups.remove(g)
        vg_ = o.vertex_groups.new(name="mixamorig:%sHand" % s)
        vg_.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
        o.parent = rig
        am = o.modifiers.new("Armature", "ARMATURE"); am.object = rig
    return lo, ro
GLOVES = build_gloves()

# ---------------------------------------------------------------- 6c. trunks: a separate, swappable part
# Cut from a full-body T-pose boxer wearing them (TRUNKS_ZIP, same layout as a body zip): the white cloth between hem
# and waistband is kept, decimated, re-UV'd and baked to its own texture set (public/fighter/trunks_<name>_{c,n}.webp).
# Fit: the body here has no thighs under its own moulded shorts, so the part is stretched to cover them exactly
# (waistband kept at its own height, the legs stretched down to the body's hem), slice by slice onto the body's own
# width / depth, then pushed out to a minimum clearance. Weights come from the body underneath; six hem bones
# (hem_<Left|Right>_<f|o|b>, children of the thighs) carry the last 14 cm for the spring sway in src/human/body.ts.
TRUNKS_TRIS = 6000
TRUNKS_BAND = 0.07        # the donor's waistband height (m): mapped 1:1, never stretched
TRUNKS_CLEAR = 0.005      # minimum distance (m) from the body surface
TRUNKS_EASE = 0.012       # the part's slices are this much (m) wider / deeper than the body's moulded shorts
BODY_CUT = (hem_z + 0.015, band_z - 0.005)   # the body's moulded shorts are deleted between these heights
HEM_LEN = 0.14            # the swaying part of the leg (m)
TSTEM = "trunks_" + TRUNKS_NAME
HEM_BONES = ["hem_%s_%s" % (s, d) for s in ("Left", "Right") for d in "fob"]
def build_trunks():
    from mathutils.kdtree import KDTree
    tfiles = os.listdir(TRUNKS_CACHE)
    def ttex(tag):
        for f in tfiles:
            b = f.lower()
            if b.endswith(".png") and (b.endswith("_%s.png" % tag) if tag else not any(b.endswith("_%s.png" % t) for t in ("normal", "roughness", "metallic"))):
                return os.path.join(TRUNKS_CACHE, f)
        raise SystemExit("trunks texture missing: " + (tag or "base colour"))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.join(TRUNKS_CACHE, next(f for f in tfiles if f.lower().endswith(".fbx"))))
    new = [o for o in bpy.data.objects if o not in before]
    hi = next(o for o in new if o.type == "MESH")
    for o in new:
        if o is not hi: bpy.data.objects.remove(o, do_unlink=True)
    hi.parent = None
    bpy.ops.object.select_all(action="DESELECT"); hi.select_set(True); bpy.context.view_layer.objects.active = hi
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    D = verts(hi)
    dlo, dhi = D.min(0), D.max(0)
    hi.data.transform(Matrix.Translation(Vector((-(dlo[0] + dhi[0]) / 2, -(dlo[1] + dhi[1]) / 2, -dlo[2]))))
    hi.data.transform(Matrix.Scale(H / (dhi[2] - dlo[2]), 4))
    D = verts(hi).astype(np.float64)
    # the cloth: white texels (low saturation, bright) in the hip band
    cimg_src = load_img(ttex(""), True)
    px = px_of(cimg_src)
    hm_ = hi.data
    nl = len(hm_.loops)
    lv = np.empty(nl, dtype=np.int64); hm_.loops.foreach_get("vertex_index", lv)
    luv = np.empty(nl * 2, dtype=np.float32); hm_.uv_layers.active.data.foreach_get("uv", luv); luv = luv.reshape(-1, 2)
    vuv = np.zeros((len(D), 2)); vuv[lv] = luv
    ix = np.clip((vuv[:, 0] % 1.0) * px.shape[1], 0, px.shape[1] - 1).astype(np.int64)
    iy = np.clip((vuv[:, 1] % 1.0) * px.shape[0], 0, px.shape[0] - 1).astype(np.int64)
    col = px[iy, ix, :3]
    del px
    keep = (col.min(1) > 0.42) & (col.max(1) - col.min(1) < 0.13) & (D[:, 2] > 0.72) & (D[:, 2] < 1.12) & (np.abs(D[:, 0]) < 0.30)
    bm_ = bmesh.new(); bm_.from_mesh(hm_)
    bm_.verts.ensure_lookup_table()
    bmesh.ops.delete(bm_, geom=[v for v in bm_.verts if not keep[v.index]], context="VERTS")
    bmesh.ops.remove_doubles(bm_, verts=bm_.verts[:], dist=1e-5)
    bm_.verts.ensure_lookup_table()
    seen = set(); small = []
    for v0 in bm_.verts:      # drop specks: islands under 500 vertices
        if v0.index in seen: continue
        isl = [v0]; seen.add(v0.index); k = 0
        while k < len(isl):
            for e in isl[k].link_edges:
                o_ = e.other_vert(isl[k])
                if o_.index not in seen: seen.add(o_.index); isl.append(o_)
            k += 1
        if len(isl) < 500: small += isl
    bmesh.ops.delete(bm_, geom=small, context="VERTS")
    # level cuts just inside the ragged colour edge, hem and waistband top: the lowest / highest z the cloth reaches
    # at every angle around the body (36 bins)
    Dk = np.array([v.co[:] for v in bm_.verts])
    ang = ((np.arctan2(Dk[:, 1], Dk[:, 0]) + math.pi) / (2 * math.pi) * 36).astype(np.int64) % 36
    cut_lo = max(float(Dk[ang == k, 2].min()) for k in range(36) if (ang == k).any()) + 0.003
    cut_hi = min(float(Dk[ang == k, 2].max()) for k in range(36) if (ang == k).any()) - 0.003
    for cz_, nz_ in ((cut_lo, -1.0), (cut_hi, 1.0)):
        geom = bm_.verts[:] + bm_.edges[:] + bm_.faces[:]
        bmesh.ops.bisect_plane(bm_, geom=geom, dist=1e-6, plane_co=(0, 0, cz_), plane_no=(0, 0, nz_), clear_outer=True)
    bm_.to_mesh(hm_); bm_.free(); hm_.update()
    D = verts(hi).astype(np.float64)
    tris_hi = sum(len(p.vertices) - 2 for p in hm_.polygons)
    dz0, dz1 = float(D[:, 2].min()), float(D[:, 2].max())
    log("trunks source: %d tris of cloth, z %.3f..%.3f, half width %.3f, y %.3f..%.3f"
        % (tris_hi, dz0, dz1, np.abs(D[:, 0]).max(), D[:, 1].min(), D[:, 1].max()))
    if tris_hi < 5000: raise SystemExit("trunks: the white cloth was not found on the donor")
    lo = hi.copy(); lo.data = hi.data.copy(); lo.name = "trunks"
    bpy.context.scene.collection.objects.link(lo)
    mod = lo.modifiers.new("dec", "DECIMATE")
    mod.decimate_type = "COLLAPSE"; mod.ratio = TRUNKS_TRIS / tris_hi; mod.use_collapse_triangulate = True
    bpy.ops.object.select_all(action="DESELECT"); lo.select_set(True); bpy.context.view_layer.objects.active = lo
    bpy.ops.object.modifier_apply(modifier=mod.name)
    for u in list(lo.data.uv_layers): lo.data.uv_layers.remove(u)
    lo.data.uv_layers.new(name="UV")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, margin=0.004)
    bpy.ops.object.mode_set(mode="OBJECT")
    # bake colour + normal from the full-res cloth (selected to active), still in the donor's own shape
    th = bpy.data.materials.new("trunks_high"); th.use_nodes = True
    n_ = th.node_tree; tb = n_.nodes["Principled BSDF"]; tout = n_.nodes["Material Output"]
    tc_ = n_.nodes.new("ShaderNodeTexImage"); tc_.image = cimg_src
    tn_ = n_.nodes.new("ShaderNodeTexImage"); tn_.image = load_img(ttex("normal"), False)
    nm_ = n_.nodes.new("ShaderNodeNormalMap")
    n_.links.new(tn_.outputs["Color"], nm_.inputs["Color"]); n_.links.new(nm_.outputs["Normal"], tb.inputs["Normal"])
    n_.links.new(tc_.outputs["Color"], tb.inputs["Base Color"])
    em_ = n_.nodes.new("ShaderNodeEmission")
    hi.data.materials.clear(); hi.data.materials.append(th)
    tl_ = bpy.data.materials.new(TSTEM); tl_.use_nodes = True
    timg = tl_.node_tree.nodes.new("ShaderNodeTexImage"); tl_.node_tree.nodes.active = timg
    lo.data.materials.clear(); lo.data.materials.append(tl_)
    imgs = {}
    bpy.context.scene.render.engine = "CYCLES"
    for name, n, colour, kind in (("c", 1024, True, "EMIT"), ("n", 1024, False, "NORMAL")):
        img = bpy.data.images.new(TSTEM + "_" + name, n, n, alpha=False)
        img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
        timg.image = img
        if kind == "EMIT":
            n_.links.new(tc_.outputs["Color"], em_.inputs["Color"]); n_.links.new(em_.outputs["Emission"], tout.inputs["Surface"])
        else:
            n_.links.new(tb.outputs["BSDF"], tout.inputs["Surface"])
        bpy.ops.object.select_all(action="DESELECT"); hi.select_set(True); lo.select_set(True)
        bpy.context.view_layer.objects.active = lo
        bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=0.01, max_ray_distance=0.04,
                            margin=8, normal_space="TANGENT")
        imgs[name] = img
    bpy.data.objects.remove(hi, do_unlink=True)

    # ---- fit onto this body: z piecewise (legs stretched, waistband 1:1), then each slice onto the body's own box ----
    Pb = verts(body).astype(np.float64)
    tz0, tz1 = hem_z - 0.012, band_z + 0.035          # covers the body's own moulded shorts, hem to waistband top
    def profile(Vs, z0, z1):
        zc = np.arange(z0, z1 + 0.005, 0.01)
        rows = np.full((len(zc), 4), np.nan)
        for i, z in enumerate(zc):
            m = (np.abs(Vs[:, 2] - z) < 0.008) & (np.abs(Vs[:, 0]) < 0.30)
            if m.sum() > 3:
                a = np.abs(Vs[m, 0])
                rows[i] = (a.min(), a.max(), Vs[m, 1].min(), Vs[m, 1].max())
        for k in range(4):
            ok = ~np.isnan(rows[:, k])
            rows[:, k] = np.interp(zc, zc[ok], rows[ok, k])
            rows[:, k] = np.convolve(np.pad(rows[:, k], 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")
        rows[rows[:, 0] < 0.012, 0] = 0.0             # above the crotch the slice reaches the centre line
        return zc, rows
    T = verts(lo).astype(np.float64)
    dzc, dpr = profile(D, dz0, dz1)
    zb = dz1 - TRUNKS_BAND
    if UNDER == "briefs":
        # a bare body (underpants): the trunks keep their own length and cut. One scale for the whole garment, taken
        # where the waistband sits (its width / depth onto the body's waist plus the ease); every vertex then gets the
        # clearance, so hips and thighs wider than the donor's push the cloth out instead of poking through it.
        # ...except that the hem always ends at least 5 cm below this body's crotch (a heavy man's sits 10 cm lower
        # than the donor's): the legs are stretched down to there, the waistband is not.
        # (the crotch: the 1 cm height band with the most centre-line vertices, the underside where the legs meet;
        # the lowest centre-line vertex is no use, thick thighs touch well below it)
        _cz = np.arange(0.60, 0.95, 0.01)
        _cn = [int(((np.abs(Pb[:, 0]) < 0.012) & (Pb[:, 2] >= z_) & (Pb[:, 2] < z_ + 0.01)).sum()) for z_ in _cz]
        crotch = float(_cz[int(np.argmax(_cn))])
        tz0, tz1 = min(dz0, crotch - 0.05), dz1
        T[:, 2] = np.where(T[:, 2] >= zb, T[:, 2], tz0 + (T[:, 2] - dz0) / (zb - dz0) * (zb - tz0))
        log("crotch at %.3f: hem %.3f -> %.3f" % (crotch, dz0, tz0))
        bzc, bpr = profile(Pb, tz0, tz1)
        wb = (dzc > zb + 0.01) & (dzc < dz1 - 0.01)
        am, bm2 = dpr[wb].mean(0), np.stack([np.interp(dzc[wb], bzc, bpr[:, k]) for k in range(4)], 1).mean(0)
        sx_ = (bm2[1] + TRUNKS_EASE) / am[1]
        sy_ = (bm2[3] - bm2[2] + 2 * TRUNKS_EASE) / (am[3] - am[2])
        T = np.stack([T[:, 0] * sx_, (bm2[2] - TRUNKS_EASE) + (T[:, 1] - am[2]) * sy_, T[:, 2]], 1)
        cut = (tz0 + 0.06, tz1 - 0.03)
        rim = list(range(len(T)))
        stretch = 1.0
        log("trunks on a bare body: true length, scale x %.3f y %.3f at the waistband" % (sx_, sy_))
    else:
        bzc, bpr = profile(Pb, tz0, tz1)
        zt = np.where(T[:, 2] >= zb, tz1 - (dz1 - T[:, 2]), tz0 + (T[:, 2] - dz0) / (zb - dz0) * (tz1 - TRUNKS_BAND - tz0))
        a = np.stack([np.interp(T[:, 2], dzc, dpr[:, k]) for k in range(4)], 1)
        b = np.stack([np.interp(zt, bzc, bpr[:, k]) for k in range(4)], 1)
        b[:, 0] = np.maximum(b[:, 0] - TRUNKS_EASE, 0); b[:, 1] += TRUNKS_EASE; b[:, 2] -= TRUNKS_EASE; b[:, 3] += TRUNKS_EASE
        u = np.clip((np.abs(T[:, 0]) - a[:, 0]) / np.maximum(a[:, 1] - a[:, 0], 1e-3), 0, 1.05)
        v = np.clip((T[:, 1] - a[:, 2]) / np.maximum(a[:, 3] - a[:, 2], 1e-3), -0.05, 1.05)
        T = np.stack([np.sign(T[:, 0]) * (b[:, 0] + u * (b[:, 1] - b[:, 0])), b[:, 2] + v * (b[:, 3] - b[:, 2]), zt], 1)
        cut = BODY_CUT
        # the body's moulded shorts under the part are deleted (below), so only the two rims that stay need
        # clearance: the waistband on the belly and the hem over the old hem's lip
        rim = np.nonzero((T[:, 2] > cut[1] - 0.02) | (T[:, 2] < cut[0] + 0.02))[0].tolist()
        stretch = (tz1 - TRUNKS_BAND - tz0) / (zb - dz0)
    # clearance: pushed sideways only, so the level cuts stay level
    bmb = bmesh.new(); bmb.from_mesh(body.data)
    bvh_b = BVHTree.FromBMesh(bmb)
    pushed = 0
    for it in range(3):
        for i in rim:
            loc, nrm, _, _ = bvh_b.find_nearest(Vector(T[i].tolist()))
            if loc is None: continue
            sd = (Vector(T[i].tolist()) - loc).dot(nrm)
            nh = math.hypot(nrm.x, nrm.y)
            if sd < TRUNKS_CLEAR and nh > 1e-3:
                k_ = (TRUNKS_CLEAR - sd) / max(nh, 0.4) / nh
                T[i, 0] += nrm.x * k_; T[i, 1] += nrm.y * k_
                pushed += it == 0
    bmb.free()
    lo.data.vertices.foreach_set("co", T.astype(np.float32).ravel())
    lo.data.update()
    log("trunks: %d -> %d tris; z %.3f..%.3f (leg stretch x%.2f); %d of %d rim verts pushed out to %.0f mm clearance"
        % (tris_hi, sum(len(p.vertices) - 2 for p in lo.data.polygons), T[:, 2].min(), T[:, 2].max(),
           stretch, pushed, len(rim), 1000 * TRUNKS_CLEAR))

    # ---- hem bones: front / outer / back of each leg, vertical, head HEM_LEN above the hem ----
    hem = {}
    for s, sg in (("Left", 1), ("Right", -1)):
        m = (sg * T[:, 0] > 0.03) & (T[:, 2] < tz0 + 0.04)
        ax_ = np.abs(T[m, 0])
        cx_, cy_ = (ax_.min() + ax_.max()) / 2, (T[m, 1].min() + T[m, 1].max()) / 2
        hem[s] = (cx_, cy_)
        for d, (px_, py_) in (("f", (cx_, T[m, 1].min())), ("o", (ax_.max(), cy_)), ("b", (cx_, T[m, 1].max()))):
            hem["hem_%s_%s" % (s, d)] = (sg * px_, py_)
    bpy.ops.object.select_all(action="DESELECT"); rig.select_set(True); bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for nme in HEM_BONES:
        eb_ = arm_data.edit_bones.new(nme)
        x_, y_ = hem[nme]
        eb_.head, eb_.tail = Vector((x_, y_, tz0 + HEM_LEN)), Vector((x_, y_, tz0))
        eb_.parent = arm_data.edit_bones["mixamorig:%sUpLeg" % nme.split("_")[1]]
    bpy.ops.object.mode_set(mode="OBJECT")

    # ---- weights: the body's own underneath (nearest vertex), smoothed over the cloth, then the hem bones ----
    kd = KDTree(len(Pb))
    for i in range(len(Pb)): kd.insert(Pb[i].tolist(), i)
    kd.balance()
    Wt = W[[kd.find(T[i].tolist())[1] for i in range(len(T))]].copy()
    me_ = lo.data
    Et = np.empty(len(me_.edges) * 2, dtype=np.int64); me_.edges.foreach_get("vertices", Et); Et = Et.reshape(-1, 2)
    degt = np.bincount(Et.ravel(), minlength=len(T)).astype(float)
    for it in range(8):
        acc = np.zeros_like(Wt)
        np.add.at(acc, Et[:, 0], Wt[Et[:, 1]]); np.add.at(acc, Et[:, 1], Wt[Et[:, 0]])
        Wt = 0.5 * Wt + 0.5 * acc / np.maximum(degt, 1)[:, None]
    Wh = np.zeros((len(T), len(HEM_BONES)))
    hfac = 0.9 * sm(tz0 + HEM_LEN, tz0 + 0.01, T[:, 2])
    for si, (s, sg) in enumerate((("Left", 1), ("Right", -1))):
        cx_, cy_ = hem[s]
        th_ = np.arctan2(T[:, 1] - cy_, sg * T[:, 0] - cx_)
        on = sg * T[:, 0] > 0
        for di, wd in enumerate((np.maximum(0, -np.sin(th_)) ** 2, np.maximum(0, np.cos(th_)) ** 2, np.maximum(0, np.sin(th_)) ** 2)):
            Wh[:, si * 3 + di] = np.where(on, hfac * wd, 0)
    Wall = np.concatenate([Wt * (1 - Wh.sum(1))[:, None], Wh], 1)
    order_ = np.argsort(-Wall, 1)
    keep_ = np.zeros_like(Wall, dtype=bool); np.put_along_axis(keep_, order_[:, :4], True, 1)
    Wall[~keep_] = 0; Wall[Wall < 0.01] = 0
    Wall /= np.maximum(Wall.sum(1, keepdims=True), 1e-9)
    for g in list(lo.vertex_groups): lo.vertex_groups.remove(g)
    for k, nme in enumerate(["mixamorig:" + b_ for b_ in BONES] + HEM_BONES):
        colw = Wall[:, k]
        nz = np.nonzero(colw > 0)[0]
        if not len(nz): continue
        g = lo.vertex_groups.new(name=nme)
        for vi in nz.tolist(): g.add([vi], float(colw[vi]), "REPLACE")
    lo.parent = rig
    am = lo.modifiers.new("Armature", "ARMATURE"); am.object = rig
    for p in lo.data.polygons: p.use_smooth = True
    lo.data.name = "trunks"
    # the body's own moulded shorts between the two rims go: the part replaces them (no poke-through, fewer triangles)
    bmb = bmesh.new(); bmb.from_mesh(body.data)
    gone = [f for f in bmb.faces if cut[0] < f.calc_center_median().z < cut[1] and abs(f.calc_center_median().x) < 0.30]
    bmesh.ops.delete(bmb, geom=gone, context="FACES")
    bmb.to_mesh(body.data); bmb.free(); body.data.update()
    log("body: %d faces of the moulded shorts deleted under the trunks part" % len(gone))
    timg.image = imgs["c"]
    render("trunks", views=("front", "back", "side"))
    for name, img in imgs.items():
        path = os.path.join(OUTDIR, "%s_%s.webp" % (TSTEM, name)); tmp = path[:-5] + "_tmp.webp"
        img.filepath_raw = tmp; img.file_format = "WEBP"; img.save(filepath=tmp, quality=90 if name == "c" else 92)
        os.replace(tmp, path); log("wrote", os.path.basename(path), os.path.getsize(path))
    tl_.node_tree.nodes.remove(timg)         # the loader loads trunks_<name>_* itself; the glb carries no image
    return lo
TRUNKS = build_trunks()

# ---------------------------------------------------------------- 7. export
mat = bpy.data.materials.new("meshy")
body.data.materials.clear()
body.data.materials.append(mat)
for o in list(bpy.data.objects):
    if o not in (body, rig, TRUNKS) + GLOVES:
        bpy.data.objects.remove(o, do_unlink=True)
for p in me.polygons:
    p.use_smooth = True
bpy.ops.object.select_all(action="SELECT")
TMP = OUT[:-4] + "_tmp.glb"
bpy.ops.export_scene.gltf(filepath=TMP, export_format="GLB", use_selection=False, export_animations=False,
                          export_skins=True, export_apply=False, export_yup=True, export_normals=True,
                          export_texcoords=True, export_materials="EXPORT")
with open(TMP, "rb") as f:
    blob = f.read()
magic, ver, length = struct.unpack("<4sII", blob[:12])
jlen, jtype = struct.unpack("<I4s", blob[12:20])
js = json.loads(blob[20:20 + jlen].decode("utf8"))
rest = blob[20 + jlen:]
# src/human/body.ts reads this: one baked material, textures <glb stem>_{c,n,r,mask,skin}.webp next to the glb
js.setdefault("asset", {})["extras"] = {"look": 3, "kind": "meshy", "stem": STEM, "height": H, "glove": GSTEM, "trunks": TSTEM}
raw = json.dumps(js, separators=(",", ":")).encode("utf8")
raw += b" " * ((4 - len(raw) % 4) % 4)
with open(TMP, "wb") as f:
    f.write(struct.pack("<4sII", magic, ver, 12 + 8 + len(raw) + len(rest)))
    f.write(struct.pack("<I4s", len(raw), jtype))
    f.write(raw)
    f.write(rest)
os.replace(TMP, OUT)
log("WROTE", OUT, os.path.getsize(OUT), "tris", tris_out, "bones", len(arm_data.bones))
