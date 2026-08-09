import { memo, useCallback, useMemo, useState } from "react";
import {
  IoAlbumsOutline,
  IoEllipsisHorizontal,
  IoListOutline,
  IoMusicalNotesOutline,
  IoPersonOutline,
  IoPlay,
  IoTrashOutline,
} from "react-icons/io5";
import type { ActiveView, Song } from "../types";
import { getCoverUrl, getSongArtists } from "../songUtils";

type SongTableProps = {
  activeView: ActiveView;
  songs: Song[];
  selectedIndexes: Set<number>;
  showSourceColumns: boolean;
  onToggleSong: (index: number) => void;
  onPlaySong: (song: Song) => void;
  onDeleteSong?: (song: Song) => void;
};

type VisibleSong = {
  song: Song;
  index: number;
};

type LibraryGroupMode = "all" | "artist" | "album";

type LibraryGroup = {
  key: string;
  label: string;
  count: number;
};

const LARGE_LIST_THRESHOLD = 300;
const INITIAL_VISIBLE_ROWS = 300;
const VISIBLE_ROWS_INCREMENT = 300;
const UNKNOWN_ARTIST = "未知歌手";
const UNKNOWN_ALBUM = "未知专辑";

function getParseSourceText(song: Song): string {
  const audioSource = (song.audio_parse_source || "").trim();
  const lyricSource = (song.lyric_parse_source || "").trim();
  if (audioSource && lyricSource) return `音频 ${audioSource} · 歌词 ${lyricSource}`;
  if (audioSource) return `音频 ${audioSource}`;
  if (lyricSource) return `歌词 ${lyricSource}`;
  return "-";
}

function normalizedGroupValue(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized || fallback;
}

function getLibraryGroupValue(song: Song, mode: Exclude<LibraryGroupMode, "all">): string {
  if (mode === "artist") {
    const artists = getSongArtists(song);
    return normalizedGroupValue(artists === "-" ? "" : artists, UNKNOWN_ARTIST);
  }
  return normalizedGroupValue(song.album || "", UNKNOWN_ALBUM);
}

function buildLibraryGroups(songs: Song[], mode: Exclude<LibraryGroupMode, "all">): LibraryGroup[] {
  const groupMap = new Map<string, LibraryGroup>();
  for (const song of songs) {
    const label = getLibraryGroupValue(song, mode);
    const existing = groupMap.get(label);
    if (existing) {
      existing.count += 1;
    } else {
      groupMap.set(label, { key: label, label, count: 1 });
    }
  }
  return Array.from(groupMap.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label, "zh-Hans-CN");
  });
}

const SongRow = memo(function SongRow({
  activeView,
  song,
  index,
  selected,
  showSourceColumns,
  onToggleSong,
  onPlaySong,
  onDeleteSong,
}: {
  activeView: ActiveView;
  song: Song;
  index: number;
  selected: boolean;
  showSourceColumns: boolean;
  onToggleSong: (index: number) => void;
  onPlaySong: (song: Song) => void;
  onDeleteSong?: (song: Song) => void;
}) {
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const parseSourceText = getParseSourceText(song);
  const artists = getSongArtists(song);
  const cover = getCoverUrl(song);
  const handleToggle = useCallback(() => onToggleSong(index), [index, onToggleSong]);
  const handlePlay = useCallback(() => onPlaySong(song), [onPlaySong, song]);
  const canPlay = Boolean(song.download_url || song.stream_url);
  const isDownloaded = activeView === "downloaded";
  const handleRowDoubleClick = useCallback(() => {
    if (canPlay) onPlaySong(song);
  }, [canPlay, onPlaySong, song]);
  const handleDelete = useCallback(() => {
    setActionMenuOpen(false);
    onDeleteSong?.(song);
  }, [onDeleteSong, song]);

  return (
    <div
      className={`${isDownloaded ? "row downloaded-row" : "row"}${showSourceColumns ? " show-source-columns" : ""}${canPlay ? " playable-row" : ""}`}
      onDoubleClick={handleRowDoubleClick}
      title={canPlay ? "双击播放" : undefined}
    >
      {!isDownloaded && (
        <span className="select-cell">
          <input
            className="song-select"
            type="checkbox"
            checked={selected}
            onChange={handleToggle}
            aria-label={`选择 ${song.song_name || "歌曲"}`}
          />
        </span>
      )}
      <span className="song-title-cell">
        <span className="song-cover" aria-hidden>
          {cover ? <img src={cover} alt="" loading="lazy" /> : <IoMusicalNotesOutline />}
        </span>
        <span className="song-title-stack">
          <span className="song-name-line" title={song.song_name || ""}>
            {song.song_name || "-"}
          </span>
          <span className="song-meta-line">
            <span>{artists}</span>
            {song.duration && <span>{song.duration}</span>}
          </span>
        </span>
      </span>
      <span className="album-cell" title={song.album || ""}>
        {song.album || "-"}
      </span>
      {showSourceColumns && activeView !== "downloaded" && (
        <span className="source-cell">
          {song.source || "-"}
        </span>
      )}
      {showSourceColumns && (
        <span className="parse-source-cell" title={parseSourceText}>
          {parseSourceText}
        </span>
      )}
      <span className={actionMenuOpen ? "row-actions menu-open" : "row-actions"} onDoubleClick={(event) => event.stopPropagation()}>
        {!actionMenuOpen && (
          <button
            className="play-btn"
            onClick={handlePlay}
            disabled={!canPlay}
            title={canPlay ? `播放 ${song.song_name || "歌曲"}` : "暂无可播放音源"}
          >
            <IoPlay aria-hidden />
            <span>{canPlay ? "播放" : "暂无"}</span>
          </button>
        )}
        {isDownloaded && (
          <span className="row-more-actions">
            {actionMenuOpen && (
              <button className="row-delete-btn" type="button" onClick={handleDelete} title={`删除 ${song.song_name || "歌曲"}`}>
                <IoTrashOutline aria-hidden />
                <span>删除</span>
              </button>
            )}
            <button
              className="row-more-btn"
              type="button"
              aria-label={`${song.song_name || "歌曲"} 更多操作`}
              aria-expanded={actionMenuOpen}
              onClick={() => setActionMenuOpen((prev) => !prev)}
            >
              <IoEllipsisHorizontal aria-hidden />
            </button>
          </span>
        )}
      </span>
    </div>
  );
});

function TableBlock({
  title,
  activeView,
  songs,
  selectedIndexes,
  showSourceColumns,
  onToggleSong,
  onPlaySong,
  onDeleteSong,
}: Omit<SongTableProps, "songs"> & { title?: string; songs: VisibleSong[] }) {
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_ROWS);
  const visibleRows = useMemo(
    () => (songs.length > LARGE_LIST_THRESHOLD ? songs.slice(0, visibleLimit) : songs),
    [songs, visibleLimit],
  );
  const hasMoreRows = visibleRows.length < songs.length;

  if (songs.length === 0) return null;
  const showSelectionColumn = activeView !== "downloaded";
  return (
    <section className="table-group">
      {title && <h2 className="table-group-title">{title}</h2>}
      <div className="table">
        <div className={`${activeView === "downloaded" ? "row head downloaded-row" : "row head"}${showSourceColumns ? " show-source-columns" : ""}`}>
          {showSelectionColumn && <span></span>}
          <span>歌曲</span>
          <span>专辑</span>
          {showSourceColumns && activeView !== "downloaded" && <span>来源</span>}
          {showSourceColumns && <span>解析源</span>}
          <span>操作</span>
        </div>
        {visibleRows.map(({ song, index }) => {
          return (
            <SongRow
              key={`${song.song_id || song.file_path || song.song_name}-${index}`}
              activeView={activeView}
              showSourceColumns={showSourceColumns}
              onToggleSong={onToggleSong}
              onPlaySong={onPlaySong}
              onDeleteSong={onDeleteSong}
              song={song}
              index={index}
              selected={selectedIndexes.has(index)}
            />
          );
        })}
        {hasMoreRows && (
          <div className="table-load-more">
            <button type="button" onClick={() => setVisibleLimit((prev) => prev + VISIBLE_ROWS_INCREMENT)}>
              显示更多 ({visibleRows.length}/{songs.length})
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function LibraryBrowser({
  songs,
  selectedIndexes,
  showSourceColumns,
  onToggleSong,
  onPlaySong,
  onDeleteSong,
}: Omit<SongTableProps, "activeView">) {
  const [groupMode, setGroupMode] = useState<LibraryGroupMode>("all");
  const [activeGroupKey, setActiveGroupKey] = useState("");
  const artistGroups = useMemo(() => buildLibraryGroups(songs, "artist"), [songs]);
  const albumGroups = useMemo(() => buildLibraryGroups(songs, "album"), [songs]);
  const currentGroups = groupMode === "album" ? albumGroups : artistGroups;
  const filteredRows = useMemo(() => {
    return songs
      .map((song, index) => ({ song, index }))
      .filter(({ song }) => {
        if (groupMode === "all" || !activeGroupKey) return true;
        return getLibraryGroupValue(song, groupMode) === activeGroupKey;
      });
  }, [activeGroupKey, groupMode, songs]);
  const activeGroupTitle =
    groupMode === "all" || !activeGroupKey
      ? undefined
      : `${activeGroupKey} · ${filteredRows.length} 首`;

  function switchMode(mode: LibraryGroupMode) {
    setGroupMode(mode);
    setActiveGroupKey("");
  }

  return (
    <>
      <section className="library-browser" aria-label="本地音乐库分类">
        <div className="library-tabs" role="tablist" aria-label="本地音乐库视图">
          <button
            type="button"
            className={groupMode === "all" ? "library-tab active" : "library-tab"}
            onClick={() => switchMode("all")}
          >
            <IoListOutline aria-hidden />
            <span>全部</span>
            <strong>{songs.length}</strong>
          </button>
          <button
            type="button"
            className={groupMode === "artist" ? "library-tab active" : "library-tab"}
            onClick={() => switchMode("artist")}
          >
            <IoPersonOutline aria-hidden />
            <span>歌手</span>
            <strong>{artistGroups.length}</strong>
          </button>
          <button
            type="button"
            className={groupMode === "album" ? "library-tab active" : "library-tab"}
            onClick={() => switchMode("album")}
          >
            <IoAlbumsOutline aria-hidden />
            <span>专辑</span>
            <strong>{albumGroups.length}</strong>
          </button>
        </div>
        {groupMode !== "all" && (
          <div className="library-groups" aria-label={groupMode === "artist" ? "按歌手筛选" : "按专辑筛选"}>
            {currentGroups.map((group) => (
              <button
                type="button"
                key={group.key}
                className={activeGroupKey === group.key ? "library-group active" : "library-group"}
                onClick={() => setActiveGroupKey((prev) => (prev === group.key ? "" : group.key))}
                title={group.label}
              >
                <span>{group.label}</span>
                <strong>{group.count}</strong>
              </button>
            ))}
          </div>
        )}
      </section>
      <TableBlock
        title={activeGroupTitle}
        activeView="downloaded"
        songs={filteredRows}
        selectedIndexes={selectedIndexes}
        showSourceColumns={showSourceColumns}
        onToggleSong={onToggleSong}
        onPlaySong={onPlaySong}
        onDeleteSong={onDeleteSong}
      />
    </>
  );
}

export function SongTable({ activeView, songs, selectedIndexes, showSourceColumns, onToggleSong, onPlaySong, onDeleteSong }: SongTableProps) {
  if (activeView === "downloaded") {
    return (
      <LibraryBrowser
        songs={songs}
        selectedIndexes={selectedIndexes}
        showSourceColumns={showSourceColumns}
        onToggleSong={onToggleSong}
        onPlaySong={onPlaySong}
        onDeleteSong={onDeleteSong}
      />
    );
  }

  const searchRows = songs.map((song, index) => ({ song, index }));

  return (
    <TableBlock
      title="搜索结果"
      activeView={activeView}
      songs={searchRows}
      selectedIndexes={selectedIndexes}
      showSourceColumns={showSourceColumns}
      onToggleSong={onToggleSong}
      onPlaySong={onPlaySong}
      onDeleteSong={onDeleteSong}
    />
  );
}
