import React, { useCallback } from 'react';
import { Modal, View, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useSessionStore } from '../../store/session.store';
import { useModalStore } from '../../store/modal.store';
import { ModalHeader } from './ModalHeader';
import { useTheme } from '../../hooks/useTheme';
import { ModalDescriptor } from '../../types/session.types';

// Registry of modal content renderers — add new modal types here
const MODAL_RENDERERS: Record<string, React.ComponentType<{ descriptor: ModalDescriptor }>> = {};

export function registerModalRenderer(
  type: string,
  component: React.ComponentType<{ descriptor: ModalDescriptor }>,
): void {
  MODAL_RENDERERS[type] = component;
}

export function ModalStack() {
  const theme = useTheme();
  const session = useSessionStore((s) => s.getCurrentSession());
  const popModal = useModalStore((s) => s.popModal);

  if (!session) return null;

  const currentTab = session.tabs.find((t) => t.id === session.currentTabId);
  const stack = currentTab?.activeModalStack ?? [];
  const topModal = stack[stack.length - 1];

  if (!topModal) return null;

  const Renderer = MODAL_RENDERERS[topModal.type];
  const hasPrevious = stack.length > 1;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={() => {
        if (topModal.closeable) {
          popModal();
        }
      }}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.sheet, { backgroundColor: theme.colors.background }]}>
          <ModalHeader
            title={topModal.title}
            hasPrevious={hasPrevious}
            closeable={topModal.closeable}
            minimizable={topModal.minimizable}
          />
          <View style={styles.content}>
            {Renderer ? (
              <Renderer descriptor={topModal} />
            ) : (
              // Fallback: unknown modal type
              null
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '90%',
    minHeight: '30%',
  },
  content: {
    flex: 1,
  },
});
