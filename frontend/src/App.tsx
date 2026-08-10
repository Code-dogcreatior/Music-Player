import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { IoMenu } from "react-icons/io5";
import { isAbortError, requestJson, SEARCH_TYPE_SONG } from "./api";
import { useAudioEffects } from "./audioEffects";
import { FullscreenPlayer, type OverlayRightPanel } from "./components/FullscreenPlayer";
import { PlayerBar } from "./components/PlayerBar";
import { SearchToolbar } from "./components/SearchToolbar";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { SongTable } from "./components/SongTable";
import { useBlurredOverlayCover } from "./coverBlur";
import { mergeTranslatedLrc, parseLrc, shouldOfferChineseTranslation } from "./lyrics";
import {
  cancelController,
  downloadToastTitle,
  nextController,
  useAsyncJobs,
  waitForMsOrAbort,
  type SearchJobResponse,
} from "./hooks/useAsyncJobs";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { useLyricsRuntime } from "./hooks/useLyricsRuntime";
import { useOverlayRuntime } from "./hooks/useOverlayRuntime";
import { usePlayerRuntime } from "./hooks/usePlayerRuntime";
import { getCoverUrl, isSameSong } from "./songUtils";
import type { ActiveView, LyricsDisplayMode, Song, TranslateProvider } from "./types";

/** 与 index.css 中窄屏布局断点一致 */
const NARROW_LAYOUT_QUERY = "(max-width: 840px)";

const LYRICS_MODE_STORAGE_KEY = "music-player-lyrics-display-mode";
const TRANSLATE_PROVIDER_STORAGE_KEY = "music-player-translate-provider";
const SHOW_FPS_DEBUG_STORAGE_KEY = "music-player-show-fps-debug";

type LyricsResponse = {
  lyrics?: string;
  translated_lyrics?: string;
  detail?: string;
};

type LyricsTranslateResponse = {
  job_id?: string;
  status?: string;
  percent?: number;
  translated_lyrics?: string;
  error?: string;
  message?: string;
  detail?: string;
};

function readStoredLyricsDisplayMode(): LyricsDisplayMode {
  try {
    const raw = localStorage.getItem(LYRICS_MODE_STORAGE_KEY);
    if (raw === "performance" || raw === "full") return raw;
  } catch {
    /* ignore */
  }
  return "full";
}

function readStoredTranslateProvider(): TranslateProvider {
  try {
    return localStorage.getItem(TRANSLATE_PROVIDER_STORAGE_KEY) === "ali" ? "ali" : "dp";
  } catch {
    return "dp";
  }
}

function readStoredShowFpsDebug(): boolean {
  try {
    const raw = localStorage.getItem(SHOW_FPS_DEBUG_STORAGE_KEY);
    if (raw === null) return false;
    return raw === "1";
  } catch {
    return false;
  }
}

function App() {
  const appUpdate = useAppUpdate();
  const [sources, setSources] = useState<Record<string, string>>({});
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [keyword, setKeyword] = useState("");
  const [limit, setLimit] = useState(10);
  const [saveDir, setSaveDir] = useState("");
  const [songs, setSongs] = useState<Song[]>([]);
  const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(new Set());
  const [jobId, setJobId] = useState("");
  const [loading, setLoading] = useState(false);
  const [searchJobId, setSearchJobId] = useState("");
  const [activeView, setActiveView] = useState<ActiveView>("search");
  const [downloadedLibrarySongs, setDownloadedLibrarySongs] = useState<Song[]>([]);
  const [downloadedSongs, setDownloadedSongs] = useState<Song[]>([]);
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const currentSongRef = useRef<Song | null>(null);
  const [lyricsDisplayMode, setLyricsDisplayMode] = useState<LyricsDisplayMode>(readStoredLyricsDisplayMode);
  const [translationOffered, setTranslationOffered] = useState(false);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationProgressPercent, setTranslationProgressPercent] = useState(0);
  const [translationVisible, setTranslationVisible] = useState(true);
  const [translateProvider, setTranslateProvider] = useState<TranslateProvider>(readStoredTranslateProvider);
  const [showFpsDebug, setShowFpsDebug] = useState(readStoredShowFpsDebug);
  const [showSourceColumns, setShowSourceColumns] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_LAYOUT_QUERY).matches,
  );
  /** 窄屏下侧栏抽屉：默认收起，展开时曲库区域压暗 */
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  /** 宽屏时保留一条紧凑导航轨，便于随时重新展开侧栏。 */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [overlayRightPanel, setOverlayRightPanel] = useState<OverlayRightPanel>("lyrics");
  const lyricsAbortRef = useRef<AbortController | null>(null);
  const translationAbortRef = useRef<AbortController | null>(null);
  const translationTaskActiveRef = useRef(false);
  const lyricsRequestSeqRef = useRef(0);
  const translationRequestSeqRef = useRef(0);
  const visibleSongs = useMemo(
    () =>
      activeView === "search" ? songs : activeView === "downloaded" ? downloadedSongs : [],
    [activeView, downloadedSongs, songs],
  );
  const audioEffects = useAudioEffects(activeView === "settings");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const {
    isOverlayMounted,
    isPlayerExpanded,
    areOverlayEffectsReady,
    openFullscreenPlayer,
    closeFullscreenPlayer,
  } = useOverlayRuntime();
  const lyricsRuntime = useLyricsRuntime({
    audioRef,
    isOverlayMounted,
    isPlayerExpanded,
    lyricsPanelVisible: overlayRightPanel === "lyrics",
    lyricsDisplayMode,
    translationVisible,
    showFpsDebug,
  });
  const {
    downloadToast,
    showDownloadToast,
    hideDownloadToast,
    searchSubmitLockRef,
    downloadToastDismissedRef,
    cancelSearchPoll,
  } = useAsyncJobs({
    jobId,
    setJobId,
    searchJobId,
    setSearchJobId,
    setSongs,
    setSelectedIndexes,
    setLoading,
  });
  const {
    lyrics,
    setLyrics,
    activeLyricIndex,
    setActiveLyricIndex,
    currentTime,
    duration,
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
  } = lyricsRuntime;

  const cancelLyricsRequests = useCallback(() => {
    cancelController(lyricsAbortRef);
    cancelController(translationAbortRef);
    lyricsRequestSeqRef.current += 1;
    translationRequestSeqRef.current += 1;
    translationTaskActiveRef.current = false;
  }, []);

  const resetTranslationState = useCallback(() => {
    setTranslationLoading(false);
    setTranslationProgressPercent(0);
  }, []);

  useEffect(() => {
    return () => {
      cancelController(lyricsAbortRef);
      cancelController(translationAbortRef);
    };
  }, []);

  useEffect(() => {
    currentSongRef.current = currentSong;
  }, [currentSong]);

  useEffect(() => {
    const mq = window.matchMedia(NARROW_LAYOUT_QUERY);
    const sync = () => {
      const narrow = mq.matches;
      setIsNarrowViewport(narrow);
      if (!narrow) setNarrowSidebarOpen(false);
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!isNarrowViewport || !narrowSidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNarrowSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isNarrowViewport, narrowSidebarOpen]);

  useEffect(() => {
    if (!isNarrowViewport || !narrowSidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isNarrowViewport, narrowSidebarOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(LYRICS_MODE_STORAGE_KEY, lyricsDisplayMode);
    } catch {
      /* ignore */
    }
  }, [lyricsDisplayMode]);

  useEffect(() => {
    try {
      localStorage.setItem(TRANSLATE_PROVIDER_STORAGE_KEY, translateProvider);
    } catch {
      /* ignore */
    }
  }, [translateProvider]);

  useEffect(() => {
    try {
      localStorage.setItem(SHOW_FPS_DEBUG_STORAGE_KEY, showFpsDebug ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [showFpsDebug]);

  const loadConfig = useCallback(async () => {
    try {
      const { data } = await requestJson<{ default_save_dir?: string }>("/api/config", { timeoutMs: 8_000 });
      if (data.default_save_dir) setSaveDir(String(data.default_save_dir));
    } catch {
      // ignore
    }
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const { data } = await requestJson<{ sources?: Record<string, string> }>("/api/sources", { timeoutMs: 8_000 });
      const sourceMap = (data.sources ?? {}) as Record<string, string>;
      setSources(sourceMap);

      // 单选模式：默认使用后端综合排序的第一项。
      const firstSource = Object.values(sourceMap)[0];
      if (firstSource) {
        setSelectedSources([firstSource]);
      }
    } catch {
      /* backend may be unavailable during startup */
    }
  }, []);

  const loadUiSettings = useCallback(async () => {
    try {
      const { data } = await requestJson<{ show_source_columns?: boolean }>("/api/ui-settings", { timeoutMs: 8_000 });
      setShowSourceColumns(Boolean(data.show_source_columns));
    } catch {
      /* keep defaults */
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConfig();
      void loadSources();
      void loadUiSettings();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConfig, loadSources, loadUiSettings]);

  async function updateShowSourceColumns(value: boolean) {
    setShowSourceColumns(value);
    try {
      await requestJson("/api/ui-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ show_source_columns: value }),
        timeoutMs: 8_000,
      });
    } catch {
      setShowSourceColumns(!value);
    }
  }

  async function onSearch() {
    if (activeView === "settings") return;
    if (searchSubmitLockRef.current) return;
    if (activeView === "downloaded") {
      searchSubmitLockRef.current = true;
      const kw = keyword.trim().toLowerCase();
      try {
        setSelectedIndexes(new Set());
        if (!kw) {
          setDownloadedSongs(downloadedLibrarySongs);
          return;
        }
        const filtered = downloadedLibrarySongs.filter((song) => {
          const haystack = [
            song.song_name || "",
            Array.isArray(song.singers) ? song.singers.join(" ") : String(song.singers || ""),
            song.album || "",
            song.relative_path || "",
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(kw);
        });
        setDownloadedSongs(filtered);
      } finally {
        searchSubmitLockRef.current = false;
      }
      return;
    }
    if (!keyword.trim()) return;
    searchSubmitLockRef.current = true;
    setLoading(true);
    setSearchJobId("");
    cancelSearchPoll();
    setSongs([]);
    setSelectedIndexes(new Set());
    try {
      const { data } = await requestJson<SearchJobResponse>("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword,
          search_type: SEARCH_TYPE_SONG,
          selected_sources: selectedSources,
          limit,
          save_dir: saveDir,
        }),
        timeoutMs: 15_000,
      });
      const searchSongs = (data.songs ?? []) as Song[];
      setSongs(searchSongs);
      setSelectedIndexes(new Set());
      if (data.job_id && data.status !== "finished" && !data.cached) {
        setSearchJobId(data.job_id);
        return;
      }
      setLoading(false);
      searchSubmitLockRef.current = false;
    } catch {
      setLoading(false);
      searchSubmitLockRef.current = false;
    }
  }

  async function loadDownloadedSongs() {
    try {
      const query = new URLSearchParams({ save_dir: saveDir });
      const { data } = await requestJson<{ items?: Song[] }>(`/api/downloaded?${query.toString()}`, {
        timeoutMs: 20_000,
      });
      const localSongs = data.items ?? [];
      setDownloadedLibrarySongs(localSongs);
      setDownloadedSongs(localSongs);
      changeActiveView("downloaded");
    } catch {
      /* keep current local list */
    }
  }

  async function onDownload() {
    const selectedSongs = visibleSongs.filter((_, index) => selectedIndexes.has(index));
    if (selectedSongs.length === 0) return;
    downloadToastDismissedRef.current = false;
    showDownloadToast({
      status: "queued",
      title: downloadToastTitle("queued"),
      detail: `准备下载 ${selectedSongs.length} 首`,
      percent: 0,
    });
    try {
      const { data } = await requestJson<{ job_id?: string }>("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          songs: selectedSongs,
          selected_sources: selectedSources,
          limit,
          save_dir: saveDir,
        }),
        timeoutMs: 15_000,
      });
      setJobId(data.job_id || "");
    } catch {
      downloadToastDismissedRef.current = false;
      showDownloadToast(
        {
          status: "failed",
          title: downloadToastTitle("failed"),
          detail: "下载请求发送失败",
          percent: 0,
        },
        5200,
      );
    }
  }

  async function deleteLocalSong(song: Song) {
    const filePath = song.file_path;
    if (!filePath) {
      return;
    }
    const confirmed = window.confirm(`确定删除「${song.song_name || "这首歌曲"}」吗？`);
    if (!confirmed) return;

    const deletingCurrentSong = currentSong && isSameSong(song, currentSong);

    try {
      await requestJson("/api/downloaded/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_paths: [filePath], save_dir: saveDir }),
        timeoutMs: 15_000,
      });
      setSelectedIndexes(new Set());

      if (deletingCurrentSong) {
        clearCurrentPlaybackState("deleted");
      }

      await loadDownloadedSongs();
    } catch {
      /* keep current local list */
    }
  }

  const loadLyrics = useCallback(async (song: Song, translateToChinese = false) => {
    const requestSeq = lyricsRequestSeqRef.current + 1;
    lyricsRequestSeqRef.current = requestSeq;
    const controller = nextController(lyricsAbortRef);
    const inlineLyrics = song.lyrics || song.lyric;
    const lrcUrl = song.lrc_url || song.lyric_url || (song.lrc?.startsWith("http") ? song.lrc : "");
    const lyricPath = song.lyric_path || (song.lrc && !song.lrc.startsWith("http") ? song.lrc : "");
    const isCurrentRequest = () =>
      lyricsRequestSeqRef.current === requestSeq && !controller.signal.aborted && currentSongRef.current === song;

    try {
      if (!inlineLyrics && !lrcUrl && !lyricPath) {
        if (!isCurrentRequest()) return;
        setActiveLyricIndex(-1);
        setTranslationOffered(false);
        setTranslationVisible(true);
        setLyrics([]);
        return;
      }

      const query = new URLSearchParams();
      if (inlineLyrics) query.set("inline_lyrics", inlineLyrics);
      else if (lrcUrl) query.set("lrc_url", lrcUrl);
      else if (lyricPath) query.set("lyric_path", lyricPath);
      if (translateToChinese) {
        query.set("translate_to_zh", "true");
        query.set("translate_provider", translateProvider);
      }

      const { data } = await requestJson<LyricsResponse>(`/api/lyrics?${query.toString()}`, {
        timeoutMs: 15_000,
        signal: controller.signal,
      });
      if (!isCurrentRequest()) return;
      const parsedLyrics = parseLrc(data.lyrics || "");
      const mergedLyrics = mergeTranslatedLrc(parsedLyrics, data.translated_lyrics || "");
      setActiveLyricIndex(-1);
      setTranslationOffered(shouldOfferChineseTranslation(parsedLyrics));
      if (translateToChinese && mergedLyrics.some((line) => Boolean((line.translation || "").trim()))) {
        setTranslationVisible(true);
      }
      setLyrics(mergedLyrics);
    } catch (error) {
      if (isAbortError(error) || !isCurrentRequest()) return;
      setActiveLyricIndex(-1);
      setTranslationOffered(false);
      setTranslationVisible(true);
      setLyrics([]);
    } finally {
      if (lyricsAbortRef.current === controller) {
        lyricsAbortRef.current = null;
      }
    }
  }, [
    setActiveLyricIndex,
    setLyrics,
    setTranslationOffered,
    setTranslationVisible,
    translateProvider,
  ]);

  const playerRuntime = usePlayerRuntime({
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
  });
  const {
    audioElementKey,
    isPlaying,
    setIsPlaying,
    playMode,
    listLoop,
    loopOne,
    volume,
    getCurrentQueueAndIndex,
    ensureAudioEffectsAttached,
    clearCurrentPlaybackState,
    playSong,
    playNextByMode,
    playPrevByMode,
    togglePlay,
    togglePlayMode,
    cycleRepeatMode,
    handleVolumeChange,
  } = playerRuntime;

  const playQueue = useMemo(() => {
    if (!currentSong) return visibleSongs.length ? visibleSongs : downloadedSongs.length ? downloadedSongs : songs;
    return getCurrentQueueAndIndex(currentSong)?.queue ?? (visibleSongs.length ? visibleSongs : songs);
  }, [currentSong, downloadedSongs, getCurrentQueueAndIndex, songs, visibleSongs]);

  const openFullscreenPlaylist = useCallback(() => {
    setOverlayRightPanel("playlist");
    openFullscreenPlayer();
  }, [openFullscreenPlayer]);

  async function translateCurrentLyrics() {
    if (!currentSong || translationLoading || translationTaskActiveRef.current) return;
    translationTaskActiveRef.current = true;
    const song = currentSong;
    const requestSeq = translationRequestSeqRef.current + 1;
    translationRequestSeqRef.current = requestSeq;
    const controller = nextController(translationAbortRef);
    const isCurrentRequest = () =>
      translationRequestSeqRef.current === requestSeq && !controller.signal.aborted && currentSongRef.current === song;
    const inlineLyrics = currentSong.lyrics || currentSong.lyric;
    const lrcUrl = currentSong.lrc_url || currentSong.lyric_url || (currentSong.lrc?.startsWith("http") ? currentSong.lrc : "");
    const lyricPath = currentSong.lyric_path || (currentSong.lrc && !currentSong.lrc.startsWith("http") ? currentSong.lrc : "");

    setTranslationLoading(true);
    setTranslationProgressPercent(0);
    try {
      const { data } = await requestJson<LyricsTranslateResponse>("/api/lyrics/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inline_lyrics: inlineLyrics || undefined,
          lrc_url: inlineLyrics ? undefined : lrcUrl || undefined,
          lyric_path: lyricPath || undefined,
          translate_provider: translateProvider,
        }),
        timeoutMs: 20_000,
        signal: controller.signal,
      });
      if (!isCurrentRequest()) return;
      if (!data.job_id) throw new Error("翻译任务缺少 job_id");

      await pollLyricsTranslationJob(data.job_id, song, controller.signal, isCurrentRequest);
    } catch (error) {
      if (!isAbortError(error) && isCurrentRequest()) console.warn("歌词翻译失败", error);
    } finally {
      translationTaskActiveRef.current = false;
      if (isCurrentRequest()) {
        setTranslationLoading(false);
        setTranslationProgressPercent(0);
      }
      if (translationAbortRef.current === controller) {
        translationAbortRef.current = null;
      }
    }
  }

  async function pollLyricsTranslationJob(
    jobId: string,
    song: Song,
    signal: AbortSignal,
    isCurrentRequest: () => boolean,
  ) {
    while (true) {
      const { data } = await requestJson<LyricsTranslateResponse>(`/api/lyrics/translate/${jobId}`, {
        timeoutMs: 8_000,
        signal,
      });
      if (!isCurrentRequest()) return;

      setTranslationProgressPercent(Number(data.percent ?? 0));
      if (data.status === "finished") {
        const inlineLyrics = song.lyrics || song.lyric;
        const lrcUrl = song.lrc_url || song.lyric_url || (song.lrc?.startsWith("http") ? song.lrc : "");
        const lyricPath = song.lyric_path || (song.lrc && !song.lrc.startsWith("http") ? song.lrc : "");
        const rawLyrics = inlineLyrics || await (async () => {
          const query = new URLSearchParams();
          if (lrcUrl) query.set("lrc_url", lrcUrl);
          else if (lyricPath) query.set("lyric_path", lyricPath);
          const { data: lyricsData } = await requestJson<LyricsResponse>(`/api/lyrics?${query.toString()}`, {
            timeoutMs: 15_000,
            signal,
          });
          if (!isCurrentRequest()) return;
          return lyricsData.lyrics || "";
        })();
        if (!rawLyrics) return;

        const parsedLyrics = parseLrc(rawLyrics);
        const mergedLyrics = mergeTranslatedLrc(parsedLyrics, data.translated_lyrics || "");
        setActiveLyricIndex(-1);
        setTranslationOffered(shouldOfferChineseTranslation(parsedLyrics));
        setTranslationVisible(true);
        setLyrics(mergedLyrics);
        return;
      }
      if (data.status === "failed") {
        throw new Error(data.error || data.message || "歌词翻译失败");
      }
      await waitForMsOrAbort(300, signal);
    }
  }

  async function toggleChineseTranslation() {
    if (translationLoading) return;
    if (lyricsHaveTranslations) {
      setTranslationVisible((prev) => !prev);
      return;
    }
    await translateCurrentLyrics();
  }

  async function toggleProAudioTools(enabled: boolean) {
    audioEffects.setSettings({ ...audioEffects.settings, proToolsEnabled: enabled });
    if (!enabled) return;
    await audioEffects.resumeAudioEffects(audioRef.current);
  }

  function toggleSource(value: string) {
    // 单选模式：直接设置为选中的源
    setSelectedSources([value]);
  }

  function toggleSong(index: number) {
    setSelectedIndexes((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function changeActiveView(view: ActiveView) {
    setActiveView(view);
    setSelectedIndexes(new Set());
  }

  const selectedCount = useMemo(() => selectedIndexes.size, [selectedIndexes]);
  const heroTitle =
    activeView === "search" ? "在线搜索" : activeView === "downloaded" ? "本地音乐库" : "设置";
  const heroDescription =
    activeView === "settings"
      ? "应用偏好与歌词展示模式；后续可在此扩展更多选项。"
      : "搜索来源仅用于在线搜索，本地库不区分来源。";
  const currentLyricText =
    activeLyricIndex >= 0 && activeLyricIndex < lyrics.length ? (lyrics[activeLyricIndex]?.text || "").trim() : "";
  const currentLyricTranslation =
    translationVisible && activeLyricIndex >= 0 && activeLyricIndex < lyrics.length
      ? (lyrics[activeLyricIndex]?.translation || "").trim()
      : "";
  const lyricsHaveTranslations = lyrics.some((line) => Boolean((line.translation || "").trim()));
  const overlayBgCover = getCoverUrl(currentSong);
  // Prepare the tiny blurred background while the song is playing so opening the
  // fullscreen player does not decode and blur an image on the animation's first frame.
  const overlayBlurCoverInput = overlayBgCover;
  const { blurredOverlayCover, useCssOverlayBlur } = useBlurredOverlayCover(overlayBlurCoverInput);
  const overlayStyle: CSSProperties | undefined = overlayBgCover
    ? ({
        ["--overlay-cover-url" as string]: `url("${overlayBgCover}")`,
        ["--overlay-blurred-cover-url" as string]: blurredOverlayCover ? `url("${blurredOverlayCover}")` : `url("${overlayBgCover}")`,
      } as CSSProperties)
    : undefined;
  const lyricsLowFx = lyricsDisplayMode === "performance";
  const overlayClassName = `${overlayBgCover ? "player-overlay has-cover" : "player-overlay"}${lyricsLowFx ? " low-perf" : ""}${
    useCssOverlayBlur ? " css-cover-blur" : ""
  }${areOverlayEffectsReady ? " overlay-effects-ready" : ""}`;

  const shellClassName =
    "shell" +
    (isNarrowViewport ? " shell-narrow" : "") +
    (!isNarrowViewport && sidebarCollapsed ? " sidebar-collapsed" : "") +
    (isNarrowViewport && narrowSidebarOpen ? " narrow-sidebar-open" : "");
  return (
    <div className={shellClassName}>
      <Sidebar
        activeView={activeView}
        isNarrowViewport={isNarrowViewport}
        narrowSidebarOpen={narrowSidebarOpen}
        collapsed={sidebarCollapsed}
        sources={sources}
        selectedSources={selectedSources}
        saveDir={saveDir}
        limit={limit}
        onSetActiveView={changeActiveView}
        onLoadDownloadedSongs={() => void loadDownloadedSongs()}
        onCloseNarrowSidebar={() => setNarrowSidebarOpen(false)}
        onToggleCollapsed={() => setSidebarCollapsed((previous) => !previous)}
        onSaveDirChange={setSaveDir}
        onLimitChange={setLimit}
        onToggleSource={toggleSource}
      />

      {downloadToast && (
        <div className={downloadToast.visible ? `download-toast ${downloadToast.status} visible` : `download-toast ${downloadToast.status}`}>
          <button type="button" className="download-toast-close" onClick={hideDownloadToast} aria-label="关闭下载提示">
            ×
          </button>
          <span className="download-toast-kicker">下载</span>
          <strong>{downloadToast.title}</strong>
          {downloadToast.detail && <small>{downloadToast.detail}</small>}
          <div className="download-toast-track" aria-hidden>
            <div className="download-toast-fill" style={{ width: `${downloadToast.percent}%` }} />
          </div>
        </div>
      )}

      {appUpdate.info?.update_available && !appUpdate.dismissed && (
        <div className="app-update-toast" role="status">
          <div>
            <span>发现新版本</span>
            <strong>v{appUpdate.info.latest_version} 可以更新</strong>
          </div>
          <button
            type="button"
            className="app-update-toast-action"
            onClick={() => {
              setActiveView("settings");
              appUpdate.dismiss();
            }}
          >
            查看更新
          </button>
          <button type="button" className="app-update-toast-close" onClick={appUpdate.dismiss} aria-label="稍后提醒">
            ×
          </button>
        </div>
      )}

      <div className="content-shell">
        {isNarrowViewport && !narrowSidebarOpen && (
          <button
            type="button"
            className="narrow-sidebar-fab"
            aria-expanded={false}
            aria-controls="app-sidebar"
            onClick={() => setNarrowSidebarOpen(true)}
          >
            <IoMenu aria-hidden />
            <span>菜单</span>
          </button>
        )}
        {isNarrowViewport && narrowSidebarOpen && (
          <div
            className="narrow-content-scrim"
            aria-hidden
            onClick={() => setNarrowSidebarOpen(false)}
          />
        )}
        <main className="content">
          <header className="top"></header>

          <section className="hero">
            <h1>{heroTitle}</h1>
            <p>{heroDescription}</p>
          </section>

          {activeView === "settings" && (
            <SettingsPage
              lyricsDisplayMode={lyricsDisplayMode}
              showFpsDebug={showFpsDebug}
              translateProvider={translateProvider}
              audioEffectsSettings={audioEffects.settings}
              audioEffectsStatus={audioEffects.status}
              audioEffectsMelFrame={audioEffects.melFrame}
              showSourceColumns={showSourceColumns}
              appUpdate={appUpdate}
              onLyricsDisplayModeChange={setLyricsDisplayMode}
              onShowFpsDebugChange={setShowFpsDebug}
              onTranslateProviderChange={setTranslateProvider}
              onShowSourceColumnsChange={(value) => void updateShowSourceColumns(value)}
              onAudioEffectsChange={audioEffects.setSettings}
              onResumeAudioEffects={() => void audioEffects.resumeAudioEffects(audioRef.current)}
              onToggleProAudioTools={(value) => void toggleProAudioTools(value)}
            />
          )}

          {activeView !== "settings" && (
            <>
              <SearchToolbar
                activeView={activeView}
                keyword={keyword}
                loading={loading}
                selectedCount={selectedCount}
                hasJob={!!jobId}
                onKeywordChange={setKeyword}
                onSearch={() => void onSearch()}
                onDownload={() => void onDownload()}
              />
              <SongTable
                activeView={activeView}
                songs={visibleSongs}
                selectedIndexes={selectedIndexes}
                showSourceColumns={showSourceColumns}
                onToggleSong={toggleSong}
                onPlaySong={(song) => void playSong(song)}
                onDeleteSong={(song) => void deleteLocalSong(song)}
              />
            </>
          )}
        </main>
      </div>

      <PlayerBar
        audioElementKey={audioElementKey}
        audioRef={audioRef}
        currentSong={currentSong}
        playQueue={playQueue}
        currentLyricText={currentLyricText}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        isPlaying={isPlaying}
        playerTimeRef={playerTimeRef}
        coverUrl={overlayBgCover}
        formatTime={formatTime}
        onOpenFullscreen={openFullscreenPlayer}
        onOpenFullscreenPlaylist={openFullscreenPlaylist}
        onPlayPrev={playPrevByMode}
        onTogglePlay={togglePlay}
        onPlayNext={playNextByMode}
        onPlaySong={(song) => void playSong(song)}
        onVolumeChange={handleVolumeChange}
        onAudioPlay={() => {
          setIsPlaying(true);
          void ensureAudioEffectsAttached();
          startLyricsRuntime();
        }}
        onAudioPause={() => {
          setIsPlaying(false);
          stopLyricsRuntime("pause");
        }}
        onAudioSeeked={scheduleNextLyricSwitch}
        onAudioLoadedMetadata={setPlaybackDuration}
        onAudioEnded={(endedDuration) => {
          stopLyricsRuntime("ended");
          setIsPlaying(false);
          const endedTime = endedDuration || duration || 0;
          setPlaybackClock(endedTime, true);
          if (!loopOne) playNextByMode();
        }}
      />
      <FullscreenPlayer
        mounted={isOverlayMounted}
        entered={isPlayerExpanded}
        overlayClassName={overlayClassName}
        overlayStyle={overlayStyle}
        currentSong={currentSong}
        playQueue={playQueue}
        rightPanel={overlayRightPanel}
        coverUrl={overlayBgCover}
        currentLyricText={currentLyricText}
        currentLyricTranslation={currentLyricTranslation}
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        playMode={playMode}
        listLoop={listLoop}
        loopOne={loopOne}
        volume={volume}
        lyrics={lyrics}
        activeLyricIndex={activeLyricIndex}
        translationVisible={translationVisible}
        translationOffered={translationOffered}
        lyricsHaveTranslations={lyricsHaveTranslations}
        translationLoading={translationLoading}
        translationProgressPercent={translationProgressPercent}
        showFpsDebug={showFpsDebug}
        overlayProgressRef={overlayProgressRef}
        overlayProgressFillRef={overlayProgressFillRef}
        overlayCurrentTimeRef={overlayCurrentTimeRef}
        overlayDurationTimeRef={overlayDurationTimeRef}
        lyricsContainerRef={lyricsContainerRef}
        lyricsInnerRef={lyricsInnerRef}
        fpsDebugHudRef={fpsDebugHudRef}
        formatTime={formatTime}
        onClose={closeFullscreenPlayer}
        onRightPanelChange={setOverlayRightPanel}
        onSeekByProgressClick={seekByProgressClick}
        onTogglePlayMode={togglePlayMode}
        onPlayPrev={playPrevByMode}
        onTogglePlay={togglePlay}
        onPlayNext={playNextByMode}
        onCycleRepeatMode={cycleRepeatMode}
        onVolumeChange={handleVolumeChange}
        onToggleChineseTranslation={() => void toggleChineseTranslation()}
        onSeekToTime={seekToTime}
        onPlaySong={(song) => void playSong(song)}
        onRegisterLyricRef={registerLyricRef}
      />
    </div>
  );
}

export default App;
