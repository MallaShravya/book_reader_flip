import type { ReactNode } from 'react'
import type { ReaderSettings, Theme } from '../types'


interface Props {
  settings: ReaderSettings
  onChange: (patch: Partial<ReaderSettings>) => void
  onClose: () => void
  /** Measured layout values, shown so on-device sizing bugs are readable. */
  diagnostics?: string
}

/**
 * A value with decrement and increment buttons either side.
 *
 * Sized for thumbs (46px tall, 52px wide buttons) and clamped at both ends so
 * the arrows disable rather than silently doing nothing.
 */
function Stepper({
  label,
  display,
  value,
  min,
  max,
  step,
  onChange
}: {
  label: string
  display: string
  value: number
  min: number
  max: number
  step: number
  onChange: (next: number) => void
}): ReactNode {
  // Floating-point steps like 0.1 accumulate error, so round to the step grid.
  const clamp = (n: number): number => Math.min(max, Math.max(min, Math.round(n / step) * step))

  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
      </div>
      <div className="stepper">
        <button
          onClick={() => onChange(clamp(value - step))}
          disabled={value <= min}
          aria-label={`Decrease ${label.toLowerCase()}`}
        >
          −
        </button>
        <div className="value" role="status" aria-live="polite">
          {display}
        </div>
        <button
          onClick={() => onChange(clamp(value + step))}
          disabled={value >= max}
          aria-label={`Increase ${label.toLowerCase()}`}
        >
          +
        </button>
      </div>
    </div>
  )
}

const THEMES: Array<{ id: Theme; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'dark', label: 'Dark' }
]

export default function SettingsSheet({
  settings,
  onChange,
  onClose,
  diagnostics
}: Props): ReactNode {
  return (
    <div className="sheet">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.9rem' }}>
        <strong>Reading</strong>
        <button className="subtle" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="field">
        <div className="field-label">
          <span>Theme</span>
        </div>
        <div className="seg">
          {THEMES.map((t) => (
            <button
              key={t.id}
              aria-pressed={settings.theme === t.id}
              onClick={() => onChange({ theme: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <div className="field-label">
          <span>Ink</span>
        </div>
        <div className="seg">
          <button
            aria-pressed={settings.ink === 'normal'}
            onClick={() => onChange({ ink: 'normal' })}
          >
            Normal
          </button>
          <button
            aria-pressed={settings.ink === 'soft'}
            onClick={() => onChange({ ink: 'soft' })}
          >
            Soft
          </button>
        </div>
        <div className="hint">Softer text is easier on the eyes in low light.</div>
      </div>

      <div className="field">
        <div className="field-label">
          <span>Typeface</span>
        </div>
        <div className="seg">
          <button
            aria-pressed={settings.fontFamily === 'serif'}
            onClick={() => onChange({ fontFamily: 'serif' })}
          >
            Serif
          </button>
          <button
            aria-pressed={settings.fontFamily === 'sans'}
            onClick={() => onChange({ fontFamily: 'sans' })}
          >
            Sans
          </button>
        </div>
      </div>

      {/*
        Steppers rather than sliders: each of these re-lays out the whole book,
        so a drag would fire a rebuild per intermediate value, and the values
        are fine-grained enough that hitting one exactly on a phone is fiddly.
      */}
      <div className="field-row">
        <Stepper
          label="Text size"
          display={`${settings.fontSize}px`}
          value={settings.fontSize}
          min={13}
          max={30}
          step={1}
          onChange={(fontSize) => onChange({ fontSize })}
        />

        <Stepper
          label="Line spacing"
          display={settings.lineHeight.toFixed(1)}
          value={settings.lineHeight}
          min={1.2}
          max={2.2}
          step={0.1}
          onChange={(lineHeight) => onChange({ lineHeight: Number(lineHeight.toFixed(1)) })}
        />
      </div>

      <div className="field">
        <div className="field-label">
          <span>Smoothness on long books</span>
        </div>
        <div className="seg">
          <button
            aria-pressed={settings.chunkChars === 0}
            onClick={() => onChange({ chunkChars: 0 })}
          >
            Off
          </button>
          <button
            aria-pressed={settings.chunkChars === 60_000}
            onClick={() => onChange({ chunkChars: 60_000 })}
          >
            Balanced
          </button>
          <button
            aria-pressed={settings.chunkChars === 20_000}
            onClick={() => onChange({ chunkChars: 20_000 })}
          >
            Smoothest
          </button>
        </div>
        <div className="hint">
          Splits long chapters so each page carries less to animate. The
          trade-off is a page break at every split, so some pages end early.
          &quot;Off&quot; is the original behaviour.
        </div>
      </div>

      <div className="field">
        <div className="field-label">
          <span>Page gloss</span>
        </div>
        <div className="seg">
          <button
            aria-pressed={settings.gloss === 'low'}
            onClick={() => onChange({ gloss: 'low' })}
          >
            Low
          </button>
          <button
            aria-pressed={settings.gloss === 'high'}
            onClick={() => onChange({ gloss: 'high' })}
          >
            High
          </button>
        </div>
        <div className="hint">
          How strongly the page shades as it curls. Low is softer and more paper-like.
        </div>
      </div>

      <Stepper
        label="Page turn speed"
        display={`${(settings.flippingTime / 1000).toFixed(1)}s`}
        value={settings.flippingTime}
        min={300}
        max={1600}
        step={100}
        onChange={(flippingTime) => onChange({ flippingTime })}
      />

      <div className="subtle" style={{ marginTop: '0.8rem' }}>
        Changing text settings re-lays out the book, which takes a moment on long titles.
      </div>

      {diagnostics && (
        <details style={{ marginTop: '0.8rem' }}>
          <summary className="subtle" style={{ cursor: 'pointer' }}>
            Layout diagnostics
          </summary>
          <pre
            className="subtle"
            style={{ whiteSpace: 'pre-wrap', margin: '0.5rem 0 0', fontSize: '0.72rem' }}
          >
            {diagnostics}
          </pre>
        </details>
      )}
    </div>
  )
}
