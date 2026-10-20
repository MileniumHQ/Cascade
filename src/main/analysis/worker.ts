// Native model inference and pitch tracking live off the Electron main thread. Terminating the worker cancels work.
import { parentPort } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { EVENT_DIR } from './models'
import { pitchTrack } from './logic'
interface Stream { acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void }
interface Tagger { createStream(): Stream; compute(stream: Stream, topK: number): { name: string; prob: number }[] }
interface Sherpa { AudioTagging: new (config: unknown) => Tagger }
let tagger: Tagger | undefined
parentPort!.on('message', (message: { kind: 'init' | 'events' | 'pitch'; part?: string; modelsDir?: string; samples?: Float32Array; spans?: [number, number][] }) => {
  try {
    if (message.kind === 'init') {
      if (message.part === 'events') {
        const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as Sherpa
        const root = message.modelsDir!
        tagger = new sherpa.AudioTagging({ model: { ced: join(root, EVENT_DIR, 'model.int8.onnx'), numThreads: 4, provider: 'cpu', debug: 0 }, labels: join(root, EVENT_DIR, 'class_labels_indices.csv'), topK: 527 })
      }
      parentPort!.postMessage({ result: true }); return
    }
    if (message.kind === 'pitch') { parentPort!.postMessage({ result: pitchTrack(message.samples!, message.spans) }); return }
    const stream = tagger!.createStream(); stream.acceptWaveform({ sampleRate: 16000, samples: message.samples! })
    parentPort!.postMessage({ result: tagger!.compute(stream, 527) })
  } catch (error) { parentPort!.postMessage({ error: String(error) }) }
})
