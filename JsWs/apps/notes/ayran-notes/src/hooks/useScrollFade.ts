import { useRef, useCallback } from 'react';
import { Animated, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

const FADE_THRESHOLD = 10;

export interface ScrollFadeResult {
  headerOpacity: Animated.Value;
  footerOpacity: Animated.Value;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}

export function useScrollFade(): ScrollFadeResult {
  const headerOpacity = useRef(new Animated.Value(1)).current;
  const footerOpacity = useRef(new Animated.Value(0)).current;
  const lastScrollY = useRef(0);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const currentY = event.nativeEvent.contentOffset.y;
      const delta = currentY - lastScrollY.current;
      lastScrollY.current = currentY;

      if (delta > FADE_THRESHOLD) {
        // Scrolling down: fade out header, fade in footer
        Animated.parallel([
          Animated.timing(headerOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
          Animated.timing(footerOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        ]).start();
      } else if (delta < -FADE_THRESHOLD) {
        // Scrolling up: fade in header, fade out footer
        Animated.parallel([
          Animated.timing(headerOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
          Animated.timing(footerOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
        ]).start();
      }
    },
    [headerOpacity, footerOpacity],
  );

  return { headerOpacity, footerOpacity, onScroll };
}
