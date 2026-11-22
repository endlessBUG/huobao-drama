# -*- coding: utf-8 -*-
"""关键帧检查（本机人脸 AI）：检测画面里出现的脸，和该镜角色的参考图比对。
1122 修订（用户「自检有没有问题」）：
  - missing 不再只看相似度：**只有「人脸数 < 应到角色数」才判 fail**；相似度低记 warn
  - extra 规则保留，expected 为空时检出人脸也算 warn（不再静默放过）
  - duplicate：画面内两张脸相似度 >= 0.5 判 fail
  - ok = 没有 fail 级 issue（warn 不影响放行）
用法: python -X utf8 .qa_frame.py <frame_image> <expected_json>
expected_json: [{"name":"苏晚","ref":"static/images/xxx.png"}, ...]
输出 JSON: {"ok": bool, "faces": n, "issues": [...], "matches": [...]}
"""
import sys, json, os
import numpy as np
import cv2
from insightface.app import FaceAnalysis

ROOT = r'E:/pycharm/huobao-drama'

def load(path):
    p = path if os.path.isabs(path) else os.path.join(ROOT, 'data', path.replace('/', os.sep))
    im = cv2.imread(p)
    if im is None:
        raise SystemExit('cannot read ' + p)
    return im

def emb(app, im):
    faces = app.get(im)
    return [(f.normed_embedding, f.bbox) for f in faces]

def cos(a, b):
    return float(np.dot(a, b))

def main():
    frame_path = sys.argv[1]
    expected = json.load(open(sys.argv[2], encoding='utf-8')) if len(sys.argv) > 2 else []
    app = FaceAnalysis(name='buffalo_l', providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
    app.prepare(ctx_id=0, det_size=(640, 640))
    faces = emb(app, load(frame_path))
    issues = []
    n_faces = len(faces)
    n_exp = len(expected)

    # 同画面重复人物
    for i in range(n_faces):
        for j in range(i + 1, n_faces):
            s = cos(faces[i][0], faces[j][0])
            if s >= 0.5:
                issues.append({'type': 'duplicate', 'severity': 'fail', 'sim': round(s, 3), 'faces': [i, j]})

    # 与参考图比对
    matches = []
    for e in expected:
        ref = e.get('ref') or ''
        if not ref or not os.path.exists(os.path.join(ROOT, 'data', ref.replace('/', os.sep))):
            continue
        ref_faces = emb(app, load(ref))
        best = 0.0
        for re_, _ in ref_faces:
            for fe, _ in faces:
                best = max(best, cos(re_, fe))
        matches.append({'name': e.get('name'), 'sim': round(best, 3)})
        if best < 0.35:
            # 人数够就只警告（侧脸/遮挡会掉相似度），人不够才判缺人
            sev = 'fail' if n_faces < n_exp else 'warn'
            issues.append({'type': 'missing' if sev == 'fail' else 'low_similarity',
                           'severity': sev, 'name': e.get('name'), 'sim': round(best, 3)})

    if n_faces > n_exp:
        issues.append({'type': 'extra', 'severity': 'fail', 'faces': n_faces, 'expected': n_exp})
    elif n_exp == 0 and n_faces > 0:
        issues.append({'type': 'extra', 'severity': 'warn', 'faces': n_faces, 'expected': 0})

    ok = not any(i.get('severity') == 'fail' for i in issues)
    print(json.dumps({'ok': ok, 'faces': n_faces, 'issues': issues, 'matches': matches}, ensure_ascii=False))

if __name__ == '__main__':
    main()
