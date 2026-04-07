import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  TextInput,
} from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { useSettingsStore } from '../../store/settings.store';

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899',
  '#78716c', '#64748b',
];

interface ColorPickerProps {
  value: string | null;
  onChange: (color: string | null) => void;
  onDismiss: () => void;
}

export function ColorPicker({ value, onChange, onDismiss }: ColorPickerProps) {
  const theme = useTheme();
  const recentColors = useSettingsStore((s) => s.recentLabelColors);
  const addRecentColor = useSettingsStore((s) => s.addRecentLabelColor);
  const [hex, setHex] = useState(value ?? '');

  const handleSelect = (color: string) => {
    addRecentColor(color);
    onChange(color);
    onDismiss();
  };

  const handleHexSubmit = () => {
    const normalized = hex.startsWith('#') ? hex : `#${hex}`;
    if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
      handleSelect(normalized);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
      <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>Preset colors</Text>
      <View style={styles.colorGrid}>
        {PRESET_COLORS.map((color) => (
          <TouchableOpacity
            key={color}
            style={[styles.colorSwatch, { backgroundColor: color, borderColor: value === color ? theme.colors.primary : 'transparent' }]}
            onPress={() => handleSelect(color)}
          />
        ))}
      </View>

      {recentColors.length > 0 && (
        <>
          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>Recent</Text>
          <View style={styles.colorGrid}>
            {recentColors.slice(0, 10).map((color) => (
              <TouchableOpacity
                key={color}
                style={[styles.colorSwatch, { backgroundColor: color, borderColor: value === color ? theme.colors.primary : 'transparent' }]}
                onPress={() => handleSelect(color)}
              />
            ))}
          </View>
        </>
      )}

      <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>Custom hex</Text>
      <View style={styles.hexRow}>
        <TextInput
          value={hex}
          onChangeText={setHex}
          placeholder="#rrggbb"
          placeholderTextColor={theme.colors.textSecondary}
          style={[styles.hexInput, { color: theme.colors.text, borderColor: theme.colors.border }]}
          autoCapitalize="none"
          onSubmitEditing={handleHexSubmit}
        />
        <TouchableOpacity
          onPress={handleHexSubmit}
          style={[styles.applyBtn, { backgroundColor: theme.colors.primary }]}
        >
          <Text style={{ color: theme.colors.primaryForeground }}>Apply</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        onPress={() => { onChange(null); onDismiss(); }}
        style={styles.clearBtn}
      >
        <Text style={{ color: theme.colors.danger }}>Clear label color</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  sectionLabel: {
    fontSize: 12,
    marginBottom: 8,
    marginTop: 8,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  colorSwatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
  },
  hexRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  hexInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontFamily: 'monospace',
    fontSize: 14,
  },
  applyBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  clearBtn: {
    marginTop: 12,
    paddingVertical: 4,
  },
});
