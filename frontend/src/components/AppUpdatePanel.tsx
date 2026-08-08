import type { AppUpdateController } from "../hooks/useAppUpdate";
import { IoCloudDownloadOutline, IoRefreshOutline, IoRocketOutline } from "react-icons/io5";

type AppUpdatePanelProps = {
  update: AppUpdateController;
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const mb = value / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

export function AppUpdatePanel({ update }: AppUpdatePanelProps) {
  const { info, download, checking, checkError } = update;
  const busy = download.status === "downloading" || download.status === "verifying" || download.status === "installing";
  const statusText = download.error || checkError || download.message || info?.message || "可随时检查 GitHub Release";
  const hasError = Boolean(download.error || checkError);
  const statusClassName = hasError
    ? "app-update-status-row error"
    : info?.update_available
      ? "app-update-status-row available"
      : "app-update-status-row ready";

  return (
    <div className="settings-card app-update-card">
      <div className="app-update-heading">
        <div>
          <h2 className="settings-card-title">应用更新</h2>
          <p className="settings-card-desc">通过 GitHub Releases 检查并安装经过 SHA-256 校验的 Windows 更新包。</p>
        </div>
        <span className={info?.update_available ? "app-version-badge available" : "app-version-badge"}>
          v{info?.current_version || "0.1.0"}
        </span>
      </div>

      {info?.update_available && (
        <div className="app-update-release">
          <strong>发现 v{info.latest_version}</strong>
          <span>{formatBytes(info.asset_size)}</span>
          {info.release_notes && <p>{info.release_notes}</p>}
        </div>
      )}

      {(download.status === "downloading" || download.status === "verifying") && (
        <div className="app-update-progress" aria-label={`更新进度 ${download.percent}%`}>
          <div style={{ width: `${download.percent}%` }} />
        </div>
      )}

      <div className={statusClassName}>
        <span className="app-update-status-dot" aria-hidden />
        <div>
          <small>{hasError ? "检查失败" : info?.update_available ? "发现新版本" : "更新状态"}</small>
          <strong>{statusText}</strong>
        </div>
      </div>

      <div className="app-update-actions">
        <button type="button" className="app-update-button" disabled={checking || busy} onClick={() => void update.checkForUpdate(true)}>
          <IoRefreshOutline className={checking ? "spinning" : ""} aria-hidden />
          <span>{checking ? "正在连接 GitHub…" : "检查更新"}</span>
        </button>
        {info?.update_available && info.can_auto_update && download.status !== "ready" && (
          <button type="button" className="app-update-button accent" disabled={busy} onClick={() => void update.startDownload()}>
            <IoCloudDownloadOutline aria-hidden />
            {download.status === "downloading"
              ? `下载中 ${download.percent}%`
              : download.status === "verifying"
                ? "正在校验…"
                : "下载更新"}
          </button>
        )}
        {download.status === "ready" && (
          <button type="button" className="app-update-button install" onClick={() => void update.installAndRestart()}>
            <IoRocketOutline aria-hidden />
            安装并重启
          </button>
        )}
        {info?.update_available && !info.can_auto_update && (
          <span className="app-update-manual">开发模式不执行自动替换，请使用打包版测试更新。</span>
        )}
      </div>
    </div>
  );
}
