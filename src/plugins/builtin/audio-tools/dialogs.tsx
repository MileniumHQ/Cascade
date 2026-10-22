import { createSignal } from 'solid-js'
import { Button, Modal, NumberField, openDialog, Segmented } from '@ui/kit'

const PRESETS = ['-14', '-16', '-23'] as const
type Preset = (typeof PRESETS)[number] | 'custom'

/** Pick the loudness target (LUFS) and confirm. */
export function askNormalizeTarget(initial: number, count: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: number | null, close: () => void) => {
      if (settled) return
      settled = true
      resolve(v)
      close()
    }
    openDialog((close) => {
      const [preset, setPreset] = createSignal<Preset>(PRESETS.includes(String(initial) as never) ? (String(initial) as Preset) : 'custom')
      const [custom, setCustom] = createSignal(initial)
      const target = () => (preset() === 'custom' ? custom() : Number(preset()))
      return (
        <Modal
          title="Normalize loudness"
          icon="volume-2"
          width={380}
          onClose={() => done(null, close)}
          footer={
            <>
              <Button onClick={() => done(null, close)}>Cancel</Button>
              <Button variant="primary" onClick={() => done(target(), close)}>
                Normalize
              </Button>
            </>
          }
        >
          <div class="field-row">
            <label>Target</label>
            <Segmented<Preset>
              value={preset()}
              onChange={setPreset}
              options={[
                { value: '-14', label: '-14', tip: 'Online video' },
                { value: '-16', label: '-16', tip: 'Podcasts, mobile' },
                { value: '-23', label: '-23', tip: 'Broadcast (EBU R128)' },
                { value: 'custom', label: 'Custom' }
              ]}
            />
          </div>
          {preset() === 'custom' && (
            <div class="field-row">
              <label>Custom</label>
              <NumberField value={custom()} min={-60} max={0} step={0.5} suffix="LUFS" width="96px" onChange={(v) => setCustom(v)} />
            </div>
          )}
          <div class="empty-hint">
            Sets the Volume of {count} clip{count === 1 ? '' : 's'} so the source plays at {target()} LUFS integrated.
          </div>
        </Modal>
      )
    })
  })
}

export interface DuckChoice {
  amount: number
  attackMs: number
  releaseMs: number
  mergeGapMs: number
}
export const DUCK_DEFAULTS: DuckChoice = { amount: -12, attackMs: 150, releaseMs: 400, mergeGapMs: 800 }

/** Duck amount, attack, release and gap merging; resolves null when cancelled. */
export function askDuck(count: number): Promise<DuckChoice | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: DuckChoice | null, close: () => void) => {
      if (settled) return
      settled = true
      resolve(v)
      close()
    }
    openDialog((close) => {
      const [c, setC] = createSignal<DuckChoice>({ ...DUCK_DEFAULTS })
      const set = <K extends keyof DuckChoice>(k: K, v: DuckChoice[K]) => setC({ ...c(), [k]: v })
      return (
        <Modal
          title="Auto-duck under speech"
          icon="audio-lines"
          width={380}
          onClose={() => done(null, close)}
          footer={
            <>
              <Button onClick={() => done(null, close)}>Cancel</Button>
              <Button variant="primary" onClick={() => done(c(), close)}>
                Duck
              </Button>
            </>
          }
        >
          <div class="field-row">
            <label>Duck by</label>
            <NumberField value={c().amount} min={-60} max={0} step={0.5} suffix="dB" width="96px" onChange={(v) => set('amount', v)} />
          </div>
          <div class="field-row">
            <label>Attack</label>
            <NumberField value={c().attackMs} min={0} max={5000} step={10} suffix="ms" width="96px" onChange={(v) => set('attackMs', v)} />
          </div>
          <div class="field-row">
            <label>Release</label>
            <NumberField value={c().releaseMs} min={0} max={10000} step={10} suffix="ms" width="96px" onChange={(v) => set('releaseMs', v)} />
          </div>
          <div class="field-row">
            <label>Keep ducked across gaps up to</label>
            <NumberField value={c().mergeGapMs} min={0} max={10000} step={50} suffix="ms" width="96px" onChange={(v) => set('mergeGapMs', v)} />
          </div>
          <div class="empty-hint">
            Lowers the Volume of {count} clip{count === 1 ? '' : 's'} wherever other tracks have speech.
          </div>
        </Modal>
      )
    })
  })
}
