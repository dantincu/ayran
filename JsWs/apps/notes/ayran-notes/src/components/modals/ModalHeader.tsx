import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../hooks/useTheme';
import { useModalStore } from '../../store/modal.store';

interface ModalHeaderProps {
  title: string;
  hasPrevious: boolean;
  closeable: boolean;
  minimizable: boolean;
}

export function ModalHeader({ title, hasPrevious, closeable, minimizable }: ModalHeaderProps) {
  const theme = useTheme();
  const popModal = useModalStore((s) => s.popModal);
  const closeAllModals = useModalStore((s) => s.closeAllModals);
  const minimizeModalStack = useModalStore((s) => s.minimizeModalStack);

  return (
    <View
      style={[
        styles.header,
        { backgroundColor: theme.colors.headerBackground, borderBottomColor: theme.colors.border },
      ]}
    >
      {hasPrevious ? (
        <TouchableOpacity onPress={popModal} style={styles.iconBtn}>
          <Ionicons name="arrow-back" size={22} color={theme.colors.primaryForeground} />
        </TouchableOpacity>
      ) : (
        <View style={styles.placeholder} />
      )}

      <Text style={[styles.title, { color: theme.colors.primaryForeground }]} numberOfLines={1}>
        {title}
      </Text>

      <View style={styles.right}>
        {minimizable && (
          <TouchableOpacity onPress={minimizeModalStack} style={styles.iconBtn}>
            <Ionicons name="remove-outline" size={22} color={theme.colors.primaryForeground} />
          </TouchableOpacity>
        )}
        {closeable && (
          <TouchableOpacity onPress={closeAllModals} style={styles.iconBtn}>
            <Ionicons name="close" size={22} color={theme.colors.primaryForeground} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: {
    padding: 8,
  },
  placeholder: {
    width: 38,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
