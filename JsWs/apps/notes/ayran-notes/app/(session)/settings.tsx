import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Switch,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../src/hooks/useTheme';
import { useSettingsStore } from '../../src/store/settings.store';
import { AppHeader } from '../../src/components/layout/AppHeader';
import { NotebookSettings } from '../../src/types/notebook.types';

const DARK_MODE_OPTIONS: { value: NotebookSettings['darkMode']; label: string }[] = [
  { value: 'system', label: 'System default' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const DEFAULT_SHORTCUTS: Record<string, string> = {
  'save': 'Ctrl+S',
  'togglePreview': 'Ctrl+P',
  'newNote': 'Ctrl+N',
  'closeModal': 'Escape',
  'goBack': 'Alt+ArrowLeft',
};

export default function SettingsPage() {
  const theme = useTheme();
  const darkMode = useSettingsStore((s) => s.darkMode);
  const setDarkMode = useSettingsStore((s) => s.setDarkMode);
  const customStylesheet = useSettingsStore((s) => s.customStylesheet);
  const setCustomStylesheet = useSettingsStore((s) => s.setCustomStylesheet);
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const setShortcut = useSettingsStore((s) => s.setShortcut);
  const removeShortcut = useSettingsStore((s) => s.removeShortcut);

  const [cssText, setCssText] = useState(customStylesheet ?? '');
  const [editingShortcut, setEditingShortcut] = useState<string | null>(null);
  const [shortcutText, setShortcutText] = useState('');

  const allShortcuts = { ...DEFAULT_SHORTCUTS, ...shortcuts };

  const handleSaveCss = () => {
    setCustomStylesheet(cssText.trim() || null);
    Alert.alert('Saved', 'Custom stylesheet saved.');
  };

  const handleSaveShortcut = (action: string) => {
    const trimmed = shortcutText.trim();
    if (!trimmed) {
      removeShortcut(action);
    } else {
      setShortcut(action, trimmed);
    }
    setEditingShortcut(null);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <AppHeader title="Settings" opacity={new Animated.Value(1)} icon="settings-outline" />
      <ScrollView>
        {/* Theme */}
        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>APPEARANCE</Text>
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Dark mode</Text>
          <View style={styles.segmented}>
            {DARK_MODE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.value}
                onPress={() => setDarkMode(opt.value)}
                style={[
                  styles.segment,
                  { borderColor: theme.colors.border },
                  darkMode === opt.value && { backgroundColor: theme.colors.primary },
                ]}
              >
                <Text style={{
                  color: darkMode === opt.value ? theme.colors.primaryForeground : theme.colors.text,
                  fontSize: 13,
                }}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Custom Stylesheet */}
        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>PREVIEW STYLESHEET</Text>
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <Text style={[styles.hint, { color: theme.colors.textSecondary }]}>
            Override the default CSS applied to note and HTML previews. Leave empty for default.
          </Text>
          <TextInput
            value={cssText}
            onChangeText={setCssText}
            placeholder="/* Custom CSS here */"
            placeholderTextColor={theme.colors.textSecondary}
            style={[styles.cssInput, { color: theme.colors.text, borderColor: theme.colors.border }]}
            multiline
            numberOfLines={8}
            textAlignVertical="top"
          />
          <TouchableOpacity
            onPress={handleSaveCss}
            style={[styles.saveBtn, { backgroundColor: theme.colors.primary }]}
          >
            <Text style={{ color: theme.colors.primaryForeground }}>Save Stylesheet</Text>
          </TouchableOpacity>
        </View>

        {/* Shortcuts */}
        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>KEYBOARD SHORTCUTS</Text>
        <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          {Object.entries(allShortcuts).map(([action, keys]) => (
            <View key={action} style={[styles.shortcutRow, { borderBottomColor: theme.colors.border }]}>
              <Text style={[styles.shortcutAction, { color: theme.colors.text }]}>
                {action.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())}
              </Text>
              {editingShortcut === action ? (
                <View style={styles.shortcutEdit}>
                  <TextInput
                    value={shortcutText}
                    onChangeText={setShortcutText}
                    placeholder={DEFAULT_SHORTCUTS[action] ?? 'e.g. Ctrl+S'}
                    placeholderTextColor={theme.colors.textSecondary}
                    style={[styles.shortcutInput, { color: theme.colors.text, borderColor: theme.colors.border }]}
                    autoFocus
                    onSubmitEditing={() => handleSaveShortcut(action)}
                  />
                  <TouchableOpacity onPress={() => handleSaveShortcut(action)}>
                    <Ionicons name="checkmark" size={20} color={theme.colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setEditingShortcut(null)}>
                    <Ionicons name="close" size={20} color={theme.colors.danger} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  onPress={() => { setEditingShortcut(action); setShortcutText(keys); }}
                  style={[styles.shortcutKeys, { backgroundColor: theme.colors.surfaceVariant }]}
                >
                  <Text style={[styles.shortcutKeysText, { color: theme.colors.text }]}>{keys}</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  sectionTitle: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginHorizontal: 16, marginTop: 20, marginBottom: 6 },
  card: { marginHorizontal: 16, borderRadius: 10, borderWidth: 1, padding: 14, marginBottom: 8 },
  label: { fontSize: 15, fontWeight: '500', marginBottom: 10 },
  hint: { fontSize: 13, marginBottom: 10 },
  segmented: { flexDirection: 'row', borderRadius: 6, overflow: 'hidden' },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth },
  cssInput: { borderWidth: 1, borderRadius: 6, padding: 10, fontFamily: 'monospace', fontSize: 12, minHeight: 120, marginBottom: 10 },
  saveBtn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center' },
  shortcutRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  shortcutAction: { fontSize: 14, flex: 1 },
  shortcutEdit: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shortcutInput: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, minWidth: 100, fontSize: 13, fontFamily: 'monospace' },
  shortcutKeys: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  shortcutKeysText: { fontSize: 13, fontFamily: 'monospace' },
});
