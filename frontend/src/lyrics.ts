import type { LyricDim, LyricLine } from "./types";

function parseLrcOffsetSeconds(text: string): number {
  // LRC 常见格式：[offset:500] / [offset:+500] / [offset:-500]，单位毫秒
  const match = text.match(/\[offset\s*:\s*([+-]?\d+)\s*\]/i);
  if (!match) return 0;
  const offsetMs = Number(match[1]);
  if (!Number.isFinite(offsetMs)) return 0;
  return offsetMs / 1000;
}

export function parseLrc(text: string): LyricLine[] {
  const lines = text.split(/\r?\n/);
  const parsed: LyricLine[] = [];
  const pattern = /\[(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)\]/g;
  const offsetSec = parseLrcOffsetSeconds(text);
  for (const line of lines) {
    const matches = [...line.matchAll(pattern)];
    if (matches.length === 0) continue;
    const lyricText = line.replace(pattern, "").trim();
    if (!lyricText) continue;
    for (const m of matches) {
      const minute = Number(m[1]);
      const second = Number(m[2]);
      const time = Math.max(0, minute * 60 + second + offsetSec);
      parsed.push({ time, text: lyricText });
    }
  }
  return parsed.sort((a, b) => a.time - b.time);
}

export function mergeTranslatedLrc(source: LyricLine[], translatedText: string): LyricLine[] {
  if (!translatedText.trim()) return source;
  const translated = parseLrc(translatedText);
  const translationMap = new Map(translated.map((line) => [line.time.toFixed(3), line.text]));
  return source.map((line) => ({
    ...line,
    translation: translationMap.get(line.time.toFixed(3)) || "",
  }));
}

export function shouldOfferChineseTranslation(lines: LyricLine[]): boolean {
  const meaningful = lines.filter((line) => {
    const text = line.text.trim();
    return text && text !== "...";
  });
  if (meaningful.length === 0) return false;

  const japaneseCount = meaningful.filter((line) => /[\u3040-\u30ff\u31f0-\u31ff]/.test(line.text)).length;
  if (japaneseCount > 0) return true;

  const nonChineseCount = meaningful.filter((line) => {
    const text = line.text.replace(/[^\p{L}\p{N}]/gu, "");
    if (!text) return false;
    const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    return cjkCount / text.length < 0.65;
  }).length;
  return nonChineseCount / meaningful.length > 0.3;
}

export function dimOf(index: number, active: number): LyricDim {
  if (active < 0) return "far";
  if (index === active) return "active";
  const d = Math.abs(index - active);
  if (d <= 2) return "near";
  if (d <= 4) return "mid";
  return "far";
}

export function findActiveLyricIndexByTime(timeSec: number, sourceLyrics: LyricLine[]): number {
  if (!sourceLyrics.length) return -1;
  let low = 0;
  let high = sourceLyrics.length - 1;
  let idx = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (sourceLyrics[mid].time <= timeSec) {
      idx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return idx;
}
