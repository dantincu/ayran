import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  TextInput,
  Alert,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StorageProviderType } from '../../src/types/storage.types';
import { LocalStorageProvider } from '../../src/storage/local/LocalStorageProvider';
import { GoogleDriveProvider } from '../../src/storage/google-drive/GoogleDriveProvider';
import { OneDriveProvider } from '../../src/storage/onedrive/OneDriveProvider';
import { DropboxProvider } from '../../src/storage/dropbox/DropboxProvider';
import { FilenProvider } from '../../src/storage/filen/FilenProvider';
import { registerStorageProvider } from '../../src/storage/StorageProviderFactory';
import { tryOpenNotebook } from '../../src/notebook/NotebookValidator';
import { createNotebook } from '../../src/notebook/NotebookWriter';
import { useSessionStore, createSession, generateId } from '../../src/store/session.store';
import { useNotebookStore } from '../../src/store/notebook.store';
import { NotebookJson } from '../../src/types/notebook.types';
import { NoteInternalDir } from '../../src/types/note.types';

interface StorageOption {
  type: StorageProviderType;
  label: string;
  icon: string;
  description: string;
}

const STORAGE_OPTIONS: StorageOption[] = [
  { type: StorageProviderType.Local, label: 'Local Device', icon: '📱', description: 'Store notes in a folder on your device' },
  { type: StorageProviderType.GoogleDrive, label: 'Google Drive', icon: '🔵', description: 'Full Google Drive access' },
  { type: StorageProviderType.OneDrive, label: 'OneDrive', icon: '🌐', description: 'Full OneDrive access' },
  { type: StorageProviderType.Dropbox, label: 'Dropbox', icon: '📦', description: 'Full Dropbox access' },
  { type: StorageProviderType.Filen, label: 'Filen.IO', icon: '🔒', description: 'End-to-end encrypted storage' },
];

type Step = 'choose-storage' | 'authenticate' | 'choose-folder' | 'notebook-title';

export default function StorageSetupPage() {
  const router = useRouter();
  const addSession = useSessionStore((s) => s.addSession);
  const setNotebook = useNotebookStore((s) => s.setNotebook);

  const [step, setStep] = useState<Step>('choose-storage');
  const [selectedType, setSelectedType] = useState<StorageProviderType | null>(null);
  const [provider, setProvider] = useState<any>(null);
  const [notebookPath, setNotebookPath] = useState('');
  const [notebookTitle, setNotebookTitle] = useState('');
  const [filenEmail, setFilenEmail] = useState('');
  const [filenPassword, setFilenPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const providerId = generateId();

  const handleSelectStorage = async (type: StorageProviderType) => {
    setSelectedType(type);
    setLoading(true);

    try {
      let p: any;
      switch (type) {
        case StorageProviderType.Local:
          p = new LocalStorageProvider(providerId, LocalStorageProvider.getDefaultRoot());
          break;
        case StorageProviderType.GoogleDrive:
          p = new GoogleDriveProvider(providerId, 'YOUR_GOOGLE_CLIENT_ID');
          break;
        case StorageProviderType.OneDrive:
          p = new OneDriveProvider(providerId, 'YOUR_ONEDRIVE_CLIENT_ID');
          break;
        case StorageProviderType.Dropbox:
          p = new DropboxProvider(providerId, 'YOUR_DROPBOX_CLIENT_ID');
          break;
        case StorageProviderType.Filen:
          p = new FilenProvider(providerId);
          setProvider(p);
          setStep('authenticate');
          setLoading(false);
          return;
      }

      if (type !== StorageProviderType.Local) {
        await p.authenticate();
      }

      registerStorageProvider(p);
      setProvider(p);
      setStep('choose-folder');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleFilenAuth = async () => {
    setLoading(true);
    try {
      await provider.authenticate(filenEmail, filenPassword);
      registerStorageProvider(provider);
      setStep('choose-folder');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Filen authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleChooseFolder = async () => {
    if (!provider || !notebookPath.trim()) return;
    setLoading(true);
    try {
      const path = notebookPath.trim();
      const existing = await tryOpenNotebook(provider, path);
      if (existing) {
        // Open existing notebook
        await finishSetup(path, existing);
      } else {
        setStep('notebook-title');
      }
    } catch (err) {
      Alert.alert('Invalid Folder', err instanceof Error ? err.message : 'Folder validation failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNotebook = async () => {
    if (!provider || !notebookTitle.trim()) return;
    setLoading(true);
    try {
      const path = notebookPath.trim();
      await provider.createDir(path);
      const notebookJson = await createNotebook(provider, path, notebookTitle.trim());
      await finishSetup(path, notebookJson);
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create notebook');
    } finally {
      setLoading(false);
    }
  };

  const finishSetup = async (path: string, notebookJson: NotebookJson) => {
    const session = createSession(providerId, selectedType!, path, notebookJson.Title);
    addSession(session);
    setNotebook({
      title: notebookJson.Title,
      rootPath: path,
      storageProviderId: providerId,
      internalDirs: (notebookJson.InternalDirs as Record<string, NoteInternalDir>) ?? {},
    });
    router.replace('/');
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0969da" />
        <Text style={styles.loadingText}>Please wait...</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        {step === 'choose-storage' && (
          <>
            <Ionicons name="cloud-outline" size={48} color="#0969da" />
            <Text style={styles.title}>Choose Storage</Text>
            <Text style={styles.subtitle}>Where would you like to store your notes?</Text>
            {STORAGE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.type}
                style={styles.option}
                onPress={() => handleSelectStorage(opt.type)}
              >
                <Text style={styles.optionIcon}>{opt.icon}</Text>
                <View style={styles.optionText}>
                  <Text style={styles.optionLabel}>{opt.label}</Text>
                  <Text style={styles.optionDesc}>{opt.description}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#8c8c8c" />
              </TouchableOpacity>
            ))}
          </>
        )}

        {step === 'authenticate' && selectedType === StorageProviderType.Filen && (
          <>
            <Text style={styles.title}>Sign in to Filen.IO</Text>
            <TextInput
              value={filenEmail}
              onChangeText={setFilenEmail}
              placeholder="Email"
              style={styles.input}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TextInput
              value={filenPassword}
              onChangeText={setFilenPassword}
              placeholder="Password"
              style={styles.input}
              secureTextEntry
            />
            <TouchableOpacity style={styles.primaryBtn} onPress={handleFilenAuth}>
              <Text style={styles.primaryBtnText}>Sign In</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'choose-folder' && (
          <>
            <Text style={styles.title}>Choose Notebook Folder</Text>
            <Text style={styles.subtitle}>
              Enter the path to your notebook folder. If it doesn't exist, a new notebook will be created.
            </Text>
            <TextInput
              value={notebookPath}
              onChangeText={setNotebookPath}
              placeholder="/path/to/my-notebook"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={[styles.primaryBtn, !notebookPath.trim() && styles.disabledBtn]}
              onPress={handleChooseFolder}
              disabled={!notebookPath.trim()}
            >
              <Text style={styles.primaryBtnText}>Open / Create Notebook</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'notebook-title' && (
          <>
            <Text style={styles.title}>Name Your Notebook</Text>
            <Text style={styles.subtitle}>
              No notebook found at "{notebookPath}". Enter a name to create a new one.
            </Text>
            <TextInput
              value={notebookTitle}
              onChangeText={setNotebookTitle}
              placeholder="My Notebook"
              style={styles.input}
              autoFocus
            />
            <TouchableOpacity
              style={[styles.primaryBtn, !notebookTitle.trim() && styles.disabledBtn]}
              onPress={handleCreateNotebook}
              disabled={!notebookTitle.trim()}
            >
              <Text style={styles.primaryBtnText}>Create Notebook</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { flexGrow: 1, alignItems: 'center', padding: 24, gap: 16, paddingTop: 48 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 },
  loadingText: { color: '#57606a', fontSize: 15 },
  title: { fontSize: 22, fontWeight: '700', color: '#24292e', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#57606a', textAlign: 'center', paddingHorizontal: 8 },
  option: { width: '100%', flexDirection: 'row', alignItems: 'center', padding: 16, borderWidth: 1, borderColor: '#d0d7de', borderRadius: 10, gap: 12, backgroundColor: '#f6f8fa' },
  optionIcon: { fontSize: 28 },
  optionText: { flex: 1 },
  optionLabel: { fontSize: 16, fontWeight: '600', color: '#24292e' },
  optionDesc: { fontSize: 13, color: '#57606a', marginTop: 2 },
  input: { width: '100%', borderWidth: 1, borderColor: '#d0d7de', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#24292e' },
  primaryBtn: { width: '100%', backgroundColor: '#0969da', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  disabledBtn: { backgroundColor: '#8c8c8c' },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
