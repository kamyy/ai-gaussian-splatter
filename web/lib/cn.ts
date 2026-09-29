/**
 * Joins CSS class names, skipping the falsy ones.
 *
 * cn("a", isOn && "b") gives "a b" when isOn is true and "a" when it isn't. Components use it to combine their own
 * Tailwind classes with conditional ones and with a className passed in by the caller. It wraps the clsx library.
 */

import { type ClassValue, clsx } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(...inputs);
}
