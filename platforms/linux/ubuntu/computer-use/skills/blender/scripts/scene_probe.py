#!/usr/bin/env python3
"""Write a read-only JSON inventory of the scene loaded by Blender.

Run this with Blender's --python option. System Python is not expected to
provide bpy.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path
import sys

import bpy


def script_arguments() -> list[str]:
    if "--" not in sys.argv:
        return []
    return sys.argv[sys.argv.index("--") + 1 :]


def finite_number(value: float) -> float | str:
    number = float(value)
    return number if math.isfinite(number) else str(number)


def vector(values: object) -> list[float | str]:
    return [finite_number(value) for value in values]


def resolved_path(value: str, library: object = None) -> str:
    if not value:
        return ""
    return os.path.abspath(bpy.path.abspath(value, library=library))


def image_record(image: object) -> dict[str, object]:
    packed = bool(getattr(image, "packed_file", None)) or bool(
        getattr(image, "packed_files", ())
    )
    path = resolved_path(image.filepath, image.library) if image.filepath else ""
    if packed:
        external_status = "packed"
    elif image.source in {"GENERATED", "VIEWER"}:
        external_status = "internal"
    elif not path:
        external_status = "no-path"
    elif any(token in path for token in ("<UDIM>", "####")):
        external_status = "pattern-unchecked"
    else:
        external_status = "present" if os.path.exists(path) else "missing"
    return {
        "name": image.name,
        "source": image.source,
        "filepath": image.filepath,
        "resolved_path": path,
        "external_status": external_status,
        "packed": packed,
        "size": list(image.size),
    }


def object_record(obj: object) -> dict[str, object]:
    record: dict[str, object] = {
        "name": obj.name,
        "type": obj.type,
        "data_name": obj.data.name if obj.data else None,
        "parent": obj.parent.name if obj.parent else None,
        "collections": sorted(collection.name for collection in obj.users_collection),
        "location": vector(obj.location),
        "rotation_mode": obj.rotation_mode,
        "rotation_euler": vector(obj.rotation_euler),
        "rotation_quaternion": vector(obj.rotation_quaternion),
        "rotation_axis_angle": vector(obj.rotation_axis_angle),
        "scale": vector(obj.scale),
        "dimensions": vector(obj.dimensions),
        "matrix_world": [vector(row) for row in obj.matrix_world],
        "hidden_viewport": bool(obj.hide_viewport),
        "hidden_render": bool(obj.hide_render),
        "material_slots": [
            slot.material.name if slot.material else None for slot in obj.material_slots
        ],
        "action": (
            obj.animation_data.action.name
            if obj.animation_data and obj.animation_data.action
            else None
        ),
    }
    if obj.type == "MESH":
        record["mesh"] = {
            "vertices": len(obj.data.vertices),
            "edges": len(obj.data.edges),
            "polygons": len(obj.data.polygons),
            "uv_layers": [layer.name for layer in obj.data.uv_layers],
            "shape_keys": (
                [block.name for block in obj.data.shape_keys.key_blocks]
                if obj.data.shape_keys
                else []
            ),
        }
    elif obj.type == "ARMATURE":
        record["armature"] = {"bones": len(obj.data.bones)}
    elif obj.type == "CAMERA":
        record["camera"] = {
            "projection": obj.data.type,
            "lens": finite_number(obj.data.lens),
            "clip_start": finite_number(obj.data.clip_start),
            "clip_end": finite_number(obj.data.clip_end),
        }
    elif obj.type == "LIGHT":
        record["light"] = {
            "type": obj.data.type,
            "energy": finite_number(obj.data.energy),
            "color": vector(obj.data.color),
        }
    return record


def scene_record(scene: object) -> dict[str, object]:
    return {
        "name": scene.name,
        "camera": scene.camera.name if scene.camera else None,
        "frame_start": scene.frame_start,
        "frame_end": scene.frame_end,
        "frame_current": scene.frame_current,
        "render_engine": scene.render.engine,
        "resolution": [
            scene.render.resolution_x,
            scene.render.resolution_y,
            scene.render.resolution_percentage,
        ],
        "unit_system": scene.unit_settings.system,
        "unit_scale_length": finite_number(scene.unit_settings.scale_length),
        "objects": sorted(obj.name for obj in scene.objects),
    }


def build_report() -> dict[str, object]:
    objects = sorted(bpy.data.objects, key=lambda item: item.name)
    images = [image_record(image) for image in sorted(bpy.data.images, key=lambda i: i.name)]
    libraries = []
    for library in sorted(bpy.data.libraries, key=lambda item: item.name):
        path = resolved_path(library.filepath)
        libraries.append(
            {
                "name": library.name,
                "filepath": library.filepath,
                "resolved_path": path,
                "external_status": "present" if os.path.exists(path) else "missing",
            }
        )

    warnings = []
    missing_images = [
        image["name"] for image in images if image["external_status"] == "missing"
    ]
    missing_libraries = [
        library["name"]
        for library in libraries
        if library["external_status"] == "missing"
    ]
    non_unit_scale = [
        obj.name
        for obj in objects
        if any(abs(float(component) - 1.0) > 1e-6 for component in obj.scale)
    ]
    negative_determinant = [
        obj.name
        for obj in objects
        if obj.matrix_world.to_3x3().determinant() < 0.0
    ]
    scenes_without_active_camera = [
        scene.name
        for scene in bpy.data.scenes
        if scene.camera is None and any(obj.type == "CAMERA" for obj in scene.objects)
    ]
    if not bpy.data.filepath:
        warnings.append("The loaded Blender data has no source filepath.")
    if missing_images:
        warnings.append("Missing external images: " + ", ".join(missing_images))
    if missing_libraries:
        warnings.append("Missing linked libraries: " + ", ".join(missing_libraries))
    if scenes_without_active_camera:
        warnings.append(
            "Scenes contain camera objects but have no active camera: "
            + ", ".join(scenes_without_active_camera)
        )

    return {
        "schema_version": "1",
        "blender": {
            "version": bpy.app.version_string,
            "version_tuple": list(bpy.app.version),
            "background": bool(bpy.app.background),
        },
        "source": {
            "filepath": bpy.data.filepath,
            "resolved_path": os.path.abspath(bpy.data.filepath)
            if bpy.data.filepath
            else "",
        },
        "counts": {
            "scenes": len(bpy.data.scenes),
            "objects": len(objects),
            "object_types": dict(sorted(Counter(obj.type for obj in objects).items())),
            "collections": len(bpy.data.collections),
            "meshes": len(bpy.data.meshes),
            "materials": len(bpy.data.materials),
            "images": len(bpy.data.images),
            "actions": len(bpy.data.actions),
            "libraries": len(bpy.data.libraries),
        },
        "scenes": [
            scene_record(scene) for scene in sorted(bpy.data.scenes, key=lambda s: s.name)
        ],
        "objects": [object_record(obj) for obj in objects],
        "collections": sorted(collection.name for collection in bpy.data.collections),
        "materials": sorted(material.name for material in bpy.data.materials),
        "actions": sorted(action.name for action in bpy.data.actions),
        "images": images,
        "libraries": libraries,
        "observations": {
            "objects_with_non_unit_scale": non_unit_scale,
            "objects_with_negative_world_determinant": negative_determinant,
            "scenes_with_camera_objects_but_no_active_camera": (
                scenes_without_active_camera
            ),
        },
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="New JSON output path")
    args = parser.parse_args(script_arguments())

    output = Path(args.output).expanduser().resolve()
    if output.suffix.lower() != ".json":
        raise ValueError("--output must end in .json")
    if not output.parent.is_dir():
        raise FileNotFoundError(f"output parent does not exist: {output.parent}")
    if output.exists():
        raise FileExistsError(f"refusing to overwrite existing report: {output}")
    if bpy.data.filepath and output == Path(bpy.data.filepath).resolve():
        raise ValueError("report output cannot be the source .blend")

    temporary = output.with_name(f".{output.name}.tmp-{os.getpid()}")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(build_report(), handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()
    print(f"SCENE_PROBE_OUTPUT={output}")


if __name__ == "__main__":
    main()
