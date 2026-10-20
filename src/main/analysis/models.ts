import type { AnalysisPart } from '../../shared/analysis'
import type { ModelDownload } from '../model-download'
export const EVENT_DIR = 'sherpa-onnx-ced-mini-audio-tagging-2024-04-19'
export const TONE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
export const MODELS: (ModelDownload & { part: AnalysisPart; directory: string; files: string[]; fileSizes: number[]; notice: string })[] = [
  { part: 'events', id: EVENT_DIR, directory: EVENT_DIR, name: 'CED-Mini int8 (Apache-2.0 weights)', sizeBytes: 47658399,
    sha256: 'bec8bfa0af2c20ec3a9e7c6dd6c92d0fb6e96d6b25370ebe7a48e7283a60a02c',
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/${EVENT_DIR}.tar.bz2`, files: ['model.int8.onnx', 'class_labels_indices.csv'], fileSizes: [10451715, 14675],
    notice: 'CED-Mini by Xiaomi Corporation / Heinrich Dinkel et al. Weights: Apache-2.0 (https://huggingface.co/mispeech/ced-mini). AudioSet ontology: Google, CC BY 4.0 (https://research.google.com/audioset/). ONNX conversion: k2-fsa/sherpa-onnx. Training code (not included): GPL-3.0. See docs/analysis.md.' },
  { part: 'tone', id: TONE_DIR, directory: TONE_DIR, name: 'SenseVoiceSmall int8 (FunASR model license)', sizeBytes: 163002883,
    sha256: '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e',
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${TONE_DIR}.tar.bz2`, files: ['model.int8.onnx', 'tokens.txt'], fileSizes: [239233841, 315894],
    notice: 'SenseVoiceSmall by FunASR/FunAudioLLM, Alibaba Group. Model weights and derivatives: FunASR Model Open Source License Agreement v1.1. Retain source/author attribution and model name. https://huggingface.co/FunAudioLLM/SenseVoiceSmall ; https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE . ONNX conversion: k2-fsa/sherpa-onnx. Commercial-use clarification remains open: https://github.com/QwenAudio/SenseVoice/issues/334 . See docs/analysis.md.' }
]
