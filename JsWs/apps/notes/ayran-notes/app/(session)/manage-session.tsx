import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Switch,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../src/hooks/useTheme';
import { useSessionStore, createSession } from '../../src/store/session.store';
import { AppHeader } from '../../src/components/layout/AppHeader';

export default function ManageSessionPage() {
  const theme = useTheme();
  const router = useRouter();
  const sessions = useSessionStore((s) => s.sessions);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession);
  const updateSession = useSessionStore((s) => s.updateSession);
  const removeSession = useSessionStore((s) => s.removeSession);

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  const [editingName, setEditingName] = useState(false);
  const [nameText, setNameText] = useState(currentSession?.name ?? '');

  const handleSaveName = () => {
    if (!currentSession || !nameText.trim()) return;
    updateSession(currentSession.id, { name: nameText.trim() });
    setEditingName(false);
  };

  const handleToggleSyncName = (value: boolean) => {
    if (!currentSession) return;
    updateSession(currentSession.id, { syncNameWithNotebook: value });
  };

  const handleSwitchSession = (sessionId: string) => {
    setCurrentSession(sessionId);
    router.replace('/');
  };

  const handleDeleteSession = (sessionId: string) => {
    if (sessions.length <= 1) {
      Alert.alert('Cannot Delete', 'You must have at least one session.');
      return;
    }
    Alert.alert('Delete Session', 'Remove this session? Your notes are not affected.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => removeSession(sessionId) },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <AppHeader title="Manage Sessions" opacity={new (require('react-native').Animated.Value)(1)} icon="albums-outline" />

      <View style={[styles.section, { borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>CURRENT SESSION</Text>
        {currentSession && (
          <>
            <View style={styles.row}>
              <Text style={[styles.label, { color: theme.colors.text }]}>Sync name with notebook</Text>
              <Switch
                value={currentSession.syncNameWithNotebook}
                onValueChange={handleToggleSyncName}
                trackColor={{ true: theme.colors.primary }}
              />
            </View>
            {!currentSession.syncNameWithNotebook && (
              <View style={styles.row}>
                <Text style={[styles.label, { color: theme.colors.text }]}>Session name</Text>
                {editingName ? (
                  <View style={styles.nameEdit}>
                    <TextInput
                      value={nameText}
                      onChangeText={setNameText}
                      style={[styles.nameInput, { color: theme.colors.text, borderColor: theme.colors.border }]}
                      autoFocus
                      onSubmitEditing={handleSaveName}
                    />
                    <TouchableOpacity onPress={handleSaveName}>
                      <Ionicons name="checkmark" size={22} color={theme.colors.primary} />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => { setEditingName(true); setNameText(currentSession.name); }}>
                    <Text style={[styles.nameValue, { color: theme.colors.primary }]}>
                      {currentSession.name} ✎
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </>
        )}
      </View>

      <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary, margin: 16 }]}>ALL SESSIONS</Text>
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <View
            style={[
              styles.sessionRow,
              { borderBottomColor: theme.colors.border },
              item.id === currentSessionId && { backgroundColor: theme.colors.surfaceVariant },
            ]}
          >
            <TouchableOpacity style={styles.sessionInfo} onPress={() => handleSwitchSession(item.id)}>
              <Ionicons
                name={item.id === currentSessionId ? 'radio-button-on' : 'radio-button-off'}
                size={18}
                color={theme.colors.primary}
              />
              <View style={styles.sessionText}>
                <Text style={[styles.sessionName, { color: theme.colors.text }]}>{item.name}</Text>
                <Text style={[styles.sessionMeta, { color: theme.colors.textSecondary }]}>
                  {item.tabs.length} tab{item.tabs.length !== 1 ? 's' : ''} · {item.storageProviderType}
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => handleDeleteSession(item.id)} style={styles.deleteBtn}>
              <Ionicons name="trash-outline" size={18} color={theme.colors.danger} />
            </TouchableOpacity>
          </View>
        )}
      />

      <TouchableOpacity
        style={[styles.newSessionBtn, { backgroundColor: theme.colors.primary }]}
        onPress={() => router.push('/onboarding/storage-setup')}
      >
        <Ionicons name="add" size={20} color={theme.colors.primaryForeground} />
        <Text style={{ color: theme.colors.primaryForeground, fontWeight: '600' }}>New Session</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  section: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8 },
  sectionTitle: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5, margin: 16, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  label: { fontSize: 15 },
  nameEdit: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nameInput: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, minWidth: 120 },
  nameValue: { fontSize: 15 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  sessionInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  sessionText: { flex: 1 },
  sessionName: { fontSize: 15, fontWeight: '500' },
  sessionMeta: { fontSize: 12, marginTop: 2 },
  deleteBtn: { padding: 8 },
  newSessionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', margin: 16, padding: 14, borderRadius: 10, gap: 8 },
});
