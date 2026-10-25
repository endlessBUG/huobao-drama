"""RTX VSR video upscaler (nvidia-vfx hardware engine, no ComfyUI involvement).

Provenance: 1021 probe script C:/tmp/vsr2x.py, validated in docs/comfyui-h3-configs.md
(arm12/17/20 x2 samples: fidelity preserved, no invented structure) and 1025 on a real
294-frame production clip: 29.1 s = 0.10 s/frame for 1024x768 -> 2048x1536, YAVG -0.32%.

Usage: python vsr2x.py <in.mp4> <out.mp4> [scale=2] [quality=ULTRA]
Env:   VSR_GPU (CUDA_VISIBLE_DEVICES, default 1 = the idle 4060 on this box)
       VSR_FFMPEG (path to ffmpeg; default = repo node_modules/ffmpeg-static)
"""
import os
import re
import subprocess
import sys
import tempfile
import time

os.environ.setdefault('CUDA_VISIBLE_DEVICES', os.environ.get('VSR_GPU', '1'))
import torch
import nvvfx

src, dst = sys.argv[1], sys.argv[2]
scale = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
qname = (sys.argv[4] if len(sys.argv) > 4 else 'ULTRA').upper()
QM = {'LOW': nvvfx.effects.QualityLevel.LOW, 'MEDIUM': nvvfx.effects.QualityLevel.MEDIUM,
      'HIGH': nvvfx.effects.QualityLevel.HIGH, 'ULTRA': nvvfx.effects.QualityLevel.ULTRA}
quality = QM.get(qname, nvvfx.effects.QualityLevel.ULTRA)

FF = os.environ.get('VSR_FFMPEG') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'node_modules', 'ffmpeg-static',
    'ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')

r = subprocess.run([FF, '-hide_banner', '-i', src, '-map', '0:v:0', '-f', 'null', '-'],
                   capture_output=True, text=True)
line = [x for x in r.stderr.split('\n') if 'Video:' in x][-1]
mm = re.search(r'(\d{3,4})x(\d{3,4})', line)
W, H = int(mm.group(1)), int(mm.group(2))
fpsm = re.search(r'(\d+(?:\.\d+)?) fps', line)
FPS = float(fpsm.group(1)) if fpsm else 24.0
ow, oh = max(8, round(W * scale / 8) * 8), max(8, round(H * scale / 8) * 8)
print(f'{src}: {W}x{H} @{FPS} fps -> {ow}x{oh} quality={qname}', flush=True)

tmp_out = os.path.join(tempfile.gettempdir(), f'vsr_{os.getpid()}_{int(time.time())}.mp4')
dec = subprocess.Popen([FF, '-hide_banner', '-loglevel', 'error', '-i', src, '-map', '0:v:0',
                        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                       stdout=subprocess.PIPE, stdin=subprocess.DEVNULL)
enc = subprocess.Popen([FF, '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo',
                        '-pix_fmt', 'rgb24', '-s', f'{ow}x{oh}', '-r', str(FPS), '-i', '-',
                        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
                        '-pix_fmt', 'yuv420p', '-f', 'mp4', '-y', tmp_out],
                       stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
n = 0
t0 = time.time()
with nvvfx.VideoSuperRes(quality) as sr:
    sr.output_width, sr.output_height = ow, oh
    sr.load()
    while True:
        buf = dec.stdout.read(W * H * 3)
        if not buf or len(buf) < W * H * 3:
            break
        f = torch.frombuffer(bytearray(buf), dtype=torch.uint8).view(H, W, 3) \
            .permute(2, 0, 1).float().div(255.0).cuda().contiguous()
        up = torch.from_dlpack(sr.run(f).image).clone()
        enc.stdin.write(up.movedim(0, -1).mul(255.0).clamp(0, 255)
                        .to(torch.uint8).cpu().numpy().tobytes())
        n += 1
        if n % 100 == 0:
            print(f'  {n} frames | {time.time()-t0:.1f} s | {(time.time()-t0)/n:.2f} s/frame', flush=True)
dec.stdout.close()
enc.stdin.close()
er = enc.stderr.read().decode('utf8', 'replace')
enc.wait()
print(f'{n} frames, {time.time()-t0:.1f} s = {(time.time()-t0)/max(1,n):.2f} s/frame', flush=True)
if er.strip():
    print('encode stderr:', er[:300], flush=True)
# keep the source audio track (generated clips carry audio; VSR only touches video)
subprocess.run([FF, '-hide_banner', '-loglevel', 'error', '-i', tmp_out, '-i', src,
                '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'copy', '-c:a', 'copy',
                '-y', dst], check=True)
os.remove(tmp_out)
print('wrote', dst, os.path.getsize(dst), 'bytes', flush=True)
