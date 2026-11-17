# Mixamo FBX -> raw JSON, one Blender process for a whole batch.
# Run only through tools/mocap/run.mjs:
#   Blender --background --python tools/mocap/extract.py -- <job.json>
# job.json = [{"fbx": "/abs/clip.fbx", "out": "/abs/.cache/mocap/raw/<slug>.json"}, ...]
#
# OUTPUT CONVENTION (format "mocap-raw/2"; /2 added "landmarks"), the one phase 2 retargets from:
#   - metres; Y up; the character faces +Z at rest; right-handed (glTF). Character's left is +X.
#     Conversion from Blender world (Z up, Mixamo faces -Y): (x, y, z)_gltf = (x, z, -y)_blender.
#   - Every matrix / quaternion is in that WORLD (armature-object transform included), not
#     parent-relative. Quaternions are [x, y, z, w] (three.js / glTF order).
#   - Bone-local axes are Blender's: +Y runs head -> tail. So world tail = head + rotate(q, [0, len, 0]).
#     Phase 2 should use deltas (q_frame * q_rest^-1) or bone directions, which do not depend on that.
#   - Bone names have the "mixamorig:" / "mixamorigN:" prefix stripped. Fingers and leaf bones dropped.
#   - frames[i] = { "q": [[x,y,z,w] per bone], "p": [[x,y,z] head position per bone] } for every
#     integer frame of the action's range, in order. "hips" is p[0] (Hips is bone 0).
import bpy, json, re, sys, math, time
from mathutils import Matrix

KEEP = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
        'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
        'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
        'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
        'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase']
FORMAT = 'mocap-raw/2'  # bump when the output changes; run.mjs re-extracts any cached file of another format
PREFIX = re.compile(r'^mixamorig\d*[:_]?')
TO_GLTF = Matrix.Rotation(-math.pi / 2, 4, 'X')  # Blender Z-up -> glTF Y-up


def clean():
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.armatures, bpy.data.actions,
                 bpy.data.materials, bpy.data.images, bpy.data.textures):
        for d in list(coll):
            coll.remove(d)


def r(v, n=5):
    return [round(float(x), n) for x in v]


def qxyzw(q):
    return [round(q.x, 6), round(q.y, 6), round(q.z, 6), round(q.w, 6)]


def extract(fbx, out):
    clean()
    bpy.ops.import_scene.fbx(filepath=fbx)
    arm = next((o for o in bpy.context.scene.objects if o.type == 'ARMATURE'), None)
    if arm is None:
        raise RuntimeError('no armature in ' + fbx)
    by_short = {}
    for b in arm.data.bones:
        by_short.setdefault(PREFIX.sub('', b.name), b.name)
    missing = [k for k in KEEP if k not in by_short]
    if missing:
        raise RuntimeError('missing bones %s in %s' % (missing, fbx))
    names = [by_short[k] for k in KEEP]
    parents = []
    for k in KEEP:
        b = arm.data.bones[by_short[k]]
        p = b.parent
        while p is not None and PREFIX.sub('', p.name) not in KEEP:
            p = p.parent
        parents.append(KEEP.index(PREFIX.sub('', p.name)) if p is not None else -1)

    scene = bpy.context.scene
    fps = scene.render.fps / scene.render.fps_base
    act = arm.animation_data.action if arm.animation_data else None
    if act is None:
        raise RuntimeError('no action in ' + fbx)
    f0, f1 = int(round(act.frame_range[0])), int(round(act.frame_range[1]))

    W = TO_GLTF @ arm.matrix_world
    rest = []
    for k, n in zip(KEEP, names):
        b = arm.data.bones[n]
        m = W @ b.matrix_local
        loc, rot, scl = m.decompose()
        tail = W @ b.tail_local
        rest.append({'name': k, 'head': r(loc), 'tail': r(tail), 'q': qxyzw(rot),
                     'length': round((tail - loc).length, 5)})

    # extra rest landmarks (world head positions) for two-axis fits: palm (finger roots), head top, toe end
    landmarks = {}
    for k in ('LeftHandIndex1', 'LeftHandMiddle1', 'LeftHandPinky1', 'RightHandIndex1', 'RightHandMiddle1',
              'RightHandPinky1', 'HeadTop_End', 'LeftToe_End', 'RightToe_End'):
        if k in by_short:
            landmarks[k] = r(W @ arm.data.bones[by_short[k]].head_local)

    frames = []
    pbs =[arm.pose.bones[n] for n in names]
    for f in range(f0, f1 + 1):
        scene.frame_set(f)
        qs, ps = [], []
        for pb in pbs:
            loc, rot, scl = (W @ pb.matrix).decompose()
            qs.append(qxyzw(rot))
            ps.append(r(loc))
        frames.append({'q': qs, 'p': ps})

    data = {'format': FORMAT, 'landmarks': landmarks,
            'convention': 'metres, Y up, faces +Z at rest, right-handed (glTF); world-space; quats xyzw; bone +Y = head->tail',
            'source': fbx, 'fps': fps, 'frameStart': f0, 'frameCount': len(frames),
            'bones': KEEP, 'parents': parents, 'rest': rest, 'frames': frames}
    with open(out, 'w') as fh:
        json.dump(data, fh, separators=(',', ':'))
    hips = rest[0]['head']
    print('MOCAP_OK %s frames=%d fps=%g restHipY=%.3f restLeftArmX=%.3f' % (
        out.split('/')[-1], len(frames), fps, hips[1], rest[KEEP.index('LeftArm')]['head'][0]))


def main():
    job = json.load(open(sys.argv[sys.argv.index('--') + 1]))
    fails = 0
    t = time.time()
    for item in job:
        try:
            extract(item['fbx'], item['out'])
        except Exception as e:  # keep going; run.mjs reports
            fails += 1
            print('MOCAP_FAIL %s %s' % (item['fbx'], e))
    print('MOCAP_DONE %d ok, %d failed, %.1fs' % (len(job) - fails, fails, time.time() - t))


main()
