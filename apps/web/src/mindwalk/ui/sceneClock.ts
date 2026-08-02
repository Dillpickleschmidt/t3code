import type { TimestampFormat } from "@t3tools/contracts";

import { getTimestampFormatOptions, parseTimestampDate } from "../../timestampFormat";

/**
 * A wall-clock reading for the timeline, honouring T3's 12/24-hour setting.
 *
 * Upstream hand-rolls `HH:MM:SS` from `getHours()`. That is a second answer to
 * a question T3 already answers — a user on 12-hour would see one convention
 * in chat and another here — so it goes through the app's own formatter, with
 * seconds kept because a trace's events land inside one minute.
 */
export function sceneClock(iso: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(iso);
  if (!date) return "";
  return new Intl.DateTimeFormat(
    undefined,
    getTimestampFormatOptions(timestampFormat, true),
  ).format(date);
}
