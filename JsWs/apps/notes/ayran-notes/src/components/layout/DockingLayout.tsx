import React, { useRef, useState, useCallback } from 'react';
import {
  View,
  StyleSheet,
  PanResponder,
  LayoutChangeEvent,
} from 'react-native';
import { useTheme } from '../../hooks/useTheme';

interface DockingLayoutProps {
  left: React.ReactNode;
  right: React.ReactNode;
  initialRatio?: number; // 0..1, default 0.5
  minRatio?: number;
  maxRatio?: number;
}

export function DockingLayout({
  left,
  right,
  initialRatio = 0.5,
  minRatio = 0.2,
  maxRatio = 0.8,
}: DockingLayoutProps) {
  const theme = useTheme();
  const [ratio, setRatio] = useState(initialRatio);
  const totalWidth = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_, gestureState) => {
        if (totalWidth.current === 0) return;
        const delta = gestureState.dx / totalWidth.current;
        setRatio((prev) => {
          const next = prev + delta;
          return Math.max(minRatio, Math.min(maxRatio, next));
        });
      },
    }),
  ).current;

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    totalWidth.current = event.nativeEvent.layout.width;
  }, []);

  return (
    <View style={styles.container} onLayout={onLayout}>
      <View style={{ flex: ratio }}>{left}</View>
      <View
        style={[styles.divider, { backgroundColor: theme.colors.border }]}
        {...panResponder.panHandlers}
      />
      <View style={{ flex: 1 - ratio }}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
  },
  divider: {
    width: 4,
    cursor: 'col-resize' as any,
  },
});
