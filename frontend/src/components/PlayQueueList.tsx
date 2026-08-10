import { useEffect, useRef } from "react";
import { IoMusicalNotesOutline } from "react-icons/io5";
import { getCoverUrl, getSongArtists, isSameSong } from "../songUtils";
import type { Song } from "../types";

type PlayQueueListProps = {
  songs: Song[];
  currentSong: Song | null;
  variant?: "light" | "dark";
  onPlaySong: (song: Song) => void;
};

export function PlayQueueList({
  songs,
  currentSong,
  variant = "light",
  onPlaySong,
}: PlayQueueListProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const item = activeRef.current;
    const list = listRef.current;
    if (!item || !list) return;

    const itemTop = item.offsetTop;
    const itemBottom = itemTop + item.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    const padding = 8;

    if (itemTop < viewTop + padding) {
      list.scrollTo({ top: Math.max(0, itemTop - padding), behavior: "smooth" });
    } else if (itemBottom > viewBottom - padding) {
      list.scrollTo({ top: itemBottom - list.clientHeight + padding, behavior: "smooth" });
    }
  }, [currentSong, songs]);

  if (songs.length === 0) {
    return <p className={`play-queue-empty ${variant}`}>当前没有可播放的列表</p>;
  }

  return (
    <div className={`play-queue-list ${variant}`} role="list" ref={listRef}>
      {songs.map((song, index) => {
        const active = currentSong ? isSameSong(song, currentSong) : false;
        const cover = getCoverUrl(song);
        const artists = getSongArtists(song);
        const canPlay = Boolean(song.download_url || song.stream_url);
        return (
          <button
            key={`${song.song_id || song.file_path || song.stream_url || song.song_name || "song"}-${index}`}
            ref={active ? activeRef : undefined}
            type="button"
            role="listitem"
            className={`play-queue-item${active ? " active" : ""}`}
            disabled={!canPlay}
            onClick={() => onPlaySong(song)}
            title={canPlay ? `播放 ${song.song_name || "歌曲"}` : "暂无可播放音源"}
          >
            <span className="play-queue-index" aria-hidden>
              {active ? "♪" : index + 1}
            </span>
            <span className="play-queue-cover" aria-hidden>
              {cover ? <img src={cover} alt="" loading="lazy" /> : <IoMusicalNotesOutline />}
            </span>
            <span className="play-queue-meta">
              <span className="play-queue-name">{song.song_name || "未知歌曲"}</span>
              <span className="play-queue-artist">{artists}</span>
            </span>
            {song.duration ? <span className="play-queue-duration">{song.duration}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
