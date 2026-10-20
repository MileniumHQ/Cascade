// Native model inference lives off the Electron main thread. Terminating the worker cancels a decode.
import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ToneLabel } from '../../shared/analysis'
import { EVENT_DIR, TONE_DIR } from './models'
interface Stream { acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void }
interface Tagger { createStream(): Stream; compute(stream: Stream, topK: number): { name: string; prob: number }[] }
interface Recognizer { createStream(): Stream; decode(stream: Stream): void; getResult(stream: Stream): { emotion?: string; event?: string } }
interface Sherpa { AudioTagging: new (config: unknown) => Tagger; OfflineRecognizer: new (config: unknown) => Recognizer }
let tagger: Tagger | undefined, recognizer: Recognizer | undefined
const tones = new Set<ToneLabel>(['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'])
parentPort!.on('message', (message: { kind: 'init' | 'events' | 'tone'; part?: string; modelsDir?: string; samples?: Float32Array; alternate?: Float32Array; language?: string }) => {
  try {
    if (message.kind === 'init') {
      const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as Sherpa
      const root = message.modelsDir!
      if (message.part === 'events') tagger = new sherpa.AudioTagging({ model: { ced: join(root, EVENT_DIR, 'model.int8.onnx'), numThreads: 4, provider: 'cpu', debug: 0 }, labels: join(root, EVENT_DIR, 'class_labels_indices.csv'), topK: 527 })
      else recognizer = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: {
        senseVoice: { model: join(root, TONE_DIR, 'model.int8.onnx'), useInverseTextNormalization: 0, language: message.language === 'auto' ? '' : message.language },
        tokens: join(root, TONE_DIR, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0 } })
      parentPort!.postMessage({ result: true }); return
    }
    if (message.kind === 'events') {
      const stream = tagger!.createStream(); stream.acceptWaveform({ sampleRate: 16000, samples: message.samples! })
      parentPort!.postMessage({ result: tagger!.compute(stream, 527) }); return
    }
    const decode = (samples: Float32Array) => {
      const stream = recognizer!.createStream(); stream.acceptWaveform({ sampleRate: 16000, samples }); recognizer!.decode(stream)
      const raw = recognizer!.getResult(stream).emotion?.replace(/<\||\|>/g, '').toLowerCase()
      return raw && tones.has(raw as ToneLabel) ? raw as ToneLabel : undefined
    }
    const label = decode(message.samples!)
    // No posterior is available. Agreement is a stability check, not a calibrated probability.
    const stable = label === 'neutral' || label && message.alternate && decode(message.alternate) === label
    parentPort!.postMessage({ result: stable ? { label, confidence: label === 'neutral' ? .5 : .65 } : null })
  } catch (error) { parentPort!.postMessage({ error: String(error) }) }
})
