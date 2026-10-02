"""Flatten the NVR per-minute event JSON (copied to data/nvr_events/scrypted-<cam>.events) into
data/nvr_events/parsed_<cam>.json: {"objects":[{t,cls,score,box,id,zones,moving,first,last,ts}], "motion":[{t,on}]}.
Copy first:  ssh unraid "docker exec scrypted tar cf - -C /NVR scrypted-<cam>.events" | tar xf - -C data/nvr_events"""
import json, glob, sys, os
base = os.path.join(os.path.dirname(__file__), '..', 'data', 'nvr_events')
for c in sys.argv[1:] or ['88', '103', '104']:
    objs, mot = [], []
    for f in glob.glob(f'{base}/scrypted-{c}.events/*/*/*.json'):
        try: d = json.load(open(f))
        except Exception: continue
        for e in d.get('recordedEvents', []):
            det = e['details']
            if det['eventInterface'] == 'ObjectDetector':
                for x in e['data'].get('detections', []):
                    if x['className'] == 'motion': continue
                    objs.append({'t': det['eventTime'], 'ts': e['data'].get('timestamp'), 'cls': x['className'], 'score': x.get('score'),
                                 'box': x.get('boundingBox'), 'id': x.get('id'), 'zones': x.get('zones'),
                                 'moving': (x.get('movement') or {}).get('moving'),
                                 'first': (x.get('history') or {}).get('firstSeen'), 'last': (x.get('history') or {}).get('lastSeen'),
                                 'clipped': x.get('clipped')})
            elif det['eventInterface'] == 'MotionSensor':
                mot.append({'t': det['eventTime'], 'on': bool(e['data'])})
    objs.sort(key=lambda x: x['t']); mot.sort(key=lambda x: x['t'])
    json.dump({'objects': objs, 'motion': mot}, open(f'{base}/parsed_{c}.json', 'w'))
    print(c, len(objs), 'object dets', len(mot), 'motion toggles')
