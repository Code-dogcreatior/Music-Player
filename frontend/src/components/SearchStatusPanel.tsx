import { IoRefreshOutline, IoSearchOutline } from "react-icons/io5";
import type { SearchOutcome } from "../hooks/useAsyncJobs";

type SearchStatusPanelProps = {
  outcome: SearchOutcome;
  /** 当前选中的音乐源中文名，用于把失败归因说清楚。 */
  sourceLabel: string;
  onRetry: () => void;
};

const SKELETON_ROWS = [0, 1, 2];

/**
 * 搜索结果状态面板：空结果、超时截断、请求失败都在这里说明白，
 * 并提供一键重试，避免出现「点一次没反应、只能再点一次」的空表格。
 */
export function SearchStatusPanel({ outcome, sourceLabel, onRetry }: SearchStatusPanelProps) {
  const { state, message, retryable, songCount = 0, elapsedMs = 0 } = outcome;

  // 有结果时不占地方，交给表格自己说话。
  if (state === "ready") return null;

  if (state === "idle") {
    return (
      <div className="search-status idle">
        <IoSearchOutline aria-hidden />
        <p>输入关键词，选择音乐源后开始搜索。</p>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className="search-status loading" role="status" aria-live="polite">
        <div className="search-skeleton" aria-hidden>
          {SKELETON_ROWS.map((row) => (
            <div className="search-skeleton-row" key={row} />
          ))}
        </div>
        <p>正在搜索 {sourceLabel}…</p>
      </div>
    );
  }

  const isError = state === "error";
  const isPartial = state === "partial";
  const title = isError ? "搜索失败" : isPartial ? `${sourceLabel} 响应超时` : "这次没有返回结果";
  const detail = isError
    ? message || "请稍后重试。"
    : isPartial
      ? `已显示 ${songCount} 首${elapsedMs > 0 ? `（耗时 ${(elapsedMs / 1000).toFixed(1)}s）` : ""}，结果可能不全。`
      : message || "音乐源偶尔会失败，重试通常就好。";

  return (
    <div className={`search-status ${isError ? "error" : "warn"}`} role={isError ? "alert" : "status"}>
      <div className="search-status-body">
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {retryable && (
        <button type="button" className="search-status-retry" onClick={onRetry}>
          <IoRefreshOutline aria-hidden />
          <span>重试搜索</span>
        </button>
      )}
    </div>
  );
}