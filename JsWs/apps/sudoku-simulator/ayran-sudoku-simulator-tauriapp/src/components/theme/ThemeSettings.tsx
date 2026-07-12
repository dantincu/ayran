import { useState } from "react";
import { useTheme, DEFAULT_THEME, type NewThemeInput } from "../../state/ThemeContext";
import { contrastRatio, MIN_THEME_CONTRAST_RATIO } from "../../lib/colors";

const EMPTY_FORM: NewThemeInput = {
  name: "",
  background: "#ffffff",
  foreground: "#1f2937",
  accent: "#2563eb",
  boardBackground: "#ffffff",
  selectedCellBackground: "#dbeafe",
  peerCellBackground: "#eff6ff",
};

const BACKGROUND_FIELDS = [
  { key: "background", label: "App background" },
  { key: "boardBackground", label: "Board background" },
  { key: "selectedCellBackground", label: "Selected cell" },
  { key: "peerCellBackground", label: "Highlighted cells" },
] as const;

export function ThemeSettings() {
  const { themes, activeThemeId, setActiveTheme, saveTheme, deleteThemeById } = useTheme();
  const [form, setForm] = useState<NewThemeInput>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ratios = BACKGROUND_FIELDS.map((field) => ({
    ...field,
    ratio: contrastRatio(form.foreground, form[field.key]),
  }));
  const passesContrast = ratios.every((r) => r.ratio >= MIN_THEME_CONTRAST_RATIO);

  const startEdit = (id: string) => {
    const theme = themes.find((t) => t.id === id);
    if (!theme || theme.id === DEFAULT_THEME.id) return;
    setEditingId(id);
    setForm({
      name: theme.name,
      background: theme.background,
      foreground: theme.foreground,
      accent: theme.accent,
      boardBackground: theme.boardBackground,
      selectedCellBackground: theme.selectedCellBackground,
      peerCellBackground: theme.peerCellBackground,
    });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
  };

  const handleSave = () => {
    if (!passesContrast) {
      const worst = ratios.reduce((a, b) => (a.ratio < b.ratio ? a : b));
      setError(
        `"${worst.label}" contrast against the foreground is ${worst.ratio.toFixed(2)}:1 — needs at least ${MIN_THEME_CONTRAST_RATIO}:1 to remain readable.`,
      );
      return;
    }
    const ok = saveTheme(form, editingId ?? undefined);
    if (!ok) {
      setError("This theme doesn't meet the minimum contrast requirement.");
      return;
    }
    cancelEdit();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-gray-200 bg-white p-3">
        <h2 className="mb-2 text-sm font-semibold text-gray-800">Themes</h2>
        <div className="flex flex-col gap-2">
          {themes.map((theme) => (
            <div
              key={theme.id}
              className="flex items-center gap-3 rounded-md border border-gray-200 px-3 py-2"
            >
              <input
                type="radio"
                name="active-theme"
                checked={activeThemeId === theme.id}
                onChange={() => setActiveTheme(theme.id)}
              />
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-gray-300 text-xs font-bold"
                style={{ backgroundColor: theme.background, color: theme.foreground }}
                title={`bg ${theme.background} / fg ${theme.foreground}`}
              >
                Aa
              </div>
              <span
                className="h-4 w-4 shrink-0 rounded-full border border-gray-300"
                style={{ backgroundColor: theme.accent }}
                title={`accent ${theme.accent}`}
              />
              <span
                className="h-4 w-4 shrink-0 rounded border border-gray-300"
                style={{ backgroundColor: theme.boardBackground }}
                title={`board background ${theme.boardBackground}`}
              />
              <span
                className="h-4 w-4 shrink-0 rounded border border-gray-300"
                style={{ backgroundColor: theme.selectedCellBackground }}
                title={`selected cell ${theme.selectedCellBackground}`}
              />
              <span
                className="h-4 w-4 shrink-0 rounded border border-gray-300"
                style={{ backgroundColor: theme.peerCellBackground }}
                title={`highlighted cells ${theme.peerCellBackground}`}
              />
              <span className="flex-1 truncate text-sm text-gray-800">{theme.name}</span>
              {theme.id !== DEFAULT_THEME.id && (
                <>
                  <button
                    type="button"
                    onClick={() => startEdit(theme.id)}
                    className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete theme "${theme.name}"?`)) deleteThemeById(theme.id);
                    }}
                    className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-gray-200 bg-white p-3">
        <h2 className="mb-2 text-sm font-semibold text-gray-800">
          {editingId ? "Edit theme" : "New theme"}
        </h2>

        <label className="mb-1 block text-xs font-medium uppercase text-gray-500">Name</label>
        <input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="My theme"
          className="mb-3 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
        />

        <label className="mb-1 block text-xs font-medium uppercase text-gray-500">Foreground</label>
        <input
          type="color"
          value={form.foreground}
          onChange={(e) => setForm((f) => ({ ...f, foreground: e.target.value }))}
          className="mb-3 h-9 w-full cursor-pointer rounded border border-gray-300"
        />

        <p className="mb-1 text-xs font-medium uppercase text-gray-500">
          Background colors (each checked against the foreground above)
        </p>
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {BACKGROUND_FIELDS.map((field) => {
            const r = ratios.find((x) => x.key === field.key)!.ratio;
            const ok = r >= MIN_THEME_CONTRAST_RATIO;
            return (
              <div key={field.key}>
                <label className="mb-1 block text-xs font-medium text-gray-500">{field.label}</label>
                <input
                  type="color"
                  value={form[field.key]}
                  onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                  className="h-9 w-full cursor-pointer rounded border border-gray-300"
                />
                <span className={`mt-1 block text-[10px] font-semibold ${ok ? "text-green-700" : "text-red-700"}`}>
                  {r.toFixed(2)}:1 {ok ? "OK" : "low"}
                </span>
              </div>
            );
          })}
        </div>

        <label className="mb-1 block text-xs font-medium uppercase text-gray-500">Accent</label>
        <input
          type="color"
          value={form.accent}
          onChange={(e) => setForm((f) => ({ ...f, accent: e.target.value }))}
          className="mb-3 h-9 w-full cursor-pointer rounded border border-gray-300"
        />

        <div
          className="mb-3 grid grid-cols-3 gap-px overflow-hidden rounded-md border"
          style={{ borderColor: form.foreground }}
        >
          {[
            { label: "Board", bg: form.boardBackground },
            { label: "Selected", bg: form.selectedCellBackground },
            { label: "Peer", bg: form.peerCellBackground },
          ].map((cell) => (
            <div
              key={cell.label}
              className="flex flex-col items-center justify-center gap-0.5 p-3 text-xs font-medium"
              style={{ backgroundColor: cell.bg, color: form.foreground }}
            >
              <span className="text-lg font-bold">5</span>
              {cell.label}
            </div>
          ))}
        </div>

        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          {editingId && (
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-md px-3 py-1.5 text-sm text-gray-600"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            disabled={!passesContrast}
            onClick={handleSave}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {editingId ? "Save changes" : "Create theme"}
          </button>
        </div>
      </div>
    </div>
  );
}
