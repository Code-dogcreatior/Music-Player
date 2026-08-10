import type { CSSProperties, PointerEvent, RefObject } from "react";
import {
  IoClose,
  IoLanguage,
  IoList,
  IoPause,
  IoPlay,
  IoPlaySkipBack,
  IoPlaySkipForward,
  IoShuffle,
  IoVolumeHigh,
} from "react-icons/io5";
import { dimOf } from "../lyrics";
import { RepeatIcon, RepeatOneIcon } from "./RepeatOneIcon";
import { getSongArtists } from "../songUtils";
import type { LyricLine as LyricLineType, PlayMode, Song } from "../types";
import { LyricLine } from "./LyricLine";
import { PlayQueueList } from "./PlayQueueList";

export type OverlayRightPanel = "lyrics" | "playlist";

function LyricsGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden fill="none">
      <rect
        x="3.4"
        y="2.6"
        width="13"
        height="15.4"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.45"
      />
      <rect
        x="7.6"
        y="6"
        width="13"
        height="15.4"
        rx="2.2"
        fill="currentColor"
        fillOpacity="0.08"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <g transform="rotate(180 14.1 13.7)" fill="currentColor">
        <path d="M11.1 16.6c-1.15 0-2.05-.9-2.05-2.05 0-1.7 1.3-3.05 3.35-3.95l.55 1.05c-1.2.5-1.85 1.2-1.85 2 .15-.05.35-.1.55-.1.9 0 1.6.65 1.6 1.55 0 .9-.7 1.5-1.55 1.5h-.6zm4.9 0c-1.15 0-2.05-.9-2.05-2.05 0-1.7 1.3-3.05 3.35-3.95l.55 1.05c-1.2.5-1.85 1.2-1.85 2 .15-.05.35-.1.55-.1.9 0 1.6.65 1.6 1.55 0 .9-.7 1.5-1.55 1.5h-.6z" />
      </g>
    </svg>
  );
}

type FullscreenPlayerProps = {
  mounted: boolean;
  entered: boolean;
  overlayClassName: string;
  overlayStyle?: CSSProperties;
  currentSong: Song | null;
  playQueue: Song[];
  rightPanel: OverlayRightPanel;
  coverUrl: string;
  currentLyricText: string;
  currentLyricTranslation: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playMode: PlayMode;
  listLoop: boolean;
  loopOne: boolean;
  volume: number;
  lyrics: LyricLineType[];
  activeLyricIndex: number;
  translationVisible: boolean;
  translationOffered: boolean;
  lyricsHaveTranslations: boolean;
  translationLoading: boolean;
  translationProgressPercent: number;
  showFpsDebug: boolean;
  overlayProgressRef: RefObject<HTMLDivElement | null>;
  overlayProgressFillRef: RefObject<HTMLDivElement | null>;
  overlayCurrentTimeRef: RefObject<HTMLSpanElement | null>;
  overlayDurationTimeRef: RefObject<HTMLSpanElement | null>;
  lyricsContainerRef: RefObject<HTMLDivElement | null>;
  lyricsInnerRef: RefObject<HTMLDivElement | null>;
  fpsDebugHudRef: RefObject<HTMLDivElement | null>;
  formatTime: (sec: number) => string;
  onClose: () => void;
  onRightPanelChange: (panel: OverlayRightPanel) => void;
  onSeekByProgressClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onTogglePlayMode: () => void;
  onPlayPrev: () => void;
  onTogglePlay: () => void;
  onPlayNext: () => void;
  onCycleRepeatMode: () => void;
  onVolumeChange: (value: number) => void;
  onToggleChineseTranslation: () => void;
  onSeekToTime: (timeSec: number) => void;
  onPlaySong: (song: Song) => void;
  onRegisterLyricRef: (index: number, el: HTMLDivElement | null) => void;
};

export function FullscreenPlayer({
  mounted,
  entered,
  overlayClassName,
  overlayStyle,
  currentSong,
  playQueue,
  rightPanel,
  coverUrl,
  currentLyricText,
  currentLyricTranslation,
  currentTime,
  duration,
  isPlaying,
  playMode,
  listLoop,
  loopOne,
  volume,
  lyrics,
  activeLyricIndex,
  translationVisible,
  translationOffered,
  lyricsHaveTranslations,
  translationLoading,
  translationProgressPercent,
  showFpsDebug,
  overlayProgressRef,
  overlayProgressFillRef,
  overlayCurrentTimeRef,
  overlayDurationTimeRef,
  lyricsContainerRef,
  lyricsInnerRef,
  fpsDebugHudRef,
  formatTime,
  onClose,
  onRightPanelChange,
  onSeekByProgressClick,
  onTogglePlayMode,
  onPlayPrev,
  onTogglePlay,
  onPlayNext,
  onCycleRepeatMode,
  onVolumeChange,
  onToggleChineseTranslation,
  onSeekToTime,
  onPlaySong,
  onRegisterLyricRef,
}: FullscreenPlayerProps) {
  if (!mounted) return null;
  const volumePercent = `${Math.max(0, Math.min(100, volume))}%`;
  const syncVolumeInput = (input: HTMLInputElement, rawValue: number) => {
    const safe = Math.max(0, Math.min(100, Math.round(rawValue)));
    input.value = String(safe);
    input.parentElement?.style.setProperty("--overlay-volume-percent", `${safe}%`);
    onVolumeChange(safe);
  };
  const handleVolumeInput = (input: HTMLInputElement) => {
    syncVolumeInput(input, Number(input.value));
  };
  const updateVolumeFromPointer = (event: PointerEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const rect = input.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    syncVolumeInput(input, ratio * 100);
  };
  const handleVolumePointerDown = (event: PointerEvent<HTMLInputElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* Older Safari may not support capture on range inputs. */
    }
    updateVolumeFromPointer(event);
  };
  const handleVolumePointerMove = (event: PointerEvent<HTMLInputElement>) => {
    if (event.buttons <= 0) return;
    updateVolumeFromPointer(event);
  };
  const handleVolumePointerEnd = (event: PointerEvent<HTMLInputElement>) => {
    updateVolumeFromPointer(event);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* best effort */
    }
  };

  const showingPlaylist = rightPanel === "playlist";

  return (
    <div className={`${overlayClassName} ${entered ? "overlay-entered" : ""}${showingPlaylist ? " playlist-open" : ""}`} style={overlayStyle}>
      <div className="overlay-layout">
        <div className="overlay-left">
          <button className="overlay-close-btn" onClick={onClose}>
            <IoClose />
          </button>
          <div className="overlay-cover">
            {coverUrl ? <img src={coverUrl} alt="cover" /> : <div className="overlay-cover-placeholder">♪</div>}
          </div>
          <div className="overlay-song-meta">
            <h2>{currentSong?.song_name || "未在播放"}</h2>
            <p>{currentSong ? getSongArtists(currentSong) : "选择歌曲后可试听"}</p>
            {currentSong?.album && <p className="overlay-album">{currentSong.album}</p>}
          </div>
          <div className={`overlay-mobile-caption${showingPlaylist ? " playlist-mode" : ""}`}>
            {showingPlaylist ? (
              <div className="overlay-mobile-playlist">
                <div className="overlay-playlist-header">
                  <strong>播放列表</strong>
                  <span>{playQueue.length} 首</span>
                </div>
                <PlayQueueList songs={playQueue} currentSong={currentSong} variant="dark" onPlaySong={onPlaySong} />
              </div>
            ) : (
              <>
                <span>{currentLyricText || "..."}</span>
                {currentLyricTranslation && <small>{currentLyricTranslation}</small>}
              </>
            )}
          </div>
          <div className="overlay-progress">
            <div
              className="overlay-progress-track"
              ref={overlayProgressRef}
              onClick={onSeekByProgressClick}
              style={{ cursor: "pointer" }}
            >
              <div className="overlay-progress-fill-layer">
                <div ref={overlayProgressFillRef} className="overlay-progress-fill" />
              </div>
            </div>
            <div className="overlay-progress-times">
              <span ref={overlayCurrentTimeRef}>{formatTime(currentTime)}</span>
              <span ref={overlayDurationTimeRef}>{formatTime(duration || 0)}</span>
            </div>
          </div>
          <div className="overlay-controls">
            <button className={playMode === "shuffle" ? "icon-btn active" : "icon-btn"} onClick={onTogglePlayMode} title="随机播放">
              <IoShuffle />
            </button>
            <button className="icon-btn" title="上一首" onClick={onPlayPrev}>
              <IoPlaySkipBack />
            </button>
            <button className="icon-btn primary" onClick={onTogglePlay} title="播放/暂停">
              {isPlaying ? <IoPause /> : <IoPlay />}
            </button>
            <button className="icon-btn" title="下一首" onClick={onPlayNext}>
              <IoPlaySkipForward />
            </button>
            <button
              className={
                loopOne
                  ? "icon-btn active repeat-mode repeat-one"
                  : listLoop
                    ? "icon-btn active repeat-mode"
                    : "icon-btn repeat-mode"
              }
              onClick={onCycleRepeatMode}
              title={loopOne ? "单曲循环" : listLoop ? "列表循环" : "循环关闭"}
            >
              {loopOne ? <RepeatOneIcon /> : <RepeatIcon />}
            </button>
          </div>
          <div className="overlay-playmode-hint">
            {loopOne ? "单曲循环" : playMode === "shuffle" ? "随机播放" : listLoop ? "列表循环" : "顺序播放"}
          </div>
          <div className="overlay-volume" style={{ ["--overlay-volume-percent" as string]: volumePercent } as CSSProperties}>
            <IoVolumeHigh />
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onInput={(event) => handleVolumeInput(event.currentTarget)}
              onChange={(event) => handleVolumeInput(event.currentTarget)}
              onPointerDown={handleVolumePointerDown}
              onPointerMove={handleVolumePointerMove}
              onPointerUp={handleVolumePointerEnd}
              onPointerCancel={handleVolumePointerEnd}
            />
          </div>
          <div className="overlay-extra-actions">
            {translationOffered && (
              <button
                className={`${translationVisible && lyricsHaveTranslations ? "overlay-action-btn active" : "overlay-action-btn"}${
                  translationLoading ? " loading" : ""
                }`}
                type="button"
                onClick={onToggleChineseTranslation}
                title={translationLoading ? `正在翻译 ${translationProgressPercent}%` : lyricsHaveTranslations && translationVisible ? "隐藏中文译文" : "翻译中文"}
              >
                {translationLoading ? (
                  <>
                    <span
                      className="overlay-translate-progress-ring"
                      style={{ ["--translate-progress" as string]: String(translationProgressPercent) } as CSSProperties}
                      aria-hidden
                    />
                    <span className="overlay-translate-progress-text">{translationProgressPercent}%</span>
                  </>
                ) : (
                  <IoLanguage />
                )}
              </button>
            )}
            <button
              type="button"
              className={`overlay-action-btn${rightPanel === "lyrics" ? " active" : ""}`}
              title="歌词"
              aria-label="歌词"
              aria-pressed={rightPanel === "lyrics"}
              onClick={() => onRightPanelChange("lyrics")}
            >
              <LyricsGlyph />
            </button>
            <button
              type="button"
              className={`overlay-action-btn queue-btn${rightPanel === "playlist" ? " active" : ""}`}
              title="播放列表"
              aria-label="播放列表"
              aria-pressed={rightPanel === "playlist"}
              onClick={() => onRightPanelChange("playlist")}
            >
              <IoList aria-hidden />
            </button>
          </div>
        </div>
        <div className={`overlay-right${showingPlaylist ? " playlist-mode" : ""}`}>
          <div
            className={`overlay-playlist-panel${showingPlaylist ? "" : " is-hidden"}`}
            aria-hidden={!showingPlaylist}
          >
            <div className="overlay-playlist-header">
              <div>
                <strong>播放列表</strong>
                <span>{playQueue.length} 首</span>
              </div>
            </div>
            <PlayQueueList songs={playQueue} currentSong={currentSong} variant="dark" onPlaySong={onPlaySong} />
          </div>
          <div
            className={`overlay-lyrics-list${showingPlaylist ? " is-hidden" : ""}${lyrics.length === 0 ? " is-empty" : ""}`}
            ref={lyricsContainerRef}
            aria-hidden={showingPlaylist}
          >
            {lyrics.length === 0 ? (
              <p className="overlay-lyrics-empty">当前歌曲暂无 LRC 歌词</p>
            ) : (
              <div className="overlay-lyrics-inner" ref={lyricsInnerRef}>
                {lyrics.map((line, idx) => (
                  <LyricLine
                    key={`${line.time}-${idx}`}
                    index={idx}
                    time={line.time}
                    text={line.text}
                    translation={translationVisible ? line.translation : ""}
                    dim={dimOf(idx, activeLyricIndex)}
                    onSeek={onSeekToTime}
                    registerRef={onRegisterLyricRef}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {showFpsDebug && (
        <div className="overlay-fps-debug" ref={fpsDebugHudRef}>
          <strong>FPS Debug</strong>
          <span>waiting...</span>
        </div>
      )}
    </div>
  );
}
