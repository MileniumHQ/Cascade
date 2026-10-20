import type { AnalysisPart } from '../../shared/analysis'
import type { ModelDownload } from '../model-download'
export const EVENT_DIR = 'sherpa-onnx-ced-mini-audio-tagging-2024-04-19'
export const MODELS: (ModelDownload & { part: AnalysisPart; directory: string; files: string[]; fileSizes: number[]; notice: string })[] = [
  { part: 'events', id: EVENT_DIR, directory: EVENT_DIR, name: 'CED-Mini int8 (Apache-2.0 weights)', sizeBytes: 47658399,
    sha256: 'bec8bfa0af2c20ec3a9e7c6dd6c92d0fb6e96d6b25370ebe7a48e7283a60a02c',
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/${EVENT_DIR}.tar.bz2`, files: ['model.int8.onnx', 'class_labels_indices.csv'], fileSizes: [10451715, 14675],
    notice: 'CED-Mini by Xiaomi Corporation / Heinrich Dinkel et al. Weights: Apache-2.0 (https://huggingface.co/mispeech/ced-mini). AudioSet ontology: Google, CC BY 4.0 (https://research.google.com/audioset/). ONNX conversion: k2-fsa/sherpa-onnx. Training code (not included): GPL-3.0. See docs/analysis.md.' }
]
