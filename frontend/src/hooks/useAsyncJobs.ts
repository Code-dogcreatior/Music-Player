import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { isAbortError, requestJson } from "../api";
import type { Song } from "../types";

export type SearchJobResponse = {
  job_id?: string;
  status?: string;
  total_sources?: number;
  done_sources?: number;
  message?: string;
  error?: string;
  detail?: string;
  songs?: Song[];
  cached?: boolean;
  /** 后端整体超时截断时为 true，此时结果可能不全。 */
  timed_out?: boolean;
  /** 每个源实际尝试次数（空结果自动重试后 >1），供界面与灰测观察。 */
  source_attempts?: Record<string, number>;
  search_elapsed_ms?: number;
};

export type DownloadJobResponse = {
  status?: string;
  total?: number;
  done?: number;
  error?: string;
};

export type DownloadToast = {
  visible: boolean;
  status: "queued" | "running" | "finished" | "failed";
  title: string;
  detail?: string;
  percent: number;
};

export type SearchOutcomeState = "idle" | "loading" | "ready" | "empty" | "partial" | "error";

/** 搜索结果状态：空结果/超时截断/失败都要能被界面区分，不再静默。 */
export type SearchOutcome = {
  state: SearchOutcomeState;
  /** 面向用户的补充说明；error 时是失败原因。 */
  message?: string;
  retryable: boolean;
  songCount?: number;
  elapsedMs?: number;
};

export const IDLE_SEARCH_OUTCOME: SearchOutcome = { state: "idle", retryable: false };
export const LOADING_SEARCH_OUTCOME: SearchOutcome = { state: "loading", retryable: false };

/** 把后端响应统一翻译成界面状态。 */
export function describeSearchResult(data: SearchJobResponse): SearchOutcome {
  const songCount = (data.songs ?? []).length;
  const elapsedMs = Number(data.search_elapsed_ms || 0);

  if (data.status === "failed") {
    return {
      state: "error",
      retryable: true,
      songCount: 0,
      message: data.error || data.message || "搜索失败",
    };
  }

  if (songCount === 0) {
    return {
      state: "empty",
      retryable: true,
      songCount: 0,
      elapsedMs,
      message: data.timed_out ? "音乐源响应超时，未能返回结果。" : "",
    };
  }

  return {
    state: data.timed_out ? "partial" : "ready",
    retryable: Boolean(data.timed_out),
    songCount,
    elapsedMs,
  };
}

export function searchErrorOutcome(message: string): SearchOutcome {
  return { state: "error", retryable: true, songCount: 0, message };
}

type UseAsyncJobsOptions = {
  jobId: string;
  setJobId: Dispatch<SetStateAction<string>>;
  searchJobId: string;
  setSearchJobId: Dispatch<SetStateAction<string>>;
  setSongs: Dispatch<SetStateAction<Song[]>>;
  setSelectedIndexes: Dispatch<SetStateAction<Set<number>>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setSearchOutcome: Dispatch<SetStateAction<SearchOutcome>>;
};

export function cancelController(ref: MutableRefObject<AbortController | null>) {
  ref.current?.abort();
  ref.current = null;
}

export function nextController(ref: MutableRefObject<AbortController | null>): AbortController {
  cancelController(ref);
  const controller = new AbortController();
  ref.current = controller;
  return controller;
}

export function waitForMsOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: number | null = null;
    const cleanup = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = window.setTimeout(finish, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function downloadToastTitle(status: DownloadToast["status"]) {
  if (status === "finished") return "下载完成";
  if (status === "failed") return "下载失败";
  if (status === "running") return "正在下载";
  return "已提交下载";
}

export function useAsyncJobs({
  jobId,
  setJobId,
  searchJobId,
  setSearchJobId,
  setSongs,
  setSelectedIndexes,
  setLoading,
  setSearchOutcome,
}: UseAsyncJobsOptions) {
  const [downloadToast, setDownloadToast] = useState<DownloadToast | null>(null);
  const searchPollAbortRef = useRef<AbortController | null>(null);
  const searchSubmitLockRef = useRef(false);
  const downloadPollAbortRef = useRef<AbortController | null>(null);
  const downloadToastTimerRef = useRef<number | null>(null);
  const downloadToastDismissedRef = useRef(false);

  const showDownloadToast = useCallback((next: Omit<DownloadToast, "visible">, autoHideMs = 0) => {
    if (downloadToastDismissedRef.current && (next.status === "queued" || next.status === "running")) return;
    if (downloadToastTimerRef.current !== null) {
      window.clearTimeout(downloadToastTimerRef.current);
      downloadToastTimerRef.current = null;
    }
    setDownloadToast({ ...next, visible: true });
    if (autoHideMs > 0) {
      downloadToastTimerRef.current = window.setTimeout(() => {
        setDownloadToast((current) => (current && current.status === next.status ? { ...current, visible: false } : current));
        downloadToastTimerRef.current = null;
      }, autoHideMs);
    }
  }, []);

  const hideDownloadToast = useCallback(() => {
    downloadToastDismissedRef.current = true;
    if (downloadToastTimerRef.current !== null) {
      window.clearTimeout(downloadToastTimerRef.current);
      downloadToastTimerRef.current = null;
    }
    setDownloadToast((current) => (current ? { ...current, visible: false } : current));
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: number | null = null;
    const controller = nextController(downloadPollAbortRef);

    const poll = async () => {
      try {
        const { data } = await requestJson<DownloadJobResponse>(`/api/download/${jobId}`, {
          timeoutMs: 8_000,
          signal: controller.signal,
        });
        if (cancelled) return;
        if (data.status === "running") {
          const total = Number(data.total || 0);
          const done = Number(data.done || 0);
          const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
          showDownloadToast({
            status: "running",
            title: downloadToastTitle("running"),
            detail: total > 0 ? `${done}/${total} 首` : "正在处理下载队列",
            percent,
          });
          timer = window.setTimeout(poll, 1200);
        } else if (data.status === "finished") {
          downloadToastDismissedRef.current = false;
          showDownloadToast(
            {
              status: "finished",
              title: downloadToastTitle("finished"),
              detail: "歌曲已保存到本地音乐库",
              percent: 100,
            },
            3200,
          );
          setJobId("");
          setSelectedIndexes(new Set());
        } else if (data.status === "failed") {
          downloadToastDismissedRef.current = false;
          showDownloadToast(
            {
              status: "failed",
              title: downloadToastTitle("failed"),
              detail: data.error || "请稍后重试",
              percent: 0,
            },
            5200,
          );
          setJobId("");
        } else {
          timer = window.setTimeout(poll, 1200);
        }
      } catch (error) {
        if (cancelled || isAbortError(error)) return;
        showDownloadToast({
          status: "running",
          title: "下载状态暂不可用",
          detail: "正在重试读取进度",
          percent: 0,
        });
        timer = window.setTimeout(poll, 1500);
      }
    };

    timer = window.setTimeout(poll, 300);
    return () => {
      cancelled = true;
      cancelController(downloadPollAbortRef);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [jobId, setJobId, setSelectedIndexes, showDownloadToast]);

  useEffect(() => {
    if (!searchJobId) return;
    let cancelled = false;
    let timer: number | null = null;
    const controller = nextController(searchPollAbortRef);

    const applySearchData = (data: SearchJobResponse) => {
      const searchSongs = (data.songs ?? []) as Song[];
      setSongs(searchSongs);
      setSelectedIndexes(new Set());
    };

    const poll = async () => {
      try {
        const { data } = await requestJson<SearchJobResponse>(`/api/search/${searchJobId}`, {
          // QQ 等多源串行解析常超过 8s；超时后应继续轮询，而不是静默停住。
          timeoutMs: 30_000,
          signal: controller.signal,
        });
        if (cancelled) return;

        applySearchData(data);
        if (data.status === "finished" || data.status === "failed") {
          // 空结果、超时截断、失败都要如实上报，避免出现「无提示的空表格」。
          setSearchOutcome(describeSearchResult(data));
          setLoading(false);
          setSearchJobId("");
          searchSubmitLockRef.current = false;
          return;
        }
        timer = window.setTimeout(poll, 700);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        if (isAbortError(error)) {
          timer = window.setTimeout(poll, 1000);
          return;
        }
        setSearchOutcome(searchErrorOutcome("搜索请求失败，请确认后端仍在运行。"));
        setLoading(false);
        setSearchJobId("");
        searchSubmitLockRef.current = false;
      }
    };

    timer = window.setTimeout(poll, 250);
    return () => {
      cancelled = true;
      cancelController(searchPollAbortRef);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [searchJobId, setLoading, setSearchJobId, setSearchOutcome, setSelectedIndexes, setSongs]);

  useEffect(() => {
    return () => {
      if (downloadToastTimerRef.current !== null) window.clearTimeout(downloadToastTimerRef.current);
      cancelController(searchPollAbortRef);
      searchSubmitLockRef.current = false;
      cancelController(downloadPollAbortRef);
    };
  }, []);

  return {
    downloadToast,
    showDownloadToast,
    hideDownloadToast,
    searchSubmitLockRef,
    downloadToastDismissedRef,
    cancelSearchPoll: () => cancelController(searchPollAbortRef),
    cancelDownloadPoll: () => cancelController(downloadPollAbortRef),
  };
}
