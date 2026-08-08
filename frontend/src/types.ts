export type Song = {
  song_name?: string;
  singers?: string[] | string;
  album?: string;
  source?: string;
  duration?: string;
  file_size?: string;
  download_url?: string;
  lrc?: string;
  lyric?: string;
  lyrics?: string;
  lyric_url?: string;
  lrc_url?: string;
  lyric_path?: string;
  audio_parse_source?: string;
  lyric_parse_source?: string;
  stream_url?: string;
  file_path?: string;
  relative_path?: string;
  cover?: string;
  album_cover?: string;
  cover_url?: string;
  pic?: string;
  pic_url?: string;
  picture?: string;
  img?: string;
  image?: string;
  album_img?: string;
  album_pic?: string;
  song_id?: string;
  is_recommendation?: boolean;
  recommendation_reason?: string;
  recommendation_source?: string;
};

export type LyricLine = {
  time: number;
  text: string;
  translation?: string;
};

export type LyricDim = "active" | "near" | "mid" | "far";
export type ActiveView = "recommendations" | "search" | "downloaded" | "settings";
export type LyricsDisplayMode = "full" | "performance";
export type PlayMode = "order" | "shuffle";
export type TranslateProvider = "ali" | "dp";
