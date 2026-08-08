import { memo, useCallback } from "react";
import type { LyricDim } from "../types";

type LyricLineProps = {
  index: number;
  time: number;
  text: string;
  translation?: string;
  dim: LyricDim;
  onSeek: (time: number) => void;
  registerRef: (index: number, el: HTMLDivElement | null) => void;
};

export const LyricLine = memo(function LyricLine({
  index,
  time,
  text,
  translation,
  dim,
  onSeek,
  registerRef,
}: LyricLineProps) {
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerRef(index, el);
    },
    [index, registerRef]
  );
  const handleClick = useCallback(() => {
    onSeek(time);
  }, [onSeek, time]);

  return (
    <div ref={setRef} className="overlay-lyric-line" data-dim={dim} onClick={handleClick}>
      <span className="overlay-lyric-original">{text}</span>
      {translation && <span className="overlay-lyric-translation">{translation}</span>}
    </div>
  );
});
