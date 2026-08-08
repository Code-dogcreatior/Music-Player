import { useCallback, useEffect, useState } from "react";
import { errorMessage, requestJson } from "../api";

export type AppUpdateInfo = {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  can_auto_update: boolean;
  packaged: boolean;
  release_url: string;
  release_notes: string;
  published_at: string;
  asset_name: string;
  asset_size: number;
  message: string;
};

export type AppUpdateDownload = {
  status: "idle" | "downloading" | "verifying" | "ready" | "installing" | "failed";
  percent: number;
  downloaded_bytes: number;
  total_bytes: number;
  message: string;
  error: string;
  version: string;
  ready_to_install: boolean;
};

export type AppUpdateController = {
  info: AppUpdateInfo | null;
  download: AppUpdateDownload;
  checking: boolean;
  checkError: string;
  dismissed: boolean;
  checkForUpdate: (force?: boolean) => Promise<void>;
  startDownload: () => Promise<void>;
  installAndRestart: () => Promise<void>;
  dismiss: () => void;
};

const EMPTY_DOWNLOAD: AppUpdateDownload = {
  status: "idle",
  percent: 0,
  downloaded_bytes: 0,
  total_bytes: 0,
  message: "",
  error: "",
  version: "",
  ready_to_install: false,
};

export function useAppUpdate(): AppUpdateController {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [download, setDownload] = useState<AppUpdateDownload>(EMPTY_DOWNLOAD);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [dismissed, setDismissed] = useState(false);

  const checkForUpdate = useCallback(async (force = false) => {
    setChecking(true);
    setCheckError("");
    try {
      const { data } = await requestJson<AppUpdateInfo>(`/api/update/check${force ? "?force=true" : ""}`, {
        timeoutMs: 18_000,
      });
      setInfo(data);
      if (data.update_available) setDismissed(false);
    } catch (error) {
      setCheckError(errorMessage(error, "检查更新失败"));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void checkForUpdate(false), 3500);
    return () => window.clearTimeout(timer);
  }, [checkForUpdate]);

  const refreshDownloadStatus = useCallback(async () => {
    try {
      const { data } = await requestJson<AppUpdateDownload>("/api/update/status", { timeoutMs: 8_000 });
      setDownload(data);
    } catch (error) {
      setDownload((previous) => ({
        ...previous,
        status: "failed",
        error: errorMessage(error, "读取更新进度失败"),
      }));
    }
  }, []);

  useEffect(() => {
    if (download.status !== "downloading" && download.status !== "verifying") return;
    const timer = window.setInterval(() => void refreshDownloadStatus(), 800);
    return () => window.clearInterval(timer);
  }, [download.status, refreshDownloadStatus]);

  const startDownload = useCallback(async () => {
    try {
      const { data } = await requestJson<AppUpdateDownload>("/api/update/download", {
        method: "POST",
        timeoutMs: 20_000,
      });
      setDownload(data);
    } catch (error) {
      setDownload((previous) => ({
        ...previous,
        status: "failed",
        error: errorMessage(error, "开始下载更新失败"),
      }));
    }
  }, []);

  const installAndRestart = useCallback(async () => {
    try {
      setDownload((previous) => ({ ...previous, status: "installing", message: "正在准备安装更新" }));
      await requestJson("/api/update/apply", { method: "POST", timeoutMs: 15_000 });
    } catch (error) {
      setDownload((previous) => ({
        ...previous,
        status: "failed",
        error: errorMessage(error, "启动更新安装失败"),
      }));
    }
  }, []);

  return {
    info,
    download,
    checking,
    checkError,
    dismissed,
    checkForUpdate,
    startDownload,
    installAndRestart,
    dismiss: () => setDismissed(true),
  };
}
