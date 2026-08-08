import { useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";

export function coverUrlForCanvasBlur(absoluteCoverUrl: string): string {
  if (!absoluteCoverUrl) return "";
  try {
    const baseOrigin = API_BASE ? new URL(API_BASE).origin : window.location.origin;
    const cover = new URL(absoluteCoverUrl, window.location.origin);
    const api = new URL(baseOrigin);
    if (cover.origin === api.origin) return absoluteCoverUrl;
  } catch {
    return absoluteCoverUrl;
  }
  return `${API_BASE}/api/cover-proxy?url=${encodeURIComponent(absoluteCoverUrl)}`;
}

let canvasBlurSupportCache: boolean | null = null;
const MAX_BLURRED_COVER_CACHE_SIZE = 6;

export function supportsCanvasBlurFilter(): boolean {
  if (canvasBlurSupportCache !== null) return canvasBlurSupportCache;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 21;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      canvasBlurSupportCache = false;
      return canvasBlurSupportCache;
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.filter = "blur(4px)";
    ctx.fillStyle = "#fff";
    ctx.fillRect(10, 0, 1, 1);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    canvasBlurSupportCache = pixels[6 * 4] > 0 || pixels[14 * 4] > 0;
    return canvasBlurSupportCache;
  } catch {
    canvasBlurSupportCache = false;
    return canvasBlurSupportCache;
  }
}

export function useBlurredOverlayCover(coverUrl: string): { blurredOverlayCover: string; useCssOverlayBlur: boolean } {
  const [blurredOverlayCover, setBlurredOverlayCover] = useState("");
  const [useCssOverlayBlur, setUseCssOverlayBlur] = useState(false);
  const blurredCoverObjectUrlRef = useRef("");
  const blurredCoverCacheRef = useRef<Record<string, string>>({});
  const blurredCoverCacheOrderRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const canvasSrc = coverUrlForCanvasBlur(coverUrl);
    blurredCoverObjectUrlRef.current = "";
    const resetRaf = requestAnimationFrame(() => {
      if (cancelled) return;
      setBlurredOverlayCover("");
      setUseCssOverlayBlur(false);
    });
    if (!coverUrl || !canvasSrc) {
      Object.values(blurredCoverCacheRef.current).forEach((url) => URL.revokeObjectURL(url));
      blurredCoverCacheRef.current = {};
      blurredCoverCacheOrderRef.current = [];
      return () => {
        cancelled = true;
        cancelAnimationFrame(resetRaf);
      };
    }
    if (!supportsCanvasBlurFilter()) {
      const fallbackRaf = requestAnimationFrame(() => {
        if (!cancelled) setUseCssOverlayBlur(true);
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(resetRaf);
        cancelAnimationFrame(fallbackRaf);
      };
    }
    const cached = blurredCoverCacheRef.current[coverUrl];
    if (cached) {
      blurredCoverObjectUrlRef.current = cached;
      blurredCoverCacheOrderRef.current = [
        ...blurredCoverCacheOrderRef.current.filter((key) => key !== coverUrl),
        coverUrl,
      ];
      const cachedRaf = requestAnimationFrame(() => {
        if (!cancelled) setBlurredOverlayCover(cached);
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(resetRaf);
        cancelAnimationFrame(cachedRaf);
      };
    }

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      const size = 180;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const sourceSize = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
      const sx = ((image.naturalWidth || image.width) - sourceSize) / 2;
      const sy = ((image.naturalHeight || image.height) - sourceSize) / 2;
      ctx.filter = "blur(14px) saturate(1.12) brightness(0.72)";
      ctx.drawImage(image, sx, sy, sourceSize, sourceSize, -18, -18, size + 36, size + 36);
      try {
        canvas.toBlob(
          (blob) => {
            if (cancelled || !blob) return;
            const objectUrl = URL.createObjectURL(blob);
            const previousUrl = blurredCoverCacheRef.current[coverUrl];
            if (previousUrl && previousUrl !== objectUrl) URL.revokeObjectURL(previousUrl);
            blurredCoverCacheRef.current[coverUrl] = objectUrl;
            blurredCoverCacheOrderRef.current = [
              ...blurredCoverCacheOrderRef.current.filter((key) => key !== coverUrl),
              coverUrl,
            ];
            while (blurredCoverCacheOrderRef.current.length > MAX_BLURRED_COVER_CACHE_SIZE) {
              const oldestKey = blurredCoverCacheOrderRef.current.shift();
              if (!oldestKey) break;
              const oldestUrl = blurredCoverCacheRef.current[oldestKey];
              if (oldestUrl) URL.revokeObjectURL(oldestUrl);
              delete blurredCoverCacheRef.current[oldestKey];
            }
            blurredCoverObjectUrlRef.current = objectUrl;
            setBlurredOverlayCover(objectUrl);
          },
          "image/jpeg",
          0.84
        );
      } catch {
        setBlurredOverlayCover("");
        setUseCssOverlayBlur(true);
      }
    };
    image.onerror = () => {
      if (!cancelled) {
        setBlurredOverlayCover("");
        setUseCssOverlayBlur(true);
      }
    };
    image.src = canvasSrc;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
      cancelAnimationFrame(resetRaf);
    };
  }, [coverUrl]);

  useEffect(() => {
    return () => {
      Object.values(blurredCoverCacheRef.current).forEach((url) => URL.revokeObjectURL(url));
      blurredCoverCacheRef.current = {};
      blurredCoverCacheOrderRef.current = [];
      blurredCoverObjectUrlRef.current = "";
    };
  }, []);

  return { blurredOverlayCover, useCssOverlayBlur };
}
