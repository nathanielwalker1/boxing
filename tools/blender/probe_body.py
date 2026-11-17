import sys, os
import bpy, addon_utils

mod = "bl_ext.user_default.mpfb"
try:
    addon_utils.enable(mod, default_set=False, persistent=False)
except Exception as e:
    print("ENABLE FAIL", e)
print("enabled:", mod in sys.modules)

from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

macro = TargetService.get_default_macro_info_dict()
macro.update({"gender": 1.0, "age": 0.5, "muscle": 0.68, "weight": 0.42, "proportions": 0.85, "height": 0.6})
macro["race"] = {"asian": 0.0, "caucasian": 1.0, "african": 0.0}
base = HumanService.create_human(macro_detail_dict=macro)
print("basemesh", base.name, len(base.data.vertices), len(base.data.polygons))
print("dims", tuple(base.dimensions))
print("fullpath", TargetService.target_full_path("torso/torso-vshape-incr"))
print("fullpath2", TargetService.target_full_path("torso-vshape-incr"))
rig = HumanService.add_builtin_rig(base, "mixamo")
print("rig", rig.name, len(rig.data.bones))
for b in rig.data.bones:
    if b.parent is None:
        print("root", b.name)
print("vgroups", len(base.vertex_groups), [g.name for g in base.vertex_groups][:12])
