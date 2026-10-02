#!/usr/bin/env python3
"""Teaches the Scrypted ONNX plugin (@scrypted/onnx) to use LOCAL detector models.

What it changes in <plugin>/zip/unzipped/ort/__init__.py (3 small edits, idempotent, original kept as __init__.py.orig):
  1. availableModels += every folder <plugin volume>/files/local-models/<name>/ that holds a model.onnx
     (they then show up in the plugin's "Model" dropdown),
  2. when the selected model is one of those folders, load <folder>/model.onnx instead of downloading from Hugging Face.
Class names come from the ONNX file's own `names` metadata, exactly like the stock models, so person/vehicle/animal
mapping in the NVR keeps working. Nothing else in the plugin is touched.

A plugin UPDATE replaces unzipped/ and drops this patch; the plugin then simply falls back to the stock "Default" model
(it resets unknown model names). Re-run this script afterwards.

usage: patch_onnx_local_models.py <path to ort/__init__.py> [--revert]
"""
import os
import shutil
import sys

MARK = "# kestrel: local detector models"

EDIT1_OLD = '''def parse_labels(names):'''
EDIT1_NEW = f'''{MARK} (1/2)
def _local_model_dir():
    return os.path.join(os.environ.get("SCRYPTED_PLUGIN_VOLUME", ""), "files", "local-models")


def _local_models():
    try:
        d = _local_model_dir()
        return sorted(n for n in os.listdir(d) if os.path.isfile(os.path.join(d, n, "model.onnx")))
    except OSError:
        return []


availableModels = availableModels + [m for m in _local_models() if m not in availableModels]


def parse_labels(names):'''

EDIT2_OLD = '''        model_path = self.downloadHuggingFaceModelLocalFallback(model)
        onnxfile = os.path.join(model_path, f"{model}.onnx")
'''
EDIT2_NEW = f'''        {MARK} (2/2)
        if model in _local_models():
            onnxfile = os.path.join(_local_model_dir(), model, "model.onnx")
        else:
            model_path = self.downloadHuggingFaceModelLocalFallback(model)
            onnxfile = os.path.join(model_path, f"{{model}}.onnx")
'''


def main():
    path = sys.argv[1]
    orig = path + ".orig"
    if "--revert" in sys.argv:
        if os.path.exists(orig):
            shutil.copyfile(orig, path)
            print("reverted", path)
        else:
            print("no .orig next to", path)
        return
    src = open(path).read()
    if MARK in src:
        print("already patched")
        return
    if EDIT1_OLD not in src or EDIT2_OLD not in src:
        sys.exit("plugin source changed: expected anchors not found, refusing to patch")
    if not os.path.exists(orig):
        shutil.copyfile(path, orig)
    src = src.replace(EDIT1_OLD, EDIT1_NEW, 1).replace(EDIT2_OLD, EDIT2_NEW, 1)
    compile(src, path, "exec")  # syntax check before writing
    open(path, "w").write(src)
    print("patched", path)


if __name__ == "__main__":
    main()
