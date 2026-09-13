import './ColorPicker.css';

interface Preset {
  name: string;
  fg: string;
  bg: string;
}

// Dark-on-light and light-on-dark variants of the same handful of hues.
const PRESETS: Preset[] = [
  { name: 'Purple', fg: '#4c1d95', bg: '#efe6ff' },
  { name: 'Red', fg: '#7f1d1d', bg: '#fee2e2' },
  { name: 'Green', fg: '#14532d', bg: '#dcfce7' },
  { name: 'Blue', fg: '#1e3a8a', bg: '#dbeafe' },
  { name: 'Amber', fg: '#78350f', bg: '#fef3c7' },
  { name: 'Purple (dark)', fg: '#e9d8fd', bg: '#4c1d95' },
  { name: 'Red (dark)', fg: '#fee2e2', bg: '#7f1d1d' },
  { name: 'Green (dark)', fg: '#dcfce7', bg: '#14532d' },
  { name: 'Blue (dark)', fg: '#dbeafe', bg: '#1e3a8a' },
  { name: 'Amber (dark)', fg: '#fef3c7', bg: '#78350f' },
];

interface ColorPickerProps {
  fg: string | undefined;
  bg: string | undefined;
  onChange: (fg: string | undefined, bg: string | undefined) => void;
}

export default function ColorPicker({ fg, bg, onChange }: ColorPickerProps) {
  return (
    <div className="color-picker">
      <div className="color-picker-presets">
        <button type="button" className="color-picker-default" onClick={() => onChange(undefined, undefined)}>
          Default
        </button>
        {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className="color-picker-swatch"
            style={{ background: p.bg, color: p.fg }}
            aria-label={p.name}
            title={p.name}
            onClick={() => onChange(p.fg, p.bg)}
          >
            Aa
          </button>
        ))}
      </div>
      <div className="color-picker-custom">
        <label className="color-picker-custom-field">
          <span>Text</span>
          <input
            type="color"
            value={fg ?? '#4c1d95'}
            onChange={(e) => onChange(e.target.value, bg ?? '#efe6ff')}
          />
        </label>
        <label className="color-picker-custom-field">
          <span>Background</span>
          <input
            type="color"
            value={bg ?? '#efe6ff'}
            onChange={(e) => onChange(fg ?? '#4c1d95', e.target.value)}
          />
        </label>
      </div>
    </div>
  );
}
