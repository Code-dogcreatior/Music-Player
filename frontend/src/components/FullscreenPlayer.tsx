import type { CSSProperties, PointerEvent, RefObject } from "react";
import {
  IoClose,
  IoLanguage,
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

type FullscreenPlayerProps = {
  mounted: boolean;
  entered: boolean;
  overlayClassName: string;
  overlayStyle?: CSSProperties;
  currentSong: Song | null;
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
  onSeekByProgressClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onTogglePlayMode: () => void;
  onPlayPrev: () => void;
  onTogglePlay: () => void;
  onPlayNext: () => void;
  onCycleRepeatMode: () => void;
  onVolumeChange: (value: number) => void;
  onToggleChineseTranslation: () => void;
  onSeekToTime: (timeSec: number) => void;
  onRegisterLyricRef: (index: number, el: HTMLDivElement | null) => void;
};

export function FullscreenPlayer({
  mounted,
  entered,
  overlayClassName,
  overlayStyle,
  currentSong,
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
  onSeekByProgressClick,
  onTogglePlayMode,
  onPlayPrev,
  onTogglePlay,
  onPlayNext,
  onCycleRepeatMode,
  onVolumeChange,
  onToggleChineseTranslation,
  onSeekToTime,
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

  return (
    <div className={`${overlayClassName} ${entered ? "overlay-entered" : ""}`} style={overlayStyle}>
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
          <div className="overlay-mobile-caption">
            <span>{currentLyricText || "..."}</span>
            {currentLyricTranslation && <small>{currentLyricTranslation}</small>}
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
          <div className="overlay-translate-slot">
            {translationOffered && (
              <button
                className={`${translationVisible && lyricsHaveTranslations ? "overlay-translate-btn active" : "overlay-translate-btn"}${
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
          </div>
        </div>
        <div className="overlay-right">
          <div className="overlay-lyrics-list" ref={lyricsContainerRef}>
            {lyrics.length === 0 ? (
              <p className="empty">当前歌曲暂无 LRC 歌词</p>
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
