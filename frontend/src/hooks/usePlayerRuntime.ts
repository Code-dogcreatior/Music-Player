import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { API_BASE, requestJson } from "../api";
import { isAudioEffectsUrlAllowed, type AudioEffectsSettings } from "../audioEffects";
import { isSameSong } from "../songUtils";
import type { PlayMode, Song } from "../types";

type AudioEffectsApi = {
  settings: AudioEffectsSettings;
  resumeAudioEffects: (audio: HTMLAudioElement | null) => Promise<boolean>;
  releaseAudioEffects: () => void;
  isAttachedTo: (audio: HTMLAudioElement | null) => boolean;
  setMasterVolume: (nextVolume: number) => void;
  applyWebAudioVolume: (audio: HTMLAudioElement | null, nextVolume: number) => Promise<boolean>;
};

type UsePlayerRuntimeOptions = {
  audioEffects: AudioEffectsApi;
  audioRef: RefObject<HTMLAudioElement | null>;
  visibleSongs: Song[];
  downloadedSongs: Song[];
  songs: Song[];
  saveDir: string;
  currentSong: Song | null;
  currentSongRef: RefObject<Song | null>;
  setCurrentSong: Dispatch<SetStateAction<Song | null>>;
  cancelLyricsRequests: () => void;
  resetTranslationState: () => void;
  loadLyrics: (song: Song) => void | Promise<void>;
  setPlaybackClock: (timeSec: number, shouldRender?: boolean) => void;
  setPlaybackDuration: (durationSec: number) => void;
  startLyricsRuntime: () => void;
  stopLyricsRuntime: (tag: string) => void;
};

export function applyAudioVolume(audio: HTMLAudioElement, nextVolume: number) {
  const safe = Math.max(0, Math.min(100, nextVolume));
  audio.muted = safe <= 0;
  const targetVolume = safe / 100;
  try {
    audio.volume = targetVolume;
    return Math.abs(audio.volume - targetVolume) < 0.01;
  } catch {
    /* Some WebKit targets only allow hardware volume control. */
    return false;
  }
}

export function releaseAudioElementSource(audio: HTMLAudioElement) {
  try {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } catch {
    /* Safari may throw while a media element is being torn down. */
  }
}

function prefersWebAudioVolumeControl(): boolean {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const isTouchIpad = platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const isiOS = /iPad|iPhone|iPod/.test(ua) || isTouchIpad;
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|EdgiOS|OPR|OPiOS/i.test(ua);
  return isiOS || isSafari;
}

export function usePlayerRuntime({
  audioEffects,
  audioRef,
  visibleSongs,
  downloadedSongs,
  songs,
  saveDir,
  currentSong,
  currentSongRef,
  setCurrentSong,
  cancelLyricsRequests,
  resetTranslationState,
  loadLyrics,
  setPlaybackClock,
  setPlaybackDuration,
  startLyricsRuntime,
  stopLyricsRuntime,
}: UsePlayerRuntimeOptions) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [playMode, setPlayMode] = useState<PlayMode>("order");
  const [listLoop, setListLoop] = useState(true);
  const [loopOne, setLoopOne] = useState(false);
  const [volume, setVolume] = useState(100);
  const [audioElementKey, setAudioElementKey] = useState(0);
  const volumeRef = useRef(100);
  const pendingVolumeStateRef = useRef(100);
  const volumeStateRafRef = useRef<number | null>(null);
  const autoResumeAudioEffectsRef = useRef(false);
  const {
    settings: audioEffectsSettings,
    resumeAudioEffects,
    releaseAudioEffects,
    isAttachedTo,
    setMasterVolume,
    applyWebAudioVolume,
  } = audioEffects;
  const proToolsEnabled = audioEffectsSettings.proToolsEnabled;

  const applyRuntimeVolume = useCallback((audio: HTMLAudioElement, nextVolume: number) => {
    const safe = Math.max(0, Math.min(100, nextVolume));
    setMasterVolume(safe);
    if (isAttachedTo(audio)) return;
    if (safe < 100 && prefersWebAudioVolumeControl()) {
      void applyWebAudioVolume(audio, safe).then((ok) => {
        if (!ok) applyAudioVolume(audio, safe);
      }).catch(() => {
        applyAudioVolume(audio, safe);
      });
      return;
    }
    const nativeApplied = applyAudioVolume(audio, safe);
    if (!nativeApplied) {
      void applyWebAudioVolume(audio, safe).catch(() => undefined);
    }
  }, [applyWebAudioVolume, isAttachedTo, setMasterVolume]);

  const ensureAudioEffectsAttached = useCallback(async () => {
    if (autoResumeAudioEffectsRef.current) return;
    if (!proToolsEnabled) return;
    const audio = audioRef.current;
    if (!audio) return;
    const src = audio.currentSrc || audio.src;
    if (!src) return;
    if (!isAudioEffectsUrlAllowed(src)) return;
    if (isAttachedTo(audio)) return;
    autoResumeAudioEffectsRef.current = true;
    try {
      await resumeAudioEffects(audio);
    } finally {
      autoResumeAudioEffectsRef.current = false;
    }
  }, [audioRef, isAttachedTo, proToolsEnabled, resumeAudioEffects]);

  const releaseCurrentAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    releaseAudioElementSource(audio);
    if (isAttachedTo(audio)) {
      releaseAudioEffects();
      setAudioElementKey((prev) => prev + 1);
    }
  }, [audioRef, isAttachedTo, releaseAudioEffects]);

  const clearCurrentPlaybackState = useCallback(
    (tag: string) => {
      releaseCurrentAudio();
      setCurrentSong(null);
      currentSongRef.current = null;
      setIsPlaying(false);
      setPlaybackClock(0, true);
      setPlaybackDuration(0);
      stopLyricsRuntime(tag);
    },
    [currentSongRef, releaseCurrentAudio, setCurrentSong, setPlaybackClock, setPlaybackDuration, stopLyricsRuntime],
  );

  const playSong = useCallback(
    async (song: Song) => {
      const streamUrl = song.stream_url ? `${API_BASE}${song.stream_url}` : song.download_url || "";
      if (!streamUrl) return;
      cancelLyricsRequests();
      resetTranslationState();
      let audio = audioRef.current;
      if (isAttachedTo(audio) && !isAudioEffectsUrlAllowed(streamUrl)) {
        if (audio) releaseAudioElementSource(audio);
        releaseAudioEffects();
        setAudioElementKey((prev) => prev + 1);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        audio = audioRef.current;
      }
      currentSongRef.current = song;
      setCurrentSong(song);
      setPlaybackClock(0, true);
      setPlaybackDuration(0);
      if (!audio) return;
      releaseAudioElementSource(audio);
      audio.src = streamUrl;
      applyRuntimeVolume(audio, volumeRef.current);
      audio.loop = loopOne;
      try {
        await audio.play();
        if (!audio.paused) {
          setIsPlaying(true);
          void ensureAudioEffectsAttached();
          startLyricsRuntime();
        }
      } catch (err) {
        console.error("Failed to play audio:", err);
        setIsPlaying(false);
      }
      void requestJson("/api/play-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ song, save_dir: saveDir }),
        timeoutMs: 8_000,
      }).catch(() => undefined);
      void loadLyrics(song);
    },
    [
      audioRef,
      cancelLyricsRequests,
      currentSongRef,
      ensureAudioEffectsAttached,
      isAttachedTo,
      applyRuntimeVolume,
      loadLyrics,
      loopOne,
      resetTranslationState,
      releaseAudioEffects,
      saveDir,
      setCurrentSong,
      setPlaybackClock,
      setPlaybackDuration,
      startLyricsRuntime,
    ],
  );

  const getCurrentQueueAndIndex = useCallback(
    (song: Song): { queue: Song[]; index: number } | null => {
      const candidates: Song[][] = [visibleSongs, downloadedSongs, songs];
      for (const queue of candidates) {
        if (!queue.length) continue;
        const index = queue.findIndex((item) => isSameSong(item, song));
        if (index >= 0) return { queue, index };
      }
      return null;
    },
    [downloadedSongs, songs, visibleSongs],
  );

  const playNextByMode = useCallback(() => {
    if (!currentSong) return;
    const located = getCurrentQueueAndIndex(currentSong);
    if (!located) return;
    const { queue, index } = located;
    if (queue.length <= 1) return;

    let nextIndex: number;
    if (playMode === "shuffle") {
      do {
        nextIndex = Math.floor(Math.random() * queue.length);
      } while (nextIndex === index && queue.length > 1);
    } else if (index >= queue.length - 1) {
      if (!listLoop) return;
      nextIndex = 0;
    } else {
      nextIndex = index + 1;
    }
    void playSong(queue[nextIndex]);
  }, [currentSong, getCurrentQueueAndIndex, listLoop, playMode, playSong]);

  const playPrevByMode = useCallback(() => {
    if (!currentSong) return;
    const located = getCurrentQueueAndIndex(currentSong);
    if (!located) return;
    const { queue, index } = located;
    if (queue.length <= 1) return;

    let prevIndex: number;
    if (playMode === "shuffle") {
      do {
        prevIndex = Math.floor(Math.random() * queue.length);
      } while (prevIndex === index && queue.length > 1);
    } else if (index <= 0) {
      if (!listLoop) return;
      prevIndex = queue.length - 1;
    } else {
      prevIndex = index - 1;
    }
    void playSong(queue[prevIndex]);
  }, [currentSong, getCurrentQueueAndIndex, listLoop, playMode, playSong]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    applyRuntimeVolume(audio, volumeRef.current);
    if (audio.paused) {
      audio.play().catch((err) => {
        console.error("Failed to play:", err);
        setIsPlaying(false);
      });
    } else {
      audio.pause();
    }
  }, [applyRuntimeVolume, audioRef]);

  const togglePlayMode = useCallback(() => {
    setPlayMode((prev) => (prev === "order" ? "shuffle" : "order"));
  }, []);

  const cycleRepeatMode = useCallback(() => {
    if (!listLoop && !loopOne) {
      setListLoop(true);
      setLoopOne(false);
      if (audioRef.current) audioRef.current.loop = false;
      return;
    }
    if (listLoop && !loopOne) {
      setListLoop(false);
      setLoopOne(true);
      if (audioRef.current) audioRef.current.loop = true;
      return;
    }
    setListLoop(false);
    setLoopOne(false);
    if (audioRef.current) audioRef.current.loop = false;
  }, [audioRef, listLoop, loopOne]);

  const syncVolumeState = useCallback((safeVolume: number) => {
    pendingVolumeStateRef.current = safeVolume;
    if (volumeStateRafRef.current !== null) return;
    volumeStateRafRef.current = requestAnimationFrame(() => {
      volumeStateRafRef.current = null;
      setVolume(pendingVolumeStateRef.current);
    });
  }, []);

  const handleVolumeChange = useCallback((nextVolume: number) => {
    const safe = Math.max(0, Math.min(100, nextVolume));
    volumeRef.current = safe;
    if (audioRef.current) applyRuntimeVolume(audioRef.current, safe);
    syncVolumeState(safe);
  }, [applyRuntimeVolume, audioRef, syncVolumeState]);

  useEffect(() => {
    if (!proToolsEnabled) return;
    if (!isPlaying) return;
    void ensureAudioEffectsAttached();
  }, [audioElementKey, currentSong, ensureAudioEffectsAttached, isPlaying, proToolsEnabled]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (!audio) return;
      releaseAudioElementSource(audio);
      if (isAttachedTo(audio)) releaseAudioEffects();
    };
  }, [audioElementKey, audioRef, isAttachedTo, releaseAudioEffects]);

  useEffect(() => {
    return () => {
      if (volumeStateRafRef.current !== null) {
        cancelAnimationFrame(volumeStateRafRef.current);
        volumeStateRafRef.current = null;
      }
    };
  }, []);

  return {
    audioRef,
    audioElementKey,
    isPlaying,
    setIsPlaying,
    playMode,
    listLoop,
    loopOne,
    volume,
    ensureAudioEffectsAttached,
    releaseCurrentAudio,
    clearCurrentPlaybackState,
    playSong,
    playNextByMode,
    playPrevByMode,
    togglePlay,
    togglePlayMode,
    cycleRepeatMode,
    handleVolumeChange,
  };
}
