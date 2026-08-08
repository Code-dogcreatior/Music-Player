import type { ActiveView } from "../types";

type SidebarProps = {
  activeView: ActiveView;
  isNarrowViewport: boolean;
  narrowSidebarOpen: boolean;
  sources: Record<string, string>;
  selectedSources: string[];
  saveDir: string;
  limit: number;
  onSetActiveView: (view: ActiveView) => void;
  onLoadDownloadedSongs: () => void;
  onCloseNarrowSidebar: () => void;
  onSaveDirChange: (value: string) => void;
  onLimitChange: (value: number) => void;
  onToggleSource: (value: string) => void;
};

export function Sidebar({
  activeView,
  isNarrowViewport,
  narrowSidebarOpen,
  sources,
  selectedSources,
  saveDir,
  limit,
  onSetActiveView,
  onLoadDownloadedSongs,
  onCloseNarrowSidebar,
  onSaveDirChange,
  onLimitChange,
  onToggleSource,
}: SidebarProps) {
  // /api/sources 已按综合优先级返回；前三项显示为综合推荐，其余保持同一顺序。
  const sourceEntries = Object.entries(sources);
  const recommended = sourceEntries.slice(0, 3);
  const others = sourceEntries.slice(3);

  // 单选模式：点击时切换到该源（取消其他源）
  const handleSourceClick = (sourceEn: string) => {
    onToggleSource(sourceEn);
  };

  return (
    <aside id="app-sidebar" className="sidebar">
      {isNarrowViewport && narrowSidebarOpen && (
        <div className="narrow-sidebar-drawer-head">
          <span className="narrow-sidebar-drawer-title">导航与筛选</span>
          <button type="button" className="narrow-sidebar-done" onClick={onCloseNarrowSidebar}>
            完成
          </button>
        </div>
      )}
      <div className="brand">Music</div>
      <div className="section-title">Library</div>
      <div className="menu-list">
        <button
          className={activeView === "recommendations" ? "menu-item active" : "menu-item"}
          onClick={() => onSetActiveView("recommendations")}
        >
          推荐
        </button>
        <button
          className={activeView === "search" ? "menu-item active" : "menu-item"}
          onClick={() => onSetActiveView("search")}
        >
          在线搜索
        </button>
        <button
          className={activeView === "downloaded" ? "menu-item active" : "menu-item"}
          onClick={onLoadDownloadedSongs}
        >
          本地音乐库
        </button>
        <button
          className={activeView === "settings" ? "menu-item active" : "menu-item"}
          onClick={() => onSetActiveView("settings")}
        >
          设置
        </button>
      </div>
      <div className="section-title">下载与搜索</div>
      <label>保存目录</label>
      <input value={saveDir} onChange={(e) => onSaveDirChange(e.target.value)} />
      <label>结果数量/源</label>
      <input
        type="number"
        min={1}
        max={100}
        value={limit}
        onChange={(e) => onLimitChange(Number(e.target.value))}
      />
      <label>综合推荐音乐源（单选）</label>
      <div className="chips">
        {recommended.map(([cn, en]) => (
          <button
            key={en}
            className={selectedSources.includes(en) ? "chip active" : "chip"}
            onClick={() => handleSourceClick(en)}
          >
            {cn}
          </button>
        ))}
      </div>
      {others.length > 0 && (
        <>
          <label>更多音乐源（单选）</label>
          <div className="chips compact">
            {others.map(([cn, en]) => (
              <button
                key={en}
                className={selectedSources.includes(en) ? "chip active" : "chip"}
                onClick={() => handleSourceClick(en)}
              >
                {cn}
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
