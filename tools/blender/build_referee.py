# Meshy referee -> game file. Run through tools/blender/build_referee.mjs, never directly.
# argv after "--": <cache dir with the unzipped FBX + PNGs> <out glb> <screenshot dir> <probe|build>
#
# A cut-down tools/blender/build_meshy.py (the boxers' pipeline) for a clothed man with bare hands and no kit parts:
# import, scale to H with the feet on z=0; measure the joints from cross sections; decimate (denser at the joints and
# face), fresh UVs, re-bake colour / normal / roughness from the original; the same 52-bone Mixamo-named skeleton;
# bone-heat weights plus the head rule; export the glb with its three textures embedded.
import bpy, bmesh, sys, os, math, json, struct, time
import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
CACHE, OUT, SHOTS, MODE = argv[:4]
H = 1.80                    # standing height (m), the boxers' build height
TRI_TARGET = 30000
T0 = time.time()
def log(*a):
    print("[referee %5.1fs]" % (time.time() - T0), *a, flush=True)

files = os.listdir(CACHE)
FBX = os.path.join(CACHE, next(f for f in files if f.lower().endswith(".fbx")))
def tex(tag):
    for f in files:
        b = f.lower()
        if b.endswith(".png") and (b.endswith("_%s.png" % tag) if tag else not any(b.endswith("_%s.png" % t) for t in ("normal", "roughness", "metallic"))):
            return os.path.join(CACHE, f)
    raise SystemExit("texture missing: " + (tag or "base colour"))
TEX_C, TEX_N, TEX_R = tex(""), tex("normal"), tex("roughness")

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
from mathutils import Matrix
body.data.transform(Matrix.Translation(Vector([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])))
body.data.transform(Matrix.Scale(s, 4))
V = verts(body)
X, Y, Z = V[:, 0], V[:, 1], V[:, 2]
log("tris in", sum(len(p.vertices) - 2 for p in body.data.polygons), "verts", len(V), "scale", round(s, 4),
    "bbox", np.round(V.min(0), 3).tolist(), np.round(V.max(0), 3).tolist())

def rng(m, a):
    return (float(a[m].min()), float(a[m].max())) if m.any() else (None, None)

# ---------------------------------------------------------------- renders
def load_img(path, colour):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return img
def preview_material(o):
    mat = bpy.data.materials.new("body"); mat.use_nodes = True
    t = mat.node_tree.nodes.new("ShaderNodeTexImage"); t.image = load_img(TEX_C, True)
    mat.node_tree.links.new(t.outputs["Color"], mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    o.data.materials.clear(); o.data.materials.append(mat)
def render(tag, views=("front", "side")):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "TEXTURE"
    sc.render.resolution_x, sc.render.resolution_y = 600, 900
    cam = bpy.data.objects.get("Cam")
    if cam is None:
        cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
        sc.collection.objects.link(cam)
    cam.data.type = "ORTHO"; cam.data.ortho_scale = 2.0; sc.camera = cam
    for v in views:
        if v == "front":  cam.location = (0, -4, 0.92); cam.rotation_euler = (math.pi / 2, 0, 0)
        elif v == "side": cam.location = (4, 0, 0.92);  cam.rotation_euler = (math.pi / 2, 0, math.pi / 2)
        elif v == "back": cam.location = (0, 4, 0.92);  cam.rotation_euler = (math.pi / 2, 0, math.pi)
        sc.render.filepath = os.path.join(SHOTS, "referee_%s_%s.png" % (tag, v))
        bpy.ops.render.render(write_still=True)
    log("rendered", tag, views)

preview_material(body)
if MODE == "probe":
    render("before", ("front", "side", "back"))
    print("HEAD y range (z>1.6)", rng(Z > 1.6, Y), "-> the face is on the side with the nose")
    print("WIDTH by z: x extent / y extent")
    print(" ".join("%.2f:%.2f/%.2f" % (z, *(lambda m: (float(np.ptp(X[m])) if m.any() else 0, float(np.ptp(Y[m])) if m.any() else 0))((Z >= z) & (Z < z + 0.02)))
                   for z in np.arange(0.0, 1.80, 0.05)))
    print("LEFT ARM (x>0.10) by x: zmin zmax")
    print(" ".join("%.2f:%s" % (x, (lambda r: "%.2f/%.2f" % r if r[0] is not None else "-")(rng((X >= x) & (X < x + 0.02) & (Z > 0.8), Z)))
                   for x in np.arange(0.10, 0.95, 0.04)))
    raise SystemExit(0)

# ---------------------------------------------------------------- 2. joints (left side; Blender: x left, -y front, z up)
def arm_slice(x):
    m = (X >= x) & (X < x + 0.01) & (Z > 1.2)
    return m
ARMX = np.arange(0.10, float(X.max()), 0.01)
_col = lambda x: (X >= x) & (X < x + 0.01) & (Z > 0.6)                 # the whole column at x, torso included
armpit = next(float(x) for x in ARMX if _col(x).any() and Z[_col(x)].min() > 1.2)   # the arm's underside leaves the torso
tip = float(X.max())
# the wrist: the thinnest section (z extent + y extent) between the forearm and the fist
cand = [(float(x), float(np.ptp(Z[arm_slice(x)]) + np.ptp(Y[arm_slice(x)]))) for x in np.arange(tip - 0.20, tip - 0.06, 0.01) if arm_slice(x).any()]
wrist = min(cand, key=lambda t: t[1])[0]
def arm_centre(x):
    m = arm_slice(x)
    return (float((Y[m].min() + Y[m].max()) / 2), float((Z[m].min() + Z[m].max()) / 2))
sh_x = armpit - 0.015
sh_y, sh_z = arm_centre(armpit + 0.06)
wr_y, wr_z = arm_centre(wrist)
el_x = sh_x + 0.54 * (wrist - sh_x)                   # humerus : forearm ~ 0.31 : 0.26 of stature
el_y, el_z = arm_centre(el_x)
def slice_c(m):
    return (float((X[m].min() + X[m].max()) / 2), float((Y[m].min() + Y[m].max()) / 2))
tw = [(float(z), float(np.ptp(X[(np.abs(X) < 0.28) & (Z >= z) & (Z < z + 0.01)]))) for z in np.arange(1.45, 1.62, 0.01)]
neck_z = next(z for z, w in tw if w < 0.30)            # top of the shoulders: the slice narrows to the neck
head_z = neck_z + 0.065                                # skull base, level with the mouth
_, neck_y = slice_c((np.abs(X) < 0.08) & (Z >= neck_z + 0.02) & (Z < neck_z + 0.03))
leg = lambda z0: (X > 0.02) & (Z >= z0) & (Z < z0 + 0.01)
yd = [(float(z), float(np.ptp(Y[leg(z)]))) for z in np.arange(0.42, 0.58, 0.01)]
knee_z = min(yd, key=lambda t: t[1])[0]
knee_x, knee_y = slice_c(leg(knee_z))
ank_z = 0.047 * H
ank_x, ank_y = slice_c(leg(0.10))
toe_tip = float(Y[(Z < 0.04) & (X > 0)].min())
ball_y = ank_y + 0.71 * (toe_tip - ank_y)
upleg_z, hips_z = 0.517 * H, 0.545 * H
log("joints: armpit %.3f shoulder %.3f elbow %.3f wrist %.3f tip %.3f | neck %.3f head %.3f knee %.3f"
    % (armpit, sh_x, el_x, wrist, tip, neck_z, head_z, knee_z))
J = {
    "Hips": (0, 0.005, hips_z), "Spine": (0, 0.02, 1.09), "Spine1": (0, 0.025, 1.18), "Spine2": (0, 0.03, 1.31),
    "Neck": (0, neck_y, neck_z), "Head": (0, neck_y - 0.005, head_z),
    "LeftShoulder": (0.06, 0.03, sh_z + 0.03), "LeftArm": (sh_x, sh_y, sh_z), "LeftForeArm": (el_x, el_y, el_z),
    "LeftHand": (wrist, wr_y, wr_z),
    "LeftUpLeg": (0.095, 0.005, upleg_z), "LeftLeg": (knee_x, knee_y, knee_z), "LeftFoot": (ank_x, ank_y, ank_z),
    "LeftToeBase": (ank_x + 0.015, ball_y, 0.025),
}
# fingers (a closed fist: the hand mesh is rigid to the Hand bone; the chains exist so the skeleton matches the boxers')
kx = wrist + 0.06
for f, dy, dz, dx in (("Index", -0.025, 0.004, 0), ("Middle", -0.005, 0.002, 0.005), ("Ring", 0.015, 0, 0), ("Pinky", 0.033, -0.004, -0.012)):
    for i in range(3):
        J["LeftHand%s%d" % (f, i + 1)] = (kx + dx + 0.02 * i, wr_y + dy, wr_z + dz)
for i, (dx, dy, dz) in enumerate(((0.02, -0.03, -0.015), (0.04, -0.04, -0.02), (0.06, -0.05, -0.022))):
    J["LeftHandThumb%d" % (i + 1)] = (wrist + dx, wr_y + dy, wr_z + dz)
for k in list(J):
    if k.startswith("Left"):
        x, y, z = J[k]
        J["Right" + k[4:]] = (-x, y, z)
PARENT = {"Hips": None, "Spine": "Hips", "Spine1": "Spine", "Spine2": "Spine1", "Neck": "Spine2", "Head": "Neck"}
for sd in ("Left", "Right"):
    PARENT.update({sd + "Shoulder": "Spine2", sd + "Arm": sd + "Shoulder", sd + "ForeArm": sd + "Arm", sd + "Hand": sd + "ForeArm",
                   sd + "UpLeg": "Hips", sd + "Leg": sd + "UpLeg", sd + "Foot": sd + "Leg", sd + "ToeBase": sd + "Foot"})
    for f in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
        for i in (1, 2, 3):
            PARENT["%sHand%s%d" % (sd, f, i)] = sd + "Hand" if i == 1 else "%sHand%s%d" % (sd, f, i - 1)
assert len(PARENT) == 52 and set(PARENT) == set(J)
CHILD = {"Hips": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Neck", "Neck": "Head"}
for sd in ("Left", "Right"):
    CHILD.update({sd + "Shoulder": sd + "Arm", sd + "Arm": sd + "ForeArm", sd + "ForeArm": sd + "Hand", sd + "Hand": sd + "HandMiddle1",
                  sd + "UpLeg": sd + "Leg", sd + "Leg": sd + "Foot", sd + "Foot": sd + "ToeBase"})
    for f in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
        CHILD.update({"%sHand%s1" % (sd, f): "%sHand%s2" % (sd, f), "%sHand%s2" % (sd, f): "%sHand%s3" % (sd, f)})

# ---------------------------------------------------------------- 3. decimate (denser at joints and the face), re-bake
vg = body.vertex_groups.new(name="dens")
P = np.stack([X, Y, Z], 1)
w = np.zeros(len(P))
for k in ("LeftArm", "LeftForeArm", "LeftUpLeg", "LeftLeg", "RightArm", "RightForeArm", "RightUpLeg", "RightLeg", "Neck"):
    w = np.maximum(w, np.exp(-(np.linalg.norm(P - np.array(J[k]), axis=1) / 0.07) ** 2))
w = np.maximum(w, ((Z > head_z - 0.04) & (Y < 0.0)).astype(float))          # the face
for val in (0.25, 0.5, 0.75, 1.0):
    idx = np.nonzero((w > val - 0.25) & (w <= val))[0].tolist()
    if idx: vg.add(idx, val, "REPLACE")
tris_in = sum(len(p.vertices) - 2 for p in body.data.polygons)
high = body.copy(); high.data = body.data.copy(); high.name = "High"
bpy.context.scene.collection.objects.link(high)
mod = body.modifiers.new("dec", "DECIMATE")
mod.decimate_type = "COLLAPSE"; mod.ratio = TRI_TARGET / tris_in; mod.use_collapse_triangulate = True
mod.use_symmetry = True; mod.symmetry_axis = "X"
mod.vertex_group = "dens"; mod.invert_vertex_group = True; mod.vertex_group_factor = 4.0
bpy.ops.object.modifier_apply(modifier=mod.name)
body.vertex_groups.remove(body.vertex_groups["dens"])
tris_out = sum(len(p.vertices) - 2 for p in body.data.polygons)
log("decimated", tris_in, "->", tris_out, "tris")
me = body.data
old_uv = me.uv_layers[0].name
uvn = me.uv_layers.new(name="UV"); me.uv_layers.active = uvn
bpy.ops.object.select_all(action="DESELECT"); body.select_set(True); bpy.context.view_layer.objects.active = body
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.003)
bpy.ops.uv.select_all(action="SELECT")
bpy.ops.uv.pack_islands(rotate=True, margin=0.003)
bpy.ops.object.mode_set(mode="OBJECT")
me.uv_layers.remove(me.uv_layers[old_uv])
me.uv_layers.active = me.uv_layers["UV"]; me.uv_layers["UV"].active_render = True

hm = bpy.data.materials.new("high"); hm.use_nodes = True
hn = hm.node_tree; hb = hn.nodes["Principled BSDF"]; hout = hn.nodes["Material Output"]
def tnode(path, colour):
    t = hn.nodes.new("ShaderNodeTexImage"); t.image = load_img(path, colour); return t
tc, tnm, tr = tnode(TEX_C, True), tnode(TEX_N, False), tnode(TEX_R, False)
nmap = hn.nodes.new("ShaderNodeNormalMap")
hn.links.new(tnm.outputs["Color"], nmap.inputs["Color"]); hn.links.new(nmap.outputs["Normal"], hb.inputs["Normal"])
hn.links.new(tc.outputs["Color"], hb.inputs["Base Color"])
emi = hn.nodes.new("ShaderNodeEmission")
high.data.materials.clear(); high.data.materials.append(hm)
lm = bpy.data.materials.new("referee"); lm.use_nodes = True
ln = lm.node_tree; lb = ln.nodes["Principled BSDF"]
limg = ln.nodes.new("ShaderNodeTexImage"); ln.nodes.active = limg
me.materials.clear(); me.materials.append(lm)
sc = bpy.context.scene
sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 1; sc.render.bake.margin = 8
def bake(name, n, colour, kind, src=None):
    img = bpy.data.images.new(name, n, n, alpha=False)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    limg.image = img
    if src is not None:
        hn.links.new(src.outputs["Color"], emi.inputs["Color"]); hn.links.new(emi.outputs["Emission"], hout.inputs["Surface"])
    else:
        hn.links.new(hb.outputs["BSDF"], hout.inputs["Surface"])
    bpy.ops.object.select_all(action="DESELECT"); high.select_set(True); body.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.bake(type=kind, use_selected_to_active=True, cage_extrusion=0.012, max_ray_distance=0.05, margin=8, normal_space="TANGENT")
    img.pack()
    log("baked", name, n)
    return img
C = bake("referee_c", 2048, True, "EMIT", tc)
Nm = bake("referee_n", 2048, False, "NORMAL")
R = bake("referee_r", 1024, False, "EMIT", tr)
bpy.data.objects.remove(high, do_unlink=True)
# the export material: colour, normal, roughness (the exporter packs roughness into the glTF metal-rough map)
ln.nodes.remove(limg)
def lnode(img):
    t = ln.nodes.new("ShaderNodeTexImage"); t.image = img; return t
ln.links.new(lnode(C).outputs["Color"], lb.inputs["Base Color"])
lnm = ln.nodes.new("ShaderNodeNormalMap")
ln.links.new(lnode(Nm).outputs["Color"], lnm.inputs["Color"]); ln.links.new(lnm.outputs["Normal"], lb.inputs["Normal"])
ln.links.new(lnode(R).outputs["Color"], lb.inputs["Roughness"])
lb.inputs["Metallic"].default_value = 0.0
render("after", ("front", "side"))

# ---------------------------------------------------------------- 4. skeleton (the boxers' 52 Mixamo names)
arm_data = bpy.data.armatures.new("Armature")
rig = bpy.data.objects.new("Armature", arm_data)
bpy.context.scene.collection.objects.link(rig)
bpy.ops.object.select_all(action="DESELECT"); rig.select_set(True); bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
eb = {}
for k in PARENT:
    b = arm_data.edit_bones.new("mixamorig:" + k)
    h = Vector(J[k])
    if k in CHILD: t = Vector(J[CHILD[k]])
    elif k == "Head": t = h + Vector((0, 0, 0.18))
    elif k.endswith("ToeBase"): t = Vector((h.x, toe_tip, h.z))
    else: t = h + (h - Vector(J[PARENT[k]])).normalized() * 0.02
    b.head, b.tail = h, t
    if PARENT[k]: b.parent = eb[PARENT[k]]
    eb[k] = b
bpy.ops.object.mode_set(mode="OBJECT")
BONES = list(PARENT)
BI = {k: i for i, k in enumerate(BONES)}

# ---------------------------------------------------------------- 5. weights: bone heat, then rules
bpy.ops.object.select_all(action="DESELECT"); body.select_set(True); rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
nv = len(me.vertices)
gi = {g.index: BI.get(g.name.replace("mixamorig:", ""), -1) for g in body.vertex_groups}
W = np.zeros((nv, len(BONES)))
for v in me.vertices:
    for g in v.groups:
        b = gi.get(g.group, -1)
        if b >= 0: W[v.index, b] = g.weight
P = verts(body).astype(np.float64)
X, Y, Z = P[:, 0], P[:, 1], P[:, 2]
def seg_dist(p, a, b):
    a, b = np.array(a), np.array(b); ab = b - a
    t = np.clip(((p - a) @ ab) / max(ab @ ab, 1e-9), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)
orphan = W.sum(1) < 1e-6
log("bone heat: %d / %d vertices got no weight" % (int(orphan.sum()), nv))
if orphan.any():   # heat failures: nearest bone segment
    body_bones = [k for k in BONES if "Hand" not in k or k.endswith("Hand")]
    D = np.stack([seg_dist(P[orphan], J[k], J[CHILD[k]] if k in CHILD else J[k]) for k in body_bones], 1)
    W[np.nonzero(orphan)[0], [BI[body_bones[i]] for i in D.argmin(1)]] = 1.0
side = np.where(X >= 0, "Left", "Right")
ax = np.abs(X)
def one(mask, bone_of, val=1.0):
    idx = np.nonzero(mask)[0]
    names = bone_of if isinstance(bone_of, np.ndarray) else np.array([bone_of] * len(idx))
    names = names if len(names) == len(idx) else names[idx]
    v = val if np.isscalar(val) else val[idx]
    W[idx] *= (1 - v) if np.isscalar(v) else (1 - v)[:, None]
    W[idx, [BI[n] for n in names]] += v
sm = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))
# the fist is rigid to the Hand, blending in from the forearm across the wrist
hand = (ax > wrist - 0.04) & (Z > 1.2)
W[hand] = 0
one(hand, np.char.add(side, "ForeArm"), 1.0)
one(hand, np.char.add(side, "Hand"), sm(wrist - 0.03, wrist + 0.01, ax))
# the arms are in a T: nothing below the armpit belongs to an arm (bone heat bleeds the sleeve into the shirt side)
torso = (ax < armpit - 0.01) & (Z < sh_z - 0.08)
for k in ("Arm", "ForeArm", "Hand"):
    for sd in ("Left", "Right"):
        W[torso, BI[sd + k]] = 0
# head above the jaw line, neck blend below it
jaw = neck_z + 0.035 + np.clip(Y + 0.07, 0, 0.09) * (0.03 / 0.09)
headr = (ax < 0.13) & (Z > jaw)
W[headr] = 0; W[headr, BI["Head"]] = 1
neckr = (ax < 0.10) & (Z > neck_z + 0.005) & ~headr
one(neckr, "Head", sm(neck_z + 0.005, jaw + 0.005, Z))
# shoes: foot / toe by depth
shoe = (Z < 0.09) & (ax > 0.03)
W[shoe] = 0
one(shoe, np.char.add(side, "Foot"), 1.0)
one(shoe, np.char.add(side, "ToeBase"), sm(ball_y + 0.02, ball_y - 0.02, Y))
# smooth over the shirt / trousers so no single vertex stands out (cloth tears on a bent hip or shoulder otherwise)
E = np.empty(len(me.edges) * 2, dtype=np.int64); me.edges.foreach_get("vertices", E); E = E.reshape(-1, 2)
deg = np.bincount(E.ravel(), minlength=nv).astype(float)
cloth = (Z > 0.12) & (Z < neck_z) & ~hand
for it in range(4):
    acc = np.zeros_like(W)
    np.add.at(acc, E[:, 0], W[E[:, 1]]); np.add.at(acc, E[:, 1], W[E[:, 0]])
    avg = acc / np.maximum(deg, 1)[:, None]
    W[cloth] = 0.5 * W[cloth] + 0.5 * avg[cloth]
order = np.argsort(-W, 1)
keep = np.zeros_like(W, dtype=bool); np.put_along_axis(keep, order[:, :4], True, 1)
W[~keep] = 0; W[W < 0.01] = 0
W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
for g in list(body.vertex_groups): body.vertex_groups.remove(g)
for k in BONES:
    g = body.vertex_groups.new(name="mixamorig:" + k)
    col = W[:, BI[k]]
    for v in np.nonzero(col > 0)[0].tolist():
        g.add([v], float(col[v]), "REPLACE")
log("weights done: hand verts", int(hand.sum()), "shoe verts", int(shoe.sum()))

# ---------------------------------------------------------------- 6. export
for o in list(bpy.data.objects):
    if o not in (body, rig): bpy.data.objects.remove(o, do_unlink=True)
for p in me.polygons: p.use_smooth = True
bpy.ops.object.select_all(action="SELECT")
TMP = OUT[:-4] + "_tmp.glb"
bpy.ops.export_scene.gltf(filepath=TMP, export_format="GLB", use_selection=False, export_animations=False,
                          export_skins=True, export_apply=False, export_yup=True, export_normals=True,
                          export_texcoords=True, export_materials="EXPORT", export_image_format="WEBP")
with open(TMP, "rb") as f: blob = f.read()
magic, ver, length = struct.unpack("<4sII", blob[:12])
jlen, jtype = struct.unpack("<I4s", blob[12:20])
js = json.loads(blob[20:20 + jlen].decode("utf8"))
rest = blob[20 + jlen:]
js.setdefault("asset", {})["extras"] = {"kind": "referee", "height": H}
raw = json.dumps(js, separators=(",", ":")).encode("utf8")
raw += b" " * ((4 - len(raw) % 4) % 4)
with open(TMP, "wb") as f:
    f.write(struct.pack("<4sII", magic, ver, 12 + 8 + len(raw) + len(rest)))
    f.write(struct.pack("<I4s", len(raw), jtype)); f.write(raw); f.write(rest)
os.replace(TMP, OUT)
log("WROTE", OUT, os.path.getsize(OUT), "tris", tris_out, "bones", len(arm_data.bones))
