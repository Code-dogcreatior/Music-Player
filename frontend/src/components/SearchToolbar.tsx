import { IoCloudDownloadOutline, IoSearchOutline } from "react-icons/io5";
import type { ActiveView } from "../types";

type SearchToolbarProps = {
  activeView: ActiveView;
  keyword: string;
  loading: boolean;
  selectedCount: number;
  hasJob: boolean;
  onKeywordChange: (value: string) => void;
  onSearch: () => void;
  onDownload: () => void;
};

export function SearchToolbar({
  activeView,
  keyword,
  loading,
  selectedCount,
  hasJob,
  onKeywordChange,
  onSearch,
  onDownload,
}: SearchToolbarProps) {
  const primaryLabel = loading
    ? "搜索中"
    : activeView === "downloaded"
      ? "本地搜索"
      : "在线搜索";

  return (
    <header className="top controls command-bar">
      <label className="search-shell">
        <IoSearchOutline aria-hidden />
        <input
          className="search"
          value={keyword}
          onChange={(e) => onKeywordChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.repeat || loading) return;
              onSearch();
            }
          }}
          placeholder={activeView === "downloaded" ? "搜索本地歌曲、歌手、路径" : "搜索歌曲、歌手或专辑"}
        />
      </label>
      <button className="action-btn primary-action" onClick={onSearch} disabled={loading}>
        <IoSearchOutline aria-hidden />
        <span>{primaryLabel}</span>
      </button>
      {activeView !== "downloaded" && (
        <button className="action-btn secondary-action" onClick={onDownload} disabled={selectedCount === 0 || hasJob}>
          <IoCloudDownloadOutline aria-hidden />
          <span>下载 {selectedCount}</span>
        </button>
      )}
    </header>
  );
}
