import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from "react";
import { IoList, IoPause, IoPlay, IoPlaySkipBack, IoPlaySkipForward, IoVolumeHigh } from "react-icons/io5";
import type { Song } from "../types";
import { getSongArtists } from "../songUtils";
import { PlayQueueList } from "./PlayQueueList";

type PlayerBarProps = {
  audioElementKey: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  currentSong: Song | null;
  playQueue: Song[];
  currentLyricText: string;
  currentTime: number;
  duration: number;
  volume: number;
  isPlaying: boolean;
  playerTimeRef: RefObject<HTMLSpanElement | null>;
  coverUrl: string;
  formatTime: (sec: number) => string;
  onOpenFullscreen: () => void;
  onOpenFullscreenPlaylist: () => void;
  onPlayPrev: () => void;
  onTogglePlay: () => void;
  onPlayNext: () => void;
  onPlaySong: (song: Song) => void;
  onVolumeChange: (value: number) => void;
  onAudioPlay: () => void;
  onAudioPause: () => void;
  onAudioSeeked: () => void;
  onAudioLoadedMetadata: (duration: number) => void;
  onAudioEnded: (duration: number) => void;
};

export function PlayerBar({
  audioElementKey,
  audioRef,
  currentSong,
  playQueue,
  currentLyricText,
  currentTime,
  duration,
  volume,
  isPlaying,
  playerTimeRef,
  coverUrl,
  formatTime,
  onOpenFullscreen,
  onOpenFullscreenPlaylist,
  onPlayPrev,
  onTogglePlay,
  onPlayNext,
  onPlaySong,
  onVolumeChange,
  onAudioPlay,
  onAudioPause,
  onAudioSeeked,
  onAudioLoadedMetadata,
  onAudioEnded,
}: PlayerBarProps) {
  const [queueOpen, setQueueOpen] = useState(false);
  const queueWrapRef = useRef<HTMLDivElement | null>(null);
  const volumePercent = `${Math.max(0, Math.min(100, volume))}%`;
  const syncVolumeInput = (input: HTMLInputElement, rawValue: number) => {
    const safe = Math.max(0, Math.min(100, Math.round(rawValue)));
    input.value = String(safe);
    input.parentElement?.style.setProperty("--player-volume-percent", `${safe}%`);
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

  useEffect(() => {
    if (!queueOpen) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && queueWrapRef.current?.contains(target)) return;
      setQueueOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQueueOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [queueOpen]);

  return (
    <footer className="player-bar">
      <div
        className="player-meta"
        onClick={onOpenFullscreen}
        style={{ cursor: "pointer" }}
        title="打开全屏播放器"
      >
        {coverUrl ? (
          <img className="cover-placeholder" src={coverUrl} alt="cover" />
        ) : (
          <div className="cover-placeholder">♪</div>
        )}
        <div>
          <div className="song">现在播放</div>
          <div className="artist">
            {currentSong ? `${currentSong.song_name || "未知歌曲"} · ${getSongArtists(currentSong)}` : "未在播放"}
          </div>
          <div className="player-live-lyric">{currentLyricText || "..."}</div>
        </div>
      </div>
      <div className="player-center">
        <button className="player-control-btn" type="button" onClick={onPlayPrev} disabled={!currentSong} aria-label="上一首">
          <IoPlaySkipBack aria-hidden />
        </button>
        <button
          className="player-control-btn player-control-primary"
          type="button"
          onClick={onTogglePlay}
          disabled={!currentSong}
          aria-label={isPlaying ? "暂停" : "播放"}
        >
          {isPlaying ? <IoPause aria-hidden /> : <IoPlay aria-hidden className="player-play-icon" />}
        </button>
        <button className="player-control-btn" type="button" onClick={onPlayNext} disabled={!currentSong} aria-label="下一首">
          <IoPlaySkipForward aria-hidden />
        </button>
      </div>
      <div className="player-right">
        <div className="player-queue-wrap" ref={queueWrapRef}>
          <button
            className={`player-queue-btn${queueOpen ? " active" : ""}`}
            type="button"
            aria-label="播放列表"
            aria-expanded={queueOpen}
            title="播放列表"
            onClick={() => setQueueOpen((open) => !open)}
          >
            <IoList aria-hidden />
          </button>
          {queueOpen ? (
            <div className="player-queue-popover" role="dialog" aria-label="播放列表">
              <div className="player-queue-header">
                <div>
                  <strong>播放列表</strong>
                  <span>{playQueue.length} 首</span>
                </div>
                <button
                  type="button"
                  className="player-queue-fullscreen"
                  onClick={() => {
                    setQueueOpen(false);
                    onOpenFullscreenPlaylist();
                  }}
                >
                  全屏查看
                </button>
              </div>
              <PlayQueueList
                songs={playQueue}
                currentSong={currentSong}
                variant="light"
                onPlaySong={(song) => {
                  onPlaySong(song);
                }}
              />
            </div>
          ) : null}
        </div>
        <span className="player-time" ref={playerTimeRef}>
          {formatTime(currentTime)} / {formatTime(duration || 0)}
        </span>
        <label
          className="player-volume"
          title="音量"
          style={{ ["--player-volume-percent" as string]: volumePercent } as CSSProperties}
        >
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
        </label>
      </div>
      <audio
        key={audioElementKey}
        ref={audioRef}
        crossOrigin="anonymous"
        preload="none"
        onPlay={onAudioPlay}
        onPause={onAudioPause}
        onSeeked={onAudioSeeked}
        onLoadedMetadata={(e) => onAudioLoadedMetadata(e.currentTarget.duration || 0)}
        onEnded={(e) => onAudioEnded(e.currentTarget.duration || 0)}
      />
    </footer>
  );
}
