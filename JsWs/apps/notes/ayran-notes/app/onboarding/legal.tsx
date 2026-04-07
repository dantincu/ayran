import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSessionStore } from '../../src/store/session.store';
import { TERMS_OF_SERVICE, PRIVACY_POLICY, DATA_NOTICE } from '../../src/legal/legalContent';

type Tab = 'tos' | 'privacy' | 'data';

const TABS: { key: Tab; label: string }[] = [
  { key: 'tos', label: 'Terms' },
  { key: 'privacy', label: 'Privacy' },
  { key: 'data', label: 'Data Notice' },
];

export default function LegalPage() {
  const router = useRouter();
  const acceptLegal = useSessionStore((s) => s.acceptLegal);
  const [activeTab, setActiveTab] = useState<Tab>('tos');
  const [scrolledToBottom, setScrolledToBottom] = useState<Set<Tab>>(new Set());

  const content: Record<Tab, string> = {
    tos: TERMS_OF_SERVICE,
    privacy: PRIVACY_POLICY,
    data: DATA_NOTICE,
  };

  const allRead = scrolledToBottom.size === TABS.length;

  const handleScroll = (event: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const isAtBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 40;
    if (isAtBottom) {
      setScrolledToBottom((prev) => new Set([...prev, activeTab]));
    }
  };

  const handleAccept = () => {
    acceptLegal();
    router.replace('/onboarding/storage-setup');
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="shield-checkmark-outline" size={32} color="#0969da" />
        <Text style={styles.headerTitle}>Before you begin</Text>
        <Text style={styles.headerSubtitle}>
          Please read and accept the legal terms to continue.
        </Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            onPress={() => setActiveTab(tab.key)}
            style={[
              styles.tab,
              activeTab === tab.key && styles.tabActive,
            ]}
          >
            <Text style={[
              styles.tabLabel,
              activeTab === tab.key && styles.tabLabelActive,
            ]}>
              {tab.label}
            </Text>
            {scrolledToBottom.has(tab.key) && (
              <Ionicons name="checkmark-circle" size={14} color="#22c55e" style={{ marginLeft: 4 }} />
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      <ScrollView
        style={styles.scroll}
        onScroll={handleScroll}
        scrollEventThrottle={100}
      >
        <Text style={styles.contentText}>{content[activeTab]}</Text>
      </ScrollView>

      {/* Accept Button */}
      <View style={styles.footer}>
        {!allRead && (
          <Text style={styles.readHint}>
            Please read all documents (scroll to bottom of each) before accepting.
          </Text>
        )}
        <TouchableOpacity
          onPress={handleAccept}
          disabled={!allRead}
          style={[
            styles.acceptBtn,
            !allRead && styles.acceptBtnDisabled,
          ]}
        >
          <Ionicons name="checkmark-circle-outline" size={20} color="#fff" />
          <Text style={styles.acceptBtnText}>Accept & Continue</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: { alignItems: 'center', padding: 24, paddingTop: 40, gap: 8 },
  headerTitle: { fontSize: 22, fontWeight: '700', color: '#24292e' },
  headerSubtitle: { fontSize: 14, color: '#57606a', textAlign: 'center' },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#d0d7de' },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: '#0969da' },
  tabLabel: { fontSize: 14, color: '#57606a', fontWeight: '500' },
  tabLabelActive: { color: '#0969da', fontWeight: '700' },
  scroll: { flex: 1, padding: 16 },
  contentText: { fontSize: 14, color: '#24292e', lineHeight: 22 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: '#d0d7de', gap: 8 },
  readHint: { fontSize: 12, color: '#57606a', textAlign: 'center' },
  acceptBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0969da', paddingVertical: 14, borderRadius: 10, gap: 8 },
  acceptBtnDisabled: { backgroundColor: '#8c8c8c' },
  acceptBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
