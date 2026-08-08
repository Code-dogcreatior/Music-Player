import { API_BASE } from "./api";
import type { Song } from "./types";

export function getSongArtists(song: Song): string {
  return Array.isArray(song.singers) ? song.singers.join(", ") : String(song.singers ?? "-");
}

export function toAbsoluteUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `${API_BASE}${url}`;
  return "";
}

export function getCoverUrl(song: Song | null): string {
  if (!song) return "";
  const raw =
    song.cover ||
    song.album_cover ||
    song.cover_url ||
    song.pic ||
    song.pic_url ||
    song.picture ||
    song.img ||
    song.image ||
    song.album_img ||
    song.album_pic ||
    "";
  return toAbsoluteUrl(raw);
}

export function isSameSong(a: Song, b: Song): boolean {
  if (a.file_path && b.file_path) return a.file_path === b.file_path;
  if (a.song_id && b.song_id) return a.song_id === b.song_id;
  if (a.stream_url && b.stream_url) return a.stream_url === b.stream_url;
  if (a.download_url && b.download_url) return a.download_url === b.download_url;
  return (
    (a.song_name || "") === (b.song_name || "") &&
    getSongArtists(a) === getSongArtists(b) &&
    (a.album || "") === (b.album || "")
  );
}
