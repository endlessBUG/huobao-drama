# -*- coding: utf-8 -*-
"""全片关键帧 QA 扫描：逐镜首/尾帧调用平台 /frames/qa，不合格的清空该帧，
打印需要重出的 storyboard id（随后跑 .gen_frames_v2.py <ids> 重出，带 QA 重试）。"""
import json, sqlite3, urllib.request, os
ROOT = r'E:/pycharm/huobao-drama'; DB = ROOT + '/data/huobao.sqlite3'
API = 'http://127.0.0.1:5679/api/v1'
EP = int(os.environ.get('HUOBAO_EP_ID', '120'))

def qa(sid, ft):
    body = json.dumps({'storyboard_id': sid, 'frame_type': ft}).encode()
    req = urllib.request.Request(API + '/frames/qa', data=body,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    return json.loads(urllib.request.urlopen(req, timeout=300).read()).get('data') or {}

db = sqlite3.connect(DB)
rows = db.execute('select id,storyboard_number,title,continuity from storyboards where episode_id=? order by storyboard_number', (EP,)).fetchall()
bad = []
prev_last = None
for sid, num, title, cont in rows:
    first, last = db.execute('select first_frame_image,last_frame_image from storyboards where id=?', (sid,)).fetchone()
    for ft, col in (('first_frame', 'first_frame_image'), ('last_frame', 'last_frame_image')):
        # 1122 用户：续镜首帧=上一镜尾帧拷贝，不用重复检查
        if ft == 'first_frame' and first and prev_last and first == prev_last:
            print(num, title, 'first inherited -> skip')
            continue
        try:
            v = qa(sid, ft)
        except Exception as e:
            print(num, ft, 'QA ERROR', str(e)[:120]); continue
        if not v.get('ok'):
            issues = (v.get('llm') or {}).get('issues') or (v.get('detector') or {}).get('issues') or []
            print(num, title, ft, 'FAIL', json.dumps(issues, ensure_ascii=False)[:200])
            db.execute('update storyboards set %s=NULL where id=?' % col, (sid,))
            db.commit()
            if sid not in bad:
                bad.append(sid)
    prev_last = last
print('BAD_IDS', ' '.join(map(str, bad)))
