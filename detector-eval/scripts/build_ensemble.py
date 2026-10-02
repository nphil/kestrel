#!/usr/bin/env python3
"""Fuses several detectors into ONE ONNX file the Scrypted ONNX plugin loads like any other model.

The plugin (parse_yolov9) wants a single input and an output [1, 4+nc, N] with box centre/size in INPUT pixels and
sigmoid class scores. This builds that from a list of branches:

  python scripts/build_ensemble.py --out models/kestrel_ensemble_640 --size 640 \
      --branch scrypted_yolov9c_relu_test:person=1,vehicle=1,animal=1 \
      --branch mdv6_yolov9c_640:animal=1.0

Each branch is `<model dir name>:<unified class>=<score gain>,...` (unified classes: person, vehicle, animal; a class that
is not listed is switched off for that branch). A branch whose input size differs from --size gets the image resized
inside the graph (AveragePool for exact 2x, Resize otherwise) and its boxes scaled back, so a 640 plugin input feeds
a 320 model too. Scores are multiplied by the gain and clipped to 1 (a monotone recalibration so one NVR threshold
suits all branches). Output tensor order is fixed: 0 person, 1 vehicle, 2 animal; ONNX metadata names/stride are written.
For COCO-style branches (several animal classes) list nothing special: meta.json `nvr_class` maps class ids to unified
classes and the branch takes the max over the ids of each unified class.
"""
import argparse, json, os, sys
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto, version_converter, compose

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
UNIFIED = ['person', 'vehicle', 'animal']


def load_branch(spec, size):
    name, _, gains = spec.partition(':')
    d = f'{ROOT}/models/{name}'
    meta = json.load(open(f'{d}/meta.json'))
    m = onnx.load(f'{d}/model.onnx')
    gain = {}
    for kv in gains.split(','):
        if kv:
            k, _, v = kv.partition('=')
            gain[k] = float(v or 1)
    return name, meta, m, gain


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--size', type=int, default=640)
    ap.add_argument('--branch', action='append', required=True)
    ap.add_argument('--opset', type=int, default=18)
    a = ap.parse_args()
    S = a.size
    nodes, inits, outs = [], [], []
    inp = helper.make_tensor_value_info('images', TensorProto.FLOAT, [1, 3, S, S])
    branch_outs = []
    total_n = 0
    for bi, spec in enumerate(a.branch):
        name, meta, m, gain = load_branch(spec, S)
        if m.opset_import[0].version != a.opset:
            m = version_converter.convert_version(m, a.opset)
        m = compose.add_prefix(m, f'b{bi}_')
        g = m.graph
        in_name = g.input[0].name
        out_name = g.output[0].name
        bs = int(meta['input']['w'])
        # input adaptation
        if bs == S:
            nodes.append(helper.make_node('Identity', ['images'], [in_name]))
        elif S % bs == 0 and S // bs == 2:
            nodes.append(helper.make_node('AveragePool', ['images'], [in_name], kernel_shape=[2, 2], strides=[2, 2]))
        else:
            scales = np.array([1, 1, bs / S, bs / S], dtype=np.float32)
            inits.append(numpy_helper.from_array(scales, f'b{bi}_rs_scales'))
            nodes.append(helper.make_node('Resize', ['images', '', f'b{bi}_rs_scales'], [in_name], mode='linear',
                                          coordinate_transformation_mode='half_pixel'))
        nodes += list(g.node)
        inits += list(g.initializer)
        nc = len(meta['classes'])
        # per-unified-class row selection: max over the branch's class ids that map to it
        nvr = {int(k): v for k, v in (meta.get('nvr_class') or {}).items()}
        if not nvr:
            nvr = {int(k): v for k, v in meta['classes'].items()}  # names are already person/vehicle/animal
        box = f'b{bi}_box'
        inits.append(numpy_helper.from_array(np.array([0], np.int64), f'b{bi}_s0'))
        inits.append(numpy_helper.from_array(np.array([4], np.int64), f'b{bi}_e4'))
        inits.append(numpy_helper.from_array(np.array([1], np.int64), f'b{bi}_ax1'))
        nodes.append(helper.make_node('Slice', [out_name, f'b{bi}_s0', f'b{bi}_e4', f'b{bi}_ax1'], [box + '_raw']))
        sc = np.array([S / bs] * 4, np.float32).reshape(1, 4, 1)
        inits.append(numpy_helper.from_array(sc, f'b{bi}_boxscale'))
        nodes.append(helper.make_node('Mul', [box + '_raw', f'b{bi}_boxscale'], [box]))
        rows = [None, None, None]
        for ui, uname in enumerate(UNIFIED):
            ids = [k for k, v in nvr.items() if v == uname]
            g_ = gain.get(uname, 0.0)
            if not ids or g_ == 0.0:
                continue  # switched off for this branch
            inits.append(numpy_helper.from_array(np.array([4 + i for i in ids], np.int64), f'b{bi}_idx{ui}'))
            nodes.append(helper.make_node('Gather', [out_name, f'b{bi}_idx{ui}'], [f'b{bi}_g{ui}'], axis=1))
            cur = f'b{bi}_g{ui}'
            if len(ids) > 1:  # several raw classes -> one unified class: max over them
                inits.append(numpy_helper.from_array(np.array([1], np.int64), f'b{bi}_rax{ui}'))
                nodes.append(helper.make_node('ReduceMax', [cur, f'b{bi}_rax{ui}'], [f'b{bi}_m{ui}'], keepdims=1))
                cur = f'b{bi}_m{ui}'
            if g_ != 1.0:
                inits.append(numpy_helper.from_array(np.array([g_], np.float32).reshape(1, 1, 1), f'b{bi}_gain{ui}'))
                nodes.append(helper.make_node('Mul', [cur, f'b{bi}_gain{ui}'], [f'b{bi}_s{ui}']))
                inits.append(numpy_helper.from_array(np.array(0.0, np.float32), f'b{bi}_clipmin{ui}'))
                inits.append(numpy_helper.from_array(np.array(1.0, np.float32), f'b{bi}_clipmax{ui}'))
                nodes.append(helper.make_node('Clip', [f'b{bi}_s{ui}', f'b{bi}_clipmin{ui}', f'b{bi}_clipmax{ui}'], [f'b{bi}_c{ui}']))
                cur = f'b{bi}_c{ui}'
            rows[ui] = cur
        real = next(r for r in rows if r)
        final_rows = []
        for ui, r in enumerate(rows):
            if r is None:  # a switched-off class is a zero row (real row x 0 keeps the [1,1,N] shape)
                inits.append(numpy_helper.from_array(np.array(0.0, np.float32).reshape(1, 1, 1), f'b{bi}_zk{ui}'))
                nodes.append(helper.make_node('Mul', [real, f'b{bi}_zk{ui}'], [f'b{bi}_zr{ui}']))
                final_rows.append(f'b{bi}_zr{ui}')
            else:
                final_rows.append(r)
        nodes.append(helper.make_node('Concat', [box] + final_rows, [f'b{bi}_out'], axis=1))
        branch_outs.append(f'b{bi}_out')
    nodes = [n for n in nodes if n is not None]
    nodes.append(helper.make_node('Concat', branch_outs, ['output0'], axis=2))
    graph = helper.make_graph(nodes, 'kestrel_ensemble', [inp], [helper.make_tensor_value_info('output0', TensorProto.FLOAT, [1, 7, None])], inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', a.opset)])
    model.ir_version = 9
    for k, v in (('names', "{0: 'person', 1: 'vehicle', 2: 'animal'}"), ('stride', '32')):
        p = model.metadata_props.add(); p.key, p.value = k, v
    onnx.checker.check_model(model)
    out = f'{ROOT}/{a.out}' if not os.path.isabs(a.out) else a.out
    os.makedirs(out, exist_ok=True)
    onnx.save(model, f'{out}/model.onnx')
    meta = {'name': os.path.basename(out), 'family': 'kestrel-ensemble', 'input': {'w': S, 'h': S, 'layout': 'NCHW', 'range': '0-1', 'color': 'RGB', 'name': 'images'},
            'output': {'format': 'yolov8_raw', 'note': 'fused: ' + ' + '.join(a.branch)}, 'classes': {'0': 'person', '1': 'vehicle', '2': 'animal'},
            'animal_classes': [2], 'person_classes': [0], 'vehicle_classes': [1], 'nvr_class': {'0': 'person', '1': 'vehicle', '2': 'animal'},
            'branches': a.branch}
    json.dump(meta, open(f'{out}/meta.json', 'w'), indent=1)
    print('wrote', out, os.path.getsize(f'{out}/model.onnx') // 1e6, 'MB')


if __name__ == '__main__':
    main()
