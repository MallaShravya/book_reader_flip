import type { ReactNode } from 'react'
import type { ReaderSettings, Theme } from '../types'

interface Props {
  settings: ReaderSettings
  onChange: (patch: Partial<ReaderSettings>) => void
  onClose: () => void
  /** Measured layout values, shown so on-device sizing bugs are readable. */
  diagnostics?: string
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

      <div className="field">
        <div className="field-label">
          <span>Text size</span>
          <span>{settings.fontSize}px</span>
        </div>
        <input
          className="scrubber"
          type="range"
          min={13}
          max={30}
          step={1}
          value={settings.fontSize}
          onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
        />
      </div>

      <div className="field">
        <div className="field-label">
          <span>Line spacing</span>
          <span>{settings.lineHeight.toFixed(1)}</span>
        </div>
        <input
          className="scrubber"
          type="range"
          min={1.2}
          max={2.2}
          step={0.1}
          value={settings.lineHeight}
          onChange={(e) => onChange({ lineHeight: Number(e.target.value) })}
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

      <div className="field" style={{ marginBottom: 0 }}>
        <div className="field-label">
          <span>Page turn speed</span>
          <span>{(settings.flippingTime / 1000).toFixed(1)}s</span>
        </div>
        <input
          className="scrubber"
          type="range"
          min={300}
          max={1600}
          step={100}
          value={settings.flippingTime}
          onChange={(e) => onChange({ flippingTime: Number(e.target.value) })}
        />
      </div>

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
