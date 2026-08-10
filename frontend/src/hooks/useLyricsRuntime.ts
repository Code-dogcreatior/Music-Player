import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { findActiveLyricIndexByTime } from "../lyrics";
import type { LyricLine, LyricsDisplayMode } from "../types";

const LYRICS_SWITCH_LEAD_SEC = 0.1;

type PerfStats = {
  startedAt: number;
  frameCount: number;
  droppedFrameCount: number;
  maxFrameDeltaMs: number;
  frameDeltaSumMs: number;
  lyricSwitchCount: number;
  lyricDelaySumMs: number;
  lyricDelayMaxMs: number;
  scrollCount: number;
  scrollDurationSumMs: number;
  scrollDurationMaxMs: number;
};

type UseLyricsRuntimeOptions = {
  audioRef: RefObject<HTMLAudioElement | null>;
  isOverlayMounted: boolean;
  isPlayerExpanded: boolean;
  lyricsPanelVisible: boolean;
  lyricsDisplayMode: LyricsDisplayMode;
  translationVisible: boolean;
  showFpsDebug: boolean;
};

function createPerfStats(): PerfStats {
  return {
    startedAt: performance.now(),
    frameCount: 0,
    droppedFrameCount: 0,
    maxFrameDeltaMs: 0,
    frameDeltaSumMs: 0,
    lyricSwitchCount: 0,
    lyricDelaySumMs: 0,
    lyricDelayMaxMs: 0,
    scrollCount: 0,
    scrollDurationSumMs: 0,
    scrollDurationMaxMs: 0,
  };
}

function formatDebugNumber(value: number, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

export function useLyricsRuntime({
  audioRef,
  isOverlayMounted,
  isPlayerExpanded,
  lyricsPanelVisible,
  lyricsDisplayMode,
  translationVisible,
  showFpsDebug,
}: UseLyricsRuntimeOptions) {
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [activeLyricIndex, setActiveLyricIndex] = useState(-1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [, setPerfText] = useState("");
  const lyricsDisplayModeRef = useRef(lyricsDisplayMode);

  const lyricsRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const lyricsContainerRef = useRef<HTMLDivElement | null>(null);
  const lyricsInnerRef = useRef<HTMLDivElement | null>(null);
  const overlayProgressRef = useRef<HTMLDivElement | null>(null);
  const overlayProgressFillRef = useRef<HTMLDivElement | null>(null);
  const playerTimeRef = useRef<HTMLSpanElement | null>(null);
  const overlayCurrentTimeRef = useRef<HTMLSpanElement | null>(null);
  const overlayDurationTimeRef = useRef<HTMLSpanElement | null>(null);
  const fpsDebugHudRef = useRef<HTMLDivElement | null>(null);
  const fpsDebugRafRef = useRef<number | null>(null);
  const lyricScrollRafRef = useRef<number | null>(null);
  const activeLyricIndexRef = useRef(-1);
  const lyricsRef = useRef<LyricLine[]>([]);
  const lyricScrollStartMsRef = useRef(0);
  const lyricSwitchTimerRef = useRef<number | null>(null);
  const scheduleNextLyricSwitchRef = useRef<() => void>(() => undefined);
  const playbackRafRef = useRef<number | null>(null);
  const playbackSmoothRef = useRef<{ lastRaw: number; perfOrigin: number; timeOrigin: number } | null>(null);
  const perfFlushIntervalRef = useRef<number | null>(null);
  const lyricLayoutMeasureRafRef = useRef<number | null>(null);
  const lyricLineCentersRef = useRef<Record<number, number>>({});
  const lyricsViewportHeightRef = useRef(0);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const scrollLastTickMsRef = useRef(0);
  const perfRef = useRef<PerfStats>(createPerfStats());

  const formatTime = useCallback((sec: number): string => {
    if (!Number.isFinite(sec) || sec < 0) return "00:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, []);

  const modeLabelText = useCallback(
    () => (lyricsDisplayModeRef.current === "performance" ? "（歌词：性能版）" : "（歌词：满血版）"),
    [],
  );

  const writePlaybackClock = useCallback(
    (timeSec = currentTimeRef.current, durationSec = durationRef.current) => {
      const safeTime = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
      const safeDuration = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
      const pairText = `${formatTime(safeTime)} / ${formatTime(safeDuration)}`;
      if (playerTimeRef.current) playerTimeRef.current.textContent = pairText;
      if (overlayCurrentTimeRef.current) overlayCurrentTimeRef.current.textContent = formatTime(safeTime);
      if (overlayDurationTimeRef.current) overlayDurationTimeRef.current.textContent = formatTime(safeDuration);
      if (overlayProgressFillRef.current) {
        const frac = safeDuration > 0 ? Math.min(1, safeTime / safeDuration) : 0;
        overlayProgressFillRef.current.style.transform = `scaleX(${frac})`;
      }
    },
    [formatTime],
  );

  const setPlaybackClock = useCallback(
    (timeSec: number, shouldRender = false) => {
      currentTimeRef.current = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
      writePlaybackClock(currentTimeRef.current, durationRef.current);
      if (shouldRender) setCurrentTime(currentTimeRef.current);
    },
    [writePlaybackClock],
  );

  const setPlaybackDuration = useCallback(
    (durationSec: number) => {
      durationRef.current = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
      setDuration(durationRef.current);
      writePlaybackClock(currentTimeRef.current, durationRef.current);
    },
    [writePlaybackClock],
  );

  const resetPlaybackSmooth = useCallback((anchorSec: number) => {
    const now = performance.now();
    const a = anchorSec;
    playbackSmoothRef.current = { lastRaw: a, perfOrigin: now, timeOrigin: a };
  }, []);

  const getSmoothedPlaybackDisplayTime = useCallback(
    (rawSec: number, durationSec: number): number => {
      const raw = Number.isFinite(rawSec) ? Math.max(0, rawSec) : 0;
      const dur = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
      const now = performance.now();
      const rate = audioRef.current?.playbackRate ?? 1;

      let st = playbackSmoothRef.current;
      if (!st) {
        st = { lastRaw: raw, perfOrigin: now, timeOrigin: raw };
        playbackSmoothRef.current = st;
        return dur > 0 ? Math.min(raw, dur) : raw;
      }

      const moved = Math.abs(raw - st.lastRaw) > 1e-4;
      if (moved) {
        st.timeOrigin = raw;
        st.perfOrigin = now;
        st.lastRaw = raw;
      }

      let t = st.timeOrigin + ((now - st.perfOrigin) / 1000) * rate;
      if (dur > 0) t = Math.min(t, dur);
      if (!moved) t = Math.min(t, raw + 0.1);
      return t;
    },
    [audioRef],
  );

  const measureLyricLayout = useCallback(() => {
    const container = lyricsContainerRef.current;
    if (!container || container.clientHeight <= 0) return false;
    lyricsViewportHeightRef.current = container.clientHeight;
    const nextCenters: Record<number, number> = {};
    Object.entries(lyricsRefs.current).forEach(([key, element]) => {
      if (!element) return;
      nextCenters[Number(key)] = element.offsetTop + element.offsetHeight / 2;
    });
    lyricLineCentersRef.current = nextCenters;
    return Object.keys(nextCenters).length > 0;
  }, []);

  const queueLyricLayoutMeasure = useCallback(() => {
    if (lyricLayoutMeasureRafRef.current !== null) {
      cancelAnimationFrame(lyricLayoutMeasureRafRef.current);
    }
    lyricLayoutMeasureRafRef.current = requestAnimationFrame(() => {
      lyricLayoutMeasureRafRef.current = null;
      measureLyricLayout();
    });
  }, [measureLyricLayout]);

  const scrollActiveLyricIntoView = useCallback(
    (options?: { instant?: boolean; forceMeasure?: boolean }) => {
      const container = lyricsContainerRef.current;
      const inner = lyricsInnerRef.current;
      const idx = activeLyricIndexRef.current;
      if (!container || !inner) return false;
      if (idx < 0) {
        inner.style.transition = "none";
        inner.style.transform = "translate3d(0, 0, 0)";
        return true;
      }
      if (options?.forceMeasure || typeof lyricLineCentersRef.current[idx] !== "number") {
        if (!measureLyricLayout()) return false;
      }
      const viewportHeight = lyricsViewportHeightRef.current || container.clientHeight;
      if (viewportHeight <= 0) return false;
      const activeCenter = lyricLineCentersRef.current[idx];
      if (typeof activeCenter !== "number") return false;
      const desiredY = viewportHeight / 2 - activeCenter;

      if (lyricScrollRafRef.current) {
        cancelAnimationFrame(lyricScrollRafRef.current);
        lyricScrollRafRef.current = null;
      }

      const instant = options?.instant === true;
      const startMs = performance.now();
      lyricScrollStartMsRef.current = startMs;
      scrollLastTickMsRef.current = startMs;
      const durationMs = instant ? 0 : lyricsDisplayModeRef.current === "performance" ? 420 : 520;
      const easing = "cubic-bezier(0.16, 1, 0.3, 1)";

      if (instant) {
        inner.style.transition = "none";
        inner.style.transform = `translate3d(0, ${desiredY}px, 0)`;
        void inner.offsetHeight;
        return true;
      }

      inner.style.transition = `transform ${durationMs}ms ${easing}`;
      inner.style.transform = `translate3d(0, ${desiredY}px, 0)`;

      const tick = (now: number) => {
        const perf = perfRef.current;
        const tickDelta = now - scrollLastTickMsRef.current;
        scrollLastTickMsRef.current = now;
        perf.frameCount += 1;
        perf.frameDeltaSumMs += tickDelta;
        perf.maxFrameDeltaMs = Math.max(perf.maxFrameDeltaMs, tickDelta);
        if (tickDelta > 30) perf.droppedFrameCount += 1;

        const progress = Math.min(1, (now - startMs) / durationMs);
        if (progress >= 1) {
          const cost = performance.now() - lyricScrollStartMsRef.current;
          perf.scrollCount += 1;
          perf.scrollDurationSumMs += cost;
          perf.scrollDurationMaxMs = Math.max(perf.scrollDurationMaxMs, cost);
          lyricScrollRafRef.current = null;
          return;
        }
        lyricScrollRafRef.current = requestAnimationFrame(tick);
      };
      lyricScrollRafRef.current = requestAnimationFrame(tick);
      return true;
    },
    [measureLyricLayout],
  );

  const cancelLyricSchedule = useCallback(() => {
    if (lyricSwitchTimerRef.current !== null) {
      window.clearTimeout(lyricSwitchTimerRef.current);
      lyricSwitchTimerRef.current = null;
    }
  }, []);

  const scheduleNextLyricSwitch = useCallback(() => {
    cancelLyricSchedule();
    const audio = audioRef.current;
    if (!audio) return;
    const list = lyricsRef.current;
    if (!list.length) return;
    const cur = audio.currentTime || 0;
    const visualTime = cur + LYRICS_SWITCH_LEAD_SEC;
    const idx = findActiveLyricIndexByTime(visualTime, list);
    if (idx !== activeLyricIndexRef.current) {
      if (idx >= 0 && idx < list.length) {
        const delayMs = Math.abs(visualTime - list[idx].time) * 1000;
        const perf = perfRef.current;
        perf.lyricSwitchCount += 1;
        perf.lyricDelaySumMs += delayMs;
        perf.lyricDelayMaxMs = Math.max(perf.lyricDelayMaxMs, delayMs);
      }
      setActiveLyricIndex(idx);
    }
    if (audio.paused || audio.ended) return;

    const nextIdx = idx + 1;
    if (nextIdx >= list.length) return;
    const rate = audio.playbackRate || 1;
    const waitSec = (list[nextIdx].time - LYRICS_SWITCH_LEAD_SEC - cur) / rate;
    if (waitSec <= 0) {
      lyricSwitchTimerRef.current = window.setTimeout(() => scheduleNextLyricSwitchRef.current(), 16);
      return;
    }
    const waitMs = Math.max(16, Math.min(60_000, waitSec * 1000));
    lyricSwitchTimerRef.current = window.setTimeout(() => scheduleNextLyricSwitchRef.current(), waitMs);
  }, [audioRef, cancelLyricSchedule]);

  useEffect(() => {
    scheduleNextLyricSwitchRef.current = scheduleNextLyricSwitch;
  }, [scheduleNextLyricSwitch]);

  const resetPerfStats = useCallback(() => {
    perfRef.current = createPerfStats();
  }, []);

  const flushPerfStats = useCallback(
    (tag: string) => {
      const perf = perfRef.current;
      if (!perf.startedAt) return;
      const avgFrameDelta = perf.frameCount > 0 ? perf.frameDeltaSumMs / perf.frameCount : 0;
      const avgFps = avgFrameDelta > 0 ? 1000 / avgFrameDelta : 0;
      const avgLyricDelay = perf.lyricSwitchCount > 0 ? perf.lyricDelaySumMs / perf.lyricSwitchCount : 0;
      const avgScrollMs = perf.scrollCount > 0 ? perf.scrollDurationSumMs / perf.scrollCount : 0;
      const summary = `[歌词性能] ${tag} 滚动FPS≈${avgFps.toFixed(1)} 掉帧=${perf.droppedFrameCount} 切句延迟均值=${avgLyricDelay.toFixed(0)}ms 滚动均值=${avgScrollMs.toFixed(0)}ms${modeLabelText()}`;
      setPerfText(summary);
      console.log(summary);
    },
    [modeLabelText],
  );

  const startLyricsRuntime = useCallback(() => {
    resetPerfStats();
    const a0 = audioRef.current;
    if (a0 && !a0.paused) resetPlaybackSmooth(a0.currentTime || 0);
    const tickPlayback = () => {
      playbackRafRef.current = null;
      const a = audioRef.current;
      if (!a || a.paused || a.ended) return;
      const nextTime = a.currentTime || 0;
      currentTimeRef.current = nextTime;
      const dur = durationRef.current || a.duration || 0;
      const displayTime = getSmoothedPlaybackDisplayTime(nextTime, dur);
      writePlaybackClock(displayTime, dur);
      playbackRafRef.current = requestAnimationFrame(tickPlayback);
    };
    if (playbackRafRef.current === null) {
      playbackRafRef.current = requestAnimationFrame(tickPlayback);
    }
    scheduleNextLyricSwitch();
  }, [audioRef, getSmoothedPlaybackDisplayTime, resetPerfStats, resetPlaybackSmooth, scheduleNextLyricSwitch, writePlaybackClock]);

  const stopLyricsRuntime = useCallback(
    (tag: string) => {
      cancelLyricSchedule();
      playbackSmoothRef.current = null;
      if (playbackRafRef.current !== null) {
        cancelAnimationFrame(playbackRafRef.current);
        playbackRafRef.current = null;
      }
      if (perfFlushIntervalRef.current !== null) {
        window.clearInterval(perfFlushIntervalRef.current);
        perfFlushIntervalRef.current = null;
      }
      flushPerfStats(tag);
    },
    [cancelLyricSchedule, flushPerfStats],
  );

  const seekToTime = useCallback(
    (timeSec: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const safe = Math.max(0, timeSec);
      audio.currentTime = safe;
      resetPlaybackSmooth(safe);
      setPlaybackClock(safe, true);
    },
    [audioRef, resetPlaybackSmooth, setPlaybackClock],
  );

  const seekByProgressClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const track = overlayProgressRef.current;
      if (!track || !duration || duration <= 0) return;
      const rect = track.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, offsetX / rect.width));
      seekToTime(duration * ratio);
    },
    [duration, seekToTime],
  );

  const registerLyricRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) lyricsRefs.current[index] = el;
    else delete lyricsRefs.current[index];
  }, []);

  useEffect(() => {
    lyricsDisplayModeRef.current = lyricsDisplayMode;
  }, [lyricsDisplayMode]);

  useEffect(() => {
    writePlaybackClock(currentTimeRef.current, durationRef.current || duration);
  });

  useEffect(() => {
    if (!isOverlayMounted) return;
    lyricLineCentersRef.current = {};
    queueLyricLayoutMeasure();
    const handleResize = () => queueLyricLayoutMeasure();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (lyricLayoutMeasureRafRef.current !== null) {
        cancelAnimationFrame(lyricLayoutMeasureRafRef.current);
        lyricLayoutMeasureRafRef.current = null;
      }
    };
  }, [isOverlayMounted, lyrics, queueLyricLayoutMeasure, translationVisible]);

  useEffect(() => {
    if (!isOverlayMounted || !showFpsDebug) return;

    const deltas: number[] = [];
    let startedAt = 0;
    let lastFrameAt = 0;
    let lastReportAt = 0;
    let reportFrames = 0;
    let totalFrames = 0;
    let drop60 = 0;
    let drop120 = 0;
    let maxDelta = 0;
    let liveFps = 0;

    const writeHud = (now: number) => {
      const hud = fpsDebugHudRef.current;
      if (!hud || !startedAt) return;
      const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
      const avgFps = totalFrames / elapsedSec;
      const sorted = [...deltas].sort((a, b) => a - b);
      const p99Delta = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : 0;
      const low1 = p99Delta > 0 ? 1000 / p99Delta : 0;
      const perf = perfRef.current;
      const avgScrollMs = perf.scrollCount > 0 ? perf.scrollDurationSumMs / perf.scrollCount : 0;
      const avgLyricDelay = perf.lyricSwitchCount > 0 ? perf.lyricDelaySumMs / perf.lyricSwitchCount : 0;
      hud.innerHTML = `
        <strong>FPS Debug · ${lyricsDisplayModeRef.current === "performance" ? "残血" : "满血"}</strong>
        <span>live ${formatDebugNumber(liveFps)} / avg ${formatDebugNumber(avgFps)} / 1% ${formatDebugNumber(low1)}</span>
        <span>max ${formatDebugNumber(maxDelta, 2)}ms · &gt;16.7 ${drop60} · &gt;8.3 ${drop120}</span>
        <span>切句 ${perf.lyricSwitchCount} · 延迟 ${formatDebugNumber(avgLyricDelay, 0)}ms · 滚动 ${formatDebugNumber(avgScrollMs, 0)}ms</span>
      `;
    };

    const tick = (now: number) => {
      if (!startedAt) {
        startedAt = now;
        lastFrameAt = now;
        lastReportAt = now;
      }

      const delta = now - lastFrameAt;
      lastFrameAt = now;
      if (delta > 0 && delta < 1000) {
        deltas.push(delta);
        if (deltas.length > 600) deltas.shift();
        maxDelta = Math.max(maxDelta, delta);
        if (delta > 16.7) drop60 += 1;
        if (delta > 8.3) drop120 += 1;
      }
      totalFrames += 1;
      reportFrames += 1;

      if (now - lastReportAt >= 1000) {
        liveFps = reportFrames / ((now - lastReportAt) / 1000);
        reportFrames = 0;
        lastReportAt = now;
        writeHud(now);
      }

      fpsDebugRafRef.current = requestAnimationFrame(tick);
    };

    fpsDebugRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (fpsDebugRafRef.current !== null) {
        cancelAnimationFrame(fpsDebugRafRef.current);
        fpsDebugRafRef.current = null;
      }
    };
  }, [isOverlayMounted, showFpsDebug]);

  useEffect(() => {
    activeLyricIndexRef.current = activeLyricIndex;
    if (!lyricsPanelVisible || !isPlayerExpanded) return;
    if (!scrollActiveLyricIntoView({ forceMeasure: true })) {
      queueLyricLayoutMeasure();
      const retryId = window.setTimeout(() => {
        scrollActiveLyricIntoView({ forceMeasure: true });
      }, 32);
      return () => window.clearTimeout(retryId);
    }
  }, [activeLyricIndex, isPlayerExpanded, lyricsPanelVisible, queueLyricLayoutMeasure, scrollActiveLyricIntoView]);

  useEffect(() => {
    lyricsRef.current = lyrics;
    if (lyrics.length === 0) return;
    const audio = audioRef.current;
    if (audio && !audio.paused && !audio.ended) {
      scheduleNextLyricSwitch();
    }
  }, [audioRef, lyrics, scheduleNextLyricSwitch]);

  useEffect(() => {
    if (!isPlayerExpanded) return;
    const list = lyricsRef.current;
    const audio = audioRef.current;
    if (!audio || !list.length) return;
    const idx = findActiveLyricIndexByTime((audio.currentTime || 0) + LYRICS_SWITCH_LEAD_SEC, list);
    if (idx !== activeLyricIndexRef.current) {
      setActiveLyricIndex(idx);
    }
  }, [audioRef, isPlayerExpanded]);

  useEffect(() => {
    if (!isOverlayMounted || !isPlayerExpanded || !lyricsPanelVisible) return;

    const list = lyricsRef.current;
    const audio = audioRef.current;
    if (audio && list.length) {
      const idx = findActiveLyricIndexByTime((audio.currentTime || 0) + LYRICS_SWITCH_LEAD_SEC, list);
      if (idx !== activeLyricIndexRef.current) {
        setActiveLyricIndex(idx);
      }
    }

    let cancelled = false;
    let outerRaf = 0;
    let innerRaf = 0;
    outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        if (cancelled) return;
        scrollActiveLyricIntoView({ instant: true, forceMeasure: true });
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(outerRaf);
      cancelAnimationFrame(innerRaf);
    };
  }, [audioRef, isOverlayMounted, isPlayerExpanded, lyricsPanelVisible, scrollActiveLyricIntoView]);

  useEffect(() => {
    return () => {
      if (lyricScrollRafRef.current) cancelAnimationFrame(lyricScrollRafRef.current);
      if (lyricLayoutMeasureRafRef.current !== null) cancelAnimationFrame(lyricLayoutMeasureRafRef.current);
      if (lyricSwitchTimerRef.current !== null) window.clearTimeout(lyricSwitchTimerRef.current);
      if (playbackRafRef.current !== null) cancelAnimationFrame(playbackRafRef.current);
      if (perfFlushIntervalRef.current !== null) window.clearInterval(perfFlushIntervalRef.current);
    };
  }, []);

  return {
    lyrics,
    setLyrics,
    activeLyricIndex,
    setActiveLyricIndex,
    currentTime,
    duration,
    currentTimeRef,
    durationRef,
    lyricsContainerRef,
    lyricsInnerRef,
    overlayProgressRef,
    overlayProgressFillRef,
    playerTimeRef,
    overlayCurrentTimeRef,
    overlayDurationTimeRef,
    fpsDebugHudRef,
    formatTime,
    setPlaybackClock,
    setPlaybackDuration,
    startLyricsRuntime,
    stopLyricsRuntime,
    scheduleNextLyricSwitch,
    seekToTime,
    seekByProgressClick,
    registerLyricRef,
    resetPlaybackSmooth,
  };
}
