"""Check the real OfflineAudioContext mix produced by verify.steps.mjs."""
import json
import subprocess
import sys
import numpy as np

path = sys.argv[1]
rate = 48000
samples = np.frombuffer(subprocess.check_output(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(rate), '-f', 'f32le', '-']), dtype=np.float32)
def rms(start, end):
    chunk = samples[round(start*rate):round(end*rate)].astype(float)
    return float(np.sqrt(np.mean(chunk*chunk)))

before, after = rms(3.2, 3.8), rms(4.2, 4.8)
left, right = rms(9.6, 9.9), rms(10.1, 10.4)
window = samples[round(15.1*rate):round(15.9*rate)]
frequency = float(np.argmax(abs(np.fft.rfft(window))) * rate / len(window))
result = { 'samples': len(samples), 'duration': len(samples)/rate,
    'animatedGainRatio': before/after, 'expectedGainRatio': 10**(12/20),
    'chunkBoundaryRmsBefore': left, 'chunkBoundaryRmsAfter': right,
    'speed2FrequencyHz': frequency,
    'silenceBeforeClip': rms(0, 2.9), 'silenceAfterClip': rms(5.1, 9), 'mutedTrackRms': rms(17, 19) }
assert len(samples) == 20*rate
assert abs(before/after - 10**(12/20)) < 0.02
assert abs(left-right) < 1e-6
assert frequency == 880
assert result['silenceBeforeClip'] == result['silenceAfterClip'] == result['mutedTrackRms'] == 0
print(json.dumps(result, indent=2))
