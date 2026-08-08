import { LuRepeat, LuRepeat1 } from "react-icons/lu";

const repeatIconProps = { strokeWidth: 1.5, "aria-hidden": true as const };

/** Lucide repeat：https://lucide.dev/icons/repeat */
export function RepeatIcon() {
  return <LuRepeat {...repeatIconProps} />;
}

/** Lucide repeat-1：https://lucide.dev/icons/repeat-1 */
export function RepeatOneIcon() {
  return <LuRepeat1 {...repeatIconProps} />;
}
