import { useCallback, useEffect, useRef, useState } from "react";

type UseOverlayRuntimeOptions = {
  closeDelayMs?: number;
  effectsDelayMs?: number;
};

export function useOverlayRuntime({ closeDelayMs = 460, effectsDelayMs = 700 }: UseOverlayRuntimeOptions = {}) {
  const [isOverlayMounted, setIsOverlayMounted] = useState(false);
  const [isPlayerExpanded, setIsPlayerExpanded] = useState(false);
  const [areOverlayEffectsReady, setAreOverlayEffectsReady] = useState(false);
  const overlayCloseTimerRef = useRef<number | null>(null);
  const overlayEffectsTimerRef = useRef<number | null>(null);
  const overlayOpenRafRef = useRef<number | null>(null);

  const clearOverlayTimers = useCallback(() => {
    if (overlayCloseTimerRef.current !== null) {
      window.clearTimeout(overlayCloseTimerRef.current);
      overlayCloseTimerRef.current = null;
    }
    if (overlayOpenRafRef.current !== null) {
      cancelAnimationFrame(overlayOpenRafRef.current);
      overlayOpenRafRef.current = null;
    }
    if (overlayEffectsTimerRef.current !== null) {
      window.clearTimeout(overlayEffectsTimerRef.current);
      overlayEffectsTimerRef.current = null;
    }
  }, []);

  const openFullscreenPlayer = useCallback(() => {
    clearOverlayTimers();
    setAreOverlayEffectsReady(false);
    setIsOverlayMounted(true);
    overlayOpenRafRef.current = requestAnimationFrame(() => {
      overlayOpenRafRef.current = null;
      setIsPlayerExpanded(true);
      overlayEffectsTimerRef.current = window.setTimeout(() => {
        setAreOverlayEffectsReady(true);
        overlayEffectsTimerRef.current = null;
      }, effectsDelayMs);
    });
  }, [clearOverlayTimers, effectsDelayMs]);

  const closeFullscreenPlayer = useCallback(() => {
    clearOverlayTimers();
    setAreOverlayEffectsReady(false);
    setIsPlayerExpanded(false);
    overlayCloseTimerRef.current = window.setTimeout(() => {
      setIsOverlayMounted(false);
      overlayCloseTimerRef.current = null;
    }, closeDelayMs);
  }, [clearOverlayTimers, closeDelayMs]);

  useEffect(() => clearOverlayTimers, [clearOverlayTimers]);

  return {
    isOverlayMounted,
    isPlayerExpanded,
    areOverlayEffectsReady,
    openFullscreenPlayer,
    closeFullscreenPlayer,
  };
}
