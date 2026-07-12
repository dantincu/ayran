import { useState } from "react";
import { useTheme, DEFAULT_THEME, type NewThemeInput } from "../../state/ThemeContext";
import { contrastRatio, MIN_THEME_CONTRAST_RATIO } from "../../lib/colors";

const EMPTY_FORM: NewThemeInput = {
  name: "",
  background: "#ffffff",
  foreground: "#1f2937",
  accent: "#2563eb",
};

export function ThemeSettings() {
  const { themes, activeThemeId, setActiveTheme, saveTheme, deleteThemeById } = useTheme();
  const [form, setForm] = useState<NewThemeInput>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ratio = contrastRatio(form.foreground, form.background);
  const passesContrast = ratio >= MIN_THEME_CONTRAST_RATIO;

  const startEdit = (id: string) => {
    const theme = themes.find((t) => t.id === id);
    if (!theme || theme.id === DEFAULT_THEME.id) return;
    setEditingId(id);
    setForm({ name: theme.name, background: theme.background, foreground: theme.foreground, accent: theme.accent });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
  };

  const handleSave = () => {
    if (!passesContrast) {
      setError(
        `Foreground/background contrast is ${ratio.toFixed(2)}:1 — needs at least ${MIN_THEME_CONTRAST_RATIO}:1 to remain readable.`,
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

        <div className="mb-3 grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">Background</label>
            <input
              type="color"
              value={form.background}
              onChange={(e) => setForm((f) => ({ ...f, background: e.target.value }))}
              className="h-9 w-full cursor-pointer rounded border border-gray-300"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">Foreground</label>
            <input
              type="color"
              value={form.foreground}
              onChange={(e) => setForm((f) => ({ ...f, foreground: e.target.value }))}
              className="h-9 w-full cursor-pointer rounded border border-gray-300"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">Accent</label>
            <input
              type="color"
              value={form.accent}
              onChange={(e) => setForm((f) => ({ ...f, accent: e.target.value }))}
              className="h-9 w-full cursor-pointer rounded border border-gray-300"
            />
          </div>
        </div>

        <div
          className="mb-3 flex items-center justify-between rounded-md border p-3"
          style={{ backgroundColor: form.background, color: form.foreground, borderColor: form.foreground }}
        >
          <span className="text-sm font-medium">Preview text on background</span>
          <span
            className={`rounded px-2 py-0.5 text-xs font-semibold ${passesContrast ? "text-green-700" : "text-red-700"}`}
            style={{ backgroundColor: passesContrast ? "#dcfce7" : "#fee2e2" }}
          >
            {ratio.toFixed(2)}:1 {passesContrast ? "OK" : `(needs ${MIN_THEME_CONTRAST_RATIO}:1)`}
          </span>
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
