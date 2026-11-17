"""Build the realistic boxer GLB (body + kit, skeleton, no animation).

Run through tools/blender/build.mjs (npm run asset:boxer) or directly:
  Blender --background --python tools/blender/build_boxer.py -- <out.glb> [skin_dark.webp out]

Needs the MPFB extension installed in Blender and the MakeHuman system assets pack copied into the
MPFB user data dir (see docs/ASSETS.md). Everything that ships is MPFB / MakeHuman CC0 output plus
geometry modelled here (gloves, trunks, boots).
"""
import sys, os, math, json, struct
import bpy, bmesh, addon_utils
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "/tmp/boxer.glb"
OUT_DIR = os.path.dirname(OUT)

# ---- tunables (this is the one place the look of the body is set) ----
MACRO = {"gender": 1.0, "age": 0.5, "muscle": 0.66, "weight": 0.40, "proportions": 0.5, "height": 0.52}
DETAILS = {  # MPFB target name -> weight
    "torso-vshape-incr": 0.55,
    "torso-muscle-pectoral-incr": 0.30,
    "torso-muscle-dorsi-incr": 0.45,
    "torso-scale-depth-decr": 0.15,
    "neck-scale-horiz-incr": 0.35,
    "neck-scale-vert-decr": 0.10,
    "l-upperarm-muscle-incr": 0.35, "r-upperarm-muscle-incr": 0.35,
    "l-upperarm-shoulder-muscle-incr": 0.5, "r-upperarm-shoulder-muscle-incr": 0.5,
    "l-lowerarm-muscle-incr": 0.35, "r-lowerarm-muscle-incr": 0.35,
    "l-upperleg-muscle-incr": 0.25, "r-upperleg-muscle-incr": 0.25,
    "l-lowerleg-muscle-incr": 0.35, "r-lowerleg-muscle-incr": 0.35,
    "head-scale-vert-incr": 0.3, "head-scale-horiz-incr": 0.2, "head-scale-depth-incr": 0.2,   # ~7.4 heads tall
}
SKIN_TEX = "skins/young_caucasian_male/young_lightskinned_male_diffuse.png"
SKIN_TEX_DARK = "skins/young_african_male/young_darkskinned_male_diffuse.png"
HAIR_ASSET = "hair/short02/short02.mhclo"

mod = "bl_ext.user_default.mpfb"
addon_utils.enable(mod, default_set=False, persistent=False)
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService
from bl_ext.user_default.mpfb.services.locationservice import LocationService


def data(p):
    return os.path.join(LocationService.get_user_data(), p) if False else os.path.join(USER_DATA, p)


USER_DATA = LocationService.get_user_data()
print("USER_DATA", USER_DATA)

# ---- clean scene ----
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)


def select_only(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


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
ZOFF = rig.location.z
print("rig offset z", ZOFF)

# attachments (fit to the shaped basemesh before shape keys are baked)
parts = {}
for key, rel in [("Eyes", "eyes/high-poly/high-poly.mhclo"), ("Brows", "eyebrows/eyebrow001/eyebrow001.mhclo"),
                 ("Lashes", "eyelashes/eyelashes01/eyelashes01.mhclo"), ("Hair", HAIR_ASSET)]:
    atype = {"Eyes": "Eyes", "Brows": "Eyebrows", "Lashes": "Eyelashes", "Hair": "Hair"}[key]
    o = HumanService.add_mhclo_asset(os.path.join(USER_DATA, rel), base, asset_type=atype, material_type="GAMEENGINE",
                                     subdiv_levels=0)
    o.name = key
    o.data.name = key
    parts[key] = o
    print("asset", key, len(o.data.vertices), tris(o))

# bake targets into the mesh, drop helpers
select_only(base)
bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
for m in list(base.modifiers):
    if m.type == "MASK":
        bpy.ops.object.modifier_apply(modifier=m.name)
print("body after mask", len(base.data.vertices), tris(base))

BONE_PREFIX = "mixamorig:"
bone_names = set(b.name for b in rig.data.bones)


def dominant(me_obj):
    """per-vertex dominant bone name"""
    names = {g.index: g.name for g in me_obj.vertex_groups if g.name in bone_names}
    out = []
    for v in me_obj.data.vertices:
        best, bw = None, 0.0
        for ge in v.groups:
            if ge.group in names and ge.weight > bw:
                best, bw = names[ge.group], ge.weight
        out.append(best)
    return out


# ---- measure the body (before cutting) ----
dom0 = dominant(base)
zs = [W @ v.co for v in base.data.vertices]
z_top = max(c.z for c in zs)
head_ids = [i for i, d in enumerate(dom0) if d == BONE_PREFIX + "Head"]
hy = sum(zs[i].y for i in head_ids) / len(head_ids)
chin_z = min(zs[i].z for i in head_ids if zs[i].y < hy - 0.03)
head_h = z_top - chin_z
print("HEIGHT %.3f head %.3f heads %.2f" % (z_top, head_h, z_top / head_h))

bones = rig.data.bones


def bw(name):  # bone head in world
    return W @ bones[BONE_PREFIX + name].head_local


hips_z = bw("Hips").z
knee_z = bw("LeftLeg").z
ankle_z = bw("LeftFoot").z
crotch_z = hips_z - 0.06
print("hips %.3f knee %.3f ankle %.3f" % (hips_z, knee_z, ankle_z))
for bn in ("Hips", "Spine", "Spine2", "Neck", "Head", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
           "LeftHandMiddle1", "LeftHandThumb1", "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase"):
    h = bw(bn)
    print("JOINT %-16s %.3f %.3f %.3f" % (bn, h.x, h.y, h.z))

Z_TOP = hips_z + 0.085
Z_HEM = knee_z + 0.14
BOOT_TOP = ankle_z + 0.15


def dup_body(name):
    o = base.copy()
    o.data = base.data.copy()
    o.name = name
    o.data.name = name
    bpy.context.collection.objects.link(o)
    o.parent = rig
    return o


ARM_BONES = set(BONE_PREFIX + s + n for s in ("Left", "Right") for n in
                ("Shoulder", "Arm", "ForeArm", "Hand", "HandIndex1", "HandIndex2", "HandIndex3", "HandMiddle1",
                 "HandMiddle2", "HandMiddle3", "HandRing1", "HandRing2", "HandRing3", "HandPinky1", "HandPinky2",
                 "HandPinky3", "HandThumb1", "HandThumb2", "HandThumb3"))
FOOT_BONES = set(BONE_PREFIX + s + n for s in ("Left", "Right") for n in ("Foot", "ToeBase"))


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def carve(o, keep_fn, offset_fn, mat_fn, smooth_iter=0, planes=(), zrange=None, horizontal=False):
    """Cut the copy along horizontal `planes` (clean edge loops), keep verts for which keep_fn(world_co,
    dominant_bone) is true and z is inside zrange, smooth, then push them out along normals."""
    gnames = {g.index: g.name for g in o.vertex_groups if g.name in bone_names}
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for z in planes:
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z - ZOFF), plane_no=(0, 0, 1))
    lay = bm.verts.layers.deform.active

    def dom_of(v):
        best, bwt = None, 0.0
        for gi, wt in v[lay].items():
            if gi in gnames and wt > bwt:
                best, bwt = gnames[gi], wt
        return best

    eps = 1e-4
    kill = []
    for v in bm.verts:
        c = W @ v.co
        if zrange and (c.z < zrange[0] - eps or c.z > zrange[1] + eps):
            kill.append(v)
        elif not keep_fn(c, dom_of(v)):
            kill.append(v)
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    bm.verts.ensure_lookup_table()
    for _ in range(smooth_iter):
        bmesh.ops.smooth_vert(bm, verts=list(bm.verts), factor=0.5, use_axis_x=True, use_axis_y=True,
                              use_axis_z=True)
    bm.normal_update()
    shifts = []
    for v in bm.verts:
        n = v.normal.copy()
        if horizontal:
            n.z = 0.0  # rim normals are noisy; a vertical push tears the cut edge into teeth
        n.normalize()
        d = offset_fn(W @ v.co, n)
        shifts.append(n * d)
    for v, s in zip(bm.verts, shifts):
        v.co += s
    for f in bm.faces:
        f.material_index = mat_fn([W @ v.co for v in f.verts])
        f.smooth = True
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


# ---- 2. trunks ----
trunks = dup_body("Trunks")


def trunks_keep(c, d):
    return d not in ARM_BONES and Z_HEM <= c.z <= Z_TOP


def trunks_off(c, n):
    off = 0.008
    if c.z < crotch_z:  # legs flare toward the hem
        off += 0.016 * smoothstep(crotch_z, Z_HEM, c.z)
    if c.z > Z_TOP - 0.05:  # waistband sits proud
        off += 0.005
    return off


def trunks_mat(cs):
    zc = sum(c.z for c in cs) / len(cs)
    if zc > Z_TOP - 0.05:
        return 1
    if zc < Z_HEM + 0.03:
        return 1
    return 0


carve(trunks, trunks_keep, trunks_off, trunks_mat,
      planes=(Z_HEM, Z_HEM + 0.03, Z_TOP - 0.05, Z_TOP), zrange=(Z_HEM, Z_TOP), horizontal=True)

# the cut rims follow the body's own (noisy) weights and tear into teeth when the hips twist: smooth them
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


smooth_weights(trunks, 6)

# ---- 3. boots ----
boots = dup_body("Boots")


def boots_keep(c, d):
    return d not in ARM_BONES and c.z < BOOT_TOP and (d is None or "Leg" in d or "Foot" in d or "Toe" in d)


def boots_off(c, n):
    return 0.016 - 0.004 * smoothstep(0.08, BOOT_TOP, c.z)


def boots_mat(cs):
    zc = sum(c.z for c in cs) / len(cs)
    if zc < 0.03 or zc > BOOT_TOP - 0.03:
        return 1
    return 0


carve(boots, boots_keep, boots_off, boots_mat, smooth_iter=14,
      planes=(0.03, BOOT_TOP - 0.03, BOOT_TOP), zrange=(-1.0, BOOT_TOP))
# (boots keep vertical push: the sole needs it)
# keep the sole on the floor: smoothing pulls verts up, so flatten anything below 6 mm
bpy.context.view_layer.update()

# ---- 4. cut hands and feet off the skin (gloves and boots cover them) ----
dom = dominant(base)
bm = bmesh.new()
bm.from_mesh(base.data)
bm.verts.ensure_lookup_table()
kill = [v for v in bm.verts if dom[v.index] in FOOT_BONES or (dom[v.index] in ARM_BONES and "Hand" in dom[v.index])]
bmesh.ops.delete(bm, geom=kill, context="VERTS")
bm.to_mesh(base.data)
bm.free()
base.data.update()
print("body after hand/foot cut", len(base.data.vertices), tris(base))

# ---- 5. gloves ----


def make_glove(side):
    hand = side + "Hand"
    wrist = Vector(bw(hand))
    mid = Vector(bw(hand + "Middle1"))
    th = Vector(bw(hand + "Thumb1"))
    d = (mid - wrist).normalized()
    sx = 1.0 if wrist.x > 0 else -1.0
    p = Vector((-sx, 0, 0))
    p = (p - d * p.dot(d)).normalized()
    s = d.cross(p).normalized()
    if s.dot(th - mid) < 0:
        s = -s
    print(side, "glove frame d", tuple(round(x, 2) for x in d), "p", tuple(round(x, 2) for x in p), "s",
          tuple(round(x, 2) for x in s), "thumb-vs-palm", round((th - mid).normalized().dot(p), 2))

    def at(a, b, c):
        return wrist + d * a + s * b + p * c

    bm = bmesh.new()
    # fist: bean-shaped ellipsoid
    ret = bmesh.ops.create_uvsphere(bm, u_segments=28, v_segments=18, radius=1.0)
    fist_verts = ret["verts"]
    for v in fist_verts:
        x, y, z = v.co
        a = 0.100 + 0.092 * z
        taper = 1.0 + 0.10 * z
        b = 0.066 * x * taper
        c = 0.012 + 0.063 * y * taper
        # pinch the palm side a little so the curled fingers read
        v.co = at(a, b, c)
    # thumb
    ret = bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=1.0)
    thumb_verts = ret["verts"]
    for v in thumb_verts:
        x, y, z = v.co
        v.co = at(0.075 + 0.052 * z, 0.058 + 0.021 * x, 0.034 + 0.024 * y)
    # cuff
    ret = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=24, radius1=0.047, radius2=0.052,
                                depth=1.0)
    cuff_verts = ret["verts"]
    for v in cuff_verts:
        x, y, z = v.co  # z in -0.5..0.5 along the cone axis
        a = -0.040 + 0.115 * (z + 0.5) - 0.045
        v.co = at(a, x * 1.08, y)
    # laces: three small bars on the back of the cuff
    lace_verts = []
    for k in range(3):
        ret = bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=1.0)
        for v in ret["verts"]:
            x, y, z = v.co
            v.co = at(-0.072 + 0.017 * k + 0.006 * z, 0.032 * x, -0.052 + 0.006 * y)
        lace_verts += ret["verts"]
    bm.verts.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    # materials: 0 glove, 1 trim (cuff end bands + laces)
    lace_set = set(lace_verts)
    cuff_set = set(cuff_verts)
    for f in bm.faces:
        f.smooth = True
        vs = f.verts
        if all(v in lace_set for v in vs):
            f.material_index = 1
        elif all(v in cuff_set for v in vs):
            ac = sum((v.co - wrist).dot(d) for v in vs) / len(vs)
            f.material_index = 1 if (ac < -0.108 or ac > 0.026) else 0
        else:
            f.material_index = 0
    me = bpy.data.meshes.new("Glove" + side)
    # world -> armature local
    inv = W.inverted()
    for v in bm.verts:
        v.co = inv @ v.co
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("Glove" + side, me)
    bpy.context.collection.objects.link(ob)
    ob.parent = rig
    # weights: rigid on the hand, cuff blends to the forearm
    gh = ob.vertex_groups.new(name=BONE_PREFIX + hand)
    gf = ob.vertex_groups.new(name=BONE_PREFIX + side + "ForeArm")
    for v in me.vertices:
        a = (W @ v.co - wrist).dot(d)
        wf = max(0.0, min(1.0, (0.0 - a) / 0.09)) * 0.75
        gh.add([v.index], 1.0 - wf, "REPLACE")
        if wf > 0.001:
            gf.add([v.index], wf, "REPLACE")
    return ob


gl, gr = make_glove("Left"), make_glove("Right")
# join both gloves into one mesh object, "Gloves"
select_only(gl)
gr.select_set(True)
bpy.ops.object.join()
gloves = bpy.context.view_layer.objects.active
gloves.name = "Gloves"
gloves.data.name = "Gloves"

# ---- 6. materials ----


def tex_node(nt, path, linear_alpha=False):
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = bpy.data.images.load(path, check_existing=True)
    t.image.colorspace_settings.name = "sRGB"
    return t


def mk_mat(name, rgba, rough=0.6, metal=0.0, tex=None, alpha=False, sheen=0.0):
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
    if tex:
        t = tex_node(nt, tex)
        nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
        if alpha:
            nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    return m


def set_mats(o, mats):
    o.data.materials.clear()
    for m in mats:
        o.data.materials.append(m)


M_SKIN = mk_mat("skin", (1, 1, 1, 1), 0.62, tex=os.path.join(USER_DATA, SKIN_TEX))
M_GLOVE = mk_mat("glove", (0.8, 0.05, 0.05, 1), 0.38)
M_TRIM = mk_mat("trim", (0.92, 0.92, 0.9, 1), 0.5)
M_TRUNKS = mk_mat("trunks", (0.8, 0.05, 0.05, 1), 0.45)
M_BOOT = mk_mat("boot", (0.12, 0.12, 0.13, 1), 0.45)
M_HAIR = mk_mat("hair", (0.06, 0.04, 0.03, 1), 0.7)
M_EYE = mk_mat("eye", (1, 1, 1, 1), 0.15, tex=os.path.join(USER_DATA, "eyes/materials/brown_eye.png"))
M_BROW = mk_mat("brow", (1, 1, 1, 1), 0.8, tex=os.path.join(USER_DATA, "eyebrows/eyebrow001/eyebrow001.png"), alpha=True)
M_LASH = mk_mat("lash", (1, 1, 1, 1), 0.8, tex=os.path.join(USER_DATA, "eyelashes/eyelashes01/eyelashes01.png"), alpha=True)

set_mats(base, [M_SKIN])
set_mats(gloves, [M_GLOVE, M_TRIM])
set_mats(trunks, [M_TRUNKS, M_TRIM])
set_mats(boots, [M_BOOT, M_TRIM])
set_mats(parts["Hair"], [M_HAIR])
set_mats(parts["Eyes"], [M_EYE])
set_mats(parts["Brows"], [M_BROW])
set_mats(parts["Lashes"], [M_LASH])

# ---- 7. tidy: only bone vertex groups, armature modifier, smooth shading ----
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
    if o.parent == rig and o.matrix_parent_inverse != o.matrix_parent_inverse.Identity(4):
        pass
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

# ---- 8. export ----
os.makedirs(OUT_DIR, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=False, export_animations=False,
                          export_skins=True, export_apply=False, export_yup=True, export_image_format="WEBP",
                          export_image_quality=85, export_normals=True,
                          export_texcoords=True, export_materials="EXPORT")

# ---- 9. post-process the GLB json: alpha modes, double sided kit ----
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

# second skin tone as a stand-alone texture (same UVs), swapped in at runtime
if len(argv) > 1:
    img = bpy.data.images.load(os.path.join(USER_DATA, SKIN_TEX_DARK))
    _ = img.pixels[0]  # force the pixel data to load
    img.file_format = "WEBP"
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "WEBP"
    scene.render.image_settings.quality = 85
    img.save_render(argv[1], scene=scene)
    print("WROTE", argv[1])
