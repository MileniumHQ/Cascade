/**
 * Source media analysis: the map agents edit from. Everything is computed locally and cached per
 * source file; times are integer flicks in the ORIGINAL SOURCE (map through clip sourceIn/speed
 * to get timeline time).
 */
import type { Flicks } from './time'

export const ANALYSIS_VERSION = 2

export type AnalysisPart = 'speech' | 'events' | 'prosody' | 'shots' | 'speakers'

export interface AnalysisWord {
  /** Verbatim text, including disfluencies ("um", "uh") when whisper keeps them. */
  text: string
  start: Flicks
  end: Flicks
  /** Recognizer confidence 0..1 (minimum over the word's tokens). */
  p: number
  /** Filled pause / hesitation (um, uh, erm, hmm, mm). Not "like"/"you know": those are judgement calls. */
  filler?: boolean
  /** Word loudness in dB relative to this source's median speech loudness (+6 ≈ emphasized, -10 ≈ quiet). */
  db?: number
  /** Median pitch in semitones relative to the source's median speaking pitch (prosody part). */
  st?: number
  /** Pitch and loudness both peak within the sentence (at most two per sentence). */
  emphasis?: true
}

export interface AnalysisSentence {
  start: Flicks
  end: Flicks
  /** Half-open index range into `words`. */
  words: [number, number]
  text: string
  /**
   * Measured intonation (prosody part): `range` = 10th–90th percentile pitch spread in semitones
   * (monotone ≈ 3, lively ≈ 8+); `end` = pitch direction over the last voiced word.
   */
  pitch?: { range: number; end: 'rise' | 'fall' | 'level' }
  /** Speaking rate in words per second. */
  rate?: number
  /** 0-based speaker index when the speakers part ran. */
  speaker?: number
}

export interface AnalysisEvent {
  /** Short uppercase cue for display/captions: MUSIC, APPLAUSE, LAUGHTER, CHEERING, … */
  cue: string
  /** Underlying ontology label (AudioSet name), e.g. "Music", "Applause". */
  label: string
  start: Flicks
  end: Flicks
  /** Peak model score 0..1 over the range. */
  score: number
  /** True when speech overlaps most of the range (e.g. music bed under narration). */
  underSpeech?: boolean
}

export interface SourceAnalysis {
  /** Parts that failed; completed parts remain usable. */
  errors?: Partial<Record<AnalysisPart, string>>
  /** Wall-clock milliseconds per part, excluding cache hits. */
  timings?: Partial<Record<AnalysisPart, number>>
  version: number
  path: string
  /** Analyzed source range. */
  range: { start: Flicks; end: Flicks }
  language: string
  parts: AnalysisPart[]
  /** Model id per part, for provenance. */
  models: Partial<Record<AnalysisPart, string>>
  words: AnalysisWord[]
  sentences: AnalysisSentence[]
  events: AnalysisEvent[]
  /** Acoustic silences (below ~-35 dBFS for ≥ 0.18 s). */
  silences: { start: Flicks; end: Flicks }[]
  /** Visual shot-change times (hard cuts), for video sources. */
  shots: Flicks[]
  /** Median speech loudness in dBFS, the reference for `AnalysisWord.db`. */
  speechDb?: number
  /** Median speaking pitch in Hz, the reference for `AnalysisWord.st`. */
  speechHz?: number
}

export interface AnalysisOptions {
  range?: { start: Flicks; end: Flicks }
  /** ISO 639-1 code or 'auto'. */
  language?: string
  /** Defaults to every part the installed models support. */
  parts?: AnalysisPart[]
}

export interface AnalysisProgress {
  path: string
  part: AnalysisPart | 'download' | 'extract'
  progress: number
  message: string
  phase: 'running' | 'done' | 'cancelled' | 'error'
}

export interface AnalysisStatus {
  /** Which parts can run right now (binaries/runtime present, models installed). */
  available: AnalysisPart[]
  /** Models not yet downloaded, per part. */
  missing: { part: AnalysisPart; id: string; name: string; sizeBytes: number }[]
}

export interface AnalysisBridge {
  status(): Promise<AnalysisStatus>
  /** Download every missing model (progress via onProgress, part 'download'). */
  installModels(parts?: AnalysisPart[]): Promise<void>
  /** Analyze (or load from cache). One job at a time application-wide. */
  run(path: string, opts?: AnalysisOptions): Promise<SourceAnalysis>
  /** Cached analyses for a file, without computing anything. */
  cached(path: string): Promise<SourceAnalysis[]>
  cancel(): Promise<void>
  onProgress(fn: (p: AnalysisProgress) => void): () => void
}
