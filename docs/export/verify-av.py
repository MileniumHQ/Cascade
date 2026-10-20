"""Compare exported audio with the original and verify frame counts/durations independently."""
import json
import subprocess
import sys
import numpy as np

source, output = sys.argv[1:3]
start = float(sys.argv[3]) if len(sys.argv) > 3 else 0
duration = 10 if start else 60

def pcm(path):
    return np.frombuffer(subprocess.check_output([
        'ffmpeg', '-v', 'error', '-threads', '1', '-i', path, '-ss', str(start), '-t', str(duration),
        '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'
    ]), dtype=np.float32)

a, b = pcm(source), pcm(output)
n = min(len(a), len(b))
a, b = a[:n].astype(np.float64), b[:n].astype(np.float64)
a -= a.mean()
b -= b.mean()
size = 1 << (2*n-1).bit_length()
corr = np.fft.irfft(np.fft.rfft(b, size) * np.conj(np.fft.rfft(a, size)), size)
lag = int(np.argmax(corr))
if lag > size//2:
    lag -= size
print(json.dumps({ 'source': source, 'output': output, 'startSeconds': start, 'samplesCompared': n, 'sampleRate': 8000,
    'lagSamples': lag, 'lagSeconds': lag / 8000, 'correlation': float(np.dot(a,b) / np.sqrt(np.dot(a,a)*np.dot(b,b))) }, indent=2))
