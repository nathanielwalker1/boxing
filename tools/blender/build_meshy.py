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
el_x = sh_x + 0.54 * (wrist - sh_x)                   # humerus : forearm ~ 0.31 : 0.26 of stature
el_y, el_z = arm_centre(el_x)
wr_y, wr_z = arm_centre(wrist - 0.09)                 # forearm axis (the hand part of the glove is offset)
def slice_c(m):
    return (float((X[m].min() + X[m].max()) / 2), float((Y[m].min() + Y[m].max()) / 2))
tw = [(z, (lambda m: float(X[m].max() - X[m].min()))((np.abs(X) < 0.28) & (Z >= z) & (Z < z + 0.01))) for z in np.arange(1.45, 1.60, 0.01)]
neck_z = next(z for z, w in tw if w < 0.30)          # top of the shoulders: the slice narrows to the neck
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
for f in bm.faces:
    c = f.calc_center_median()
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
bmesh.ops.delete(bm, geom=hidden, context="FACES")
bm.to_mesh(body.data)
bm.free()
log("deleted %d hidden faces under the trunks" % len(hidden))
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
# gloves: rigid to the Hand, a short blend into the ForeArm at the cuff
glove = (ax > cuff - 0.01) & (Z > 1.2)
W[glove] = 0
t = sm(cuff - 0.01, cuff + 0.035, ax)
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
tl[(cx > cuff - 0.02) & (cz > 1.2)] = 5                       # cuff edge: decided by colour
tl[(cx > cuff + 0.01) & (cz > 1.2)] = 2                       # glove core
tn = np.empty(len(me.loop_triangles) * 3, dtype=np.float32); me.loop_triangles.foreach_get("normal", tn); tn = tn.reshape(-1, 3)
tsw = ((cz > 1.28) & (cz < 1.53) & (cx < 0.30)).astype(np.float32)   # sweat sheen zone: shoulders, upper chest / back
nyr = np.zeros((N1, N1), dtype=np.float32)                    # facing: + = back (Blender +y)
swr = np.zeros((N1, N1), dtype=np.float32)
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
rm = np.ones((N1, N1, 4), dtype=np.float32); rm[..., 0] = rough; rm[..., 1] = rough; rm[..., 2] = 0
save(new_img("rm", N1, rm), "r", 90)                          # G roughness, B metalness 0 (glTF packing)
log("roughness means: skin %.2f trunks %.2f gloves %.2f" % (float(rough[ch[3] > 0.5].mean()), float(rough[ch[0] > 0.5].mean()), float(rough[ch[1] > 0.5].mean())))

# ---------------------------------------------------------------- 7. export
mat = bpy.data.materials.new("meshy")
body.data.materials.clear()
body.data.materials.append(mat)
for o in list(bpy.data.objects):
    if o not in (body, rig):
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
js.setdefault("asset", {})["extras"] = {"look": 3, "kind": "meshy", "stem": STEM, "height": H}
raw = json.dumps(js, separators=(",", ":")).encode("utf8")
raw += b" " * ((4 - len(raw) % 4) % 4)
with open(TMP, "wb") as f:
    f.write(struct.pack("<4sII", magic, ver, 12 + 8 + len(raw) + len(rest)))
    f.write(struct.pack("<I4s", len(raw), jtype))
    f.write(raw)
    f.write(rest)
os.replace(TMP, OUT)
log("WROTE", OUT, os.path.getsize(OUT), "tris", tris_out, "bones", len(arm_data.bones))
