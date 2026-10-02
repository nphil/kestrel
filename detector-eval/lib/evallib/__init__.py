"""Evaluation harness for Kestrel's first-stage animal detector (see detector-eval/RESULTS.md).

evallib re-implements, from the installed Scrypted NVR plugin code, the part of its detection pipeline that
decides WHICH pixels the detector is shown (motion boxes -> filters -> crops), so that detector candidates can be
compared under the same conditions the live system gives them. Nothing here talks to Scrypted at run time.
"""
