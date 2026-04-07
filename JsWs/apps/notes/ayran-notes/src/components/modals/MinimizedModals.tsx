import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Pressable,
  FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useModalStore } from '../../store/modal.store';
import { useTheme } from '../../hooks/useTheme';
import { ModalStack } from '../../types/session.types';

interface MinimizedModalsProps {
  visible: boolean;
  onClose: () => void;
}

export function MinimizedModals({ visible, onClose }: MinimizedModalsProps) {
  const theme = useTheme();
  const minimizedStacks = useModalStore((s) => s.getMinimizedStacks());
  const restoreStack = useModalStore((s) => s.restoreMinimizedStack);
  const closeStack = useModalStore((s) => s.closeMinimizedStack);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleExpand = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <View
          style={[
            styles.popover,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
          ]}
        >
          <Text style={[styles.heading, { color: theme.colors.text }]}>
            Minimized ({minimizedStacks.length})
          </Text>
          <FlatList
            data={minimizedStacks}
            keyExtractor={(_, idx) => String(idx)}
            renderItem={({ item: stack, index }) => {
              const topModal = stack[stack.length - 1];
              const isExpanded = expanded.has(index);
              return (
                <View style={[styles.stackRow, { borderBottomColor: theme.colors.border }]}>
                  <TouchableOpacity
                    style={styles.stackHeader}
                    onPress={() => toggleExpand(index)}
                  >
                    <Text style={[styles.stackTitle, { color: theme.colors.text }]} numberOfLines={1}>
                      {topModal?.title ?? 'Modal'}
                    </Text>
                    <Ionicons
                      name={isExpanded ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color={theme.colors.textSecondary}
                    />
                  </TouchableOpacity>

                  {isExpanded && stack.map((modal, mIdx) => (
                    <Text
                      key={modal.id}
                      style={[styles.modalEntry, { color: theme.colors.textSecondary }]}
                    >
                      {mIdx + 1}. {modal.title}
                    </Text>
                  ))}

                  <View style={styles.stackActions}>
                    <TouchableOpacity
                      onPress={() => { restoreStack(index); onClose(); }}
                      style={[styles.actionBtn, { backgroundColor: theme.colors.primary }]}
                    >
                      <Text style={{ color: theme.colors.primaryForeground, fontSize: 12 }}>Restore</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => closeStack(index)}
                      style={styles.closeBtn}
                    >
                      <Ionicons name="close" size={16} color={theme.colors.danger} />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }}
          />
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 100,
    paddingRight: 8,
  },
  popover: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    minWidth: 260,
    maxWidth: 340,
    maxHeight: 400,
  },
  heading: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  stackRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  stackHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stackTitle: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  modalEntry: {
    fontSize: 12,
    paddingLeft: 8,
    paddingVertical: 2,
  },
  stackActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  closeBtn: {
    padding: 4,
  },
});
