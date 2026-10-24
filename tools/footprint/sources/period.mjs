// The period of a source as the report reads it: an action belongs to the working day `workingDay`
// (report.mjs) gives it in --tz with the user's `day_starts`, so an action shortly after midnight
// that falls before the day's start belongs to the day before — and one after `until`'s midnight
// still to `until`. Sources keep exactly the actions whose working day lies in the period.
import { addDays, workingDay, zonedMidnight } from '../report.mjs';

const MINUTE_MS = 60_000;

/**
 * Whether the action at `at` belongs to a working day of the period.
 *
 * @param {string|number} at an ISO instant or ms
 * @param {{ since: string, until: string, tz: string, dayStartsMin?: number }} period
 *   `dayStartsMin` the working day's start in minutes after midnight (places.mjs `dayStartsMin`)
 * @returns {boolean} false for a time that cannot be read
 */
export function inWorkingPeriod(at, { since, until, tz, dayStartsMin = 0 }) {
  const t = typeof at === 'number' ? at : Date.parse(at || '');
  if (Number.isNaN(t)) return false;
  const { date } = workingDay(t, tz, dayStartsMin);
  return date >= since && date <= until;
}

/**
 * The working day of the action at `at`: `YYYY-MM-DD`.
 *
 * @param {string|number} at an ISO instant or ms
 * @param {{ tz: string, dayStartsMin?: number }} period
 * @returns {string}
 */
export const workingDate = (at, { tz, dayStartsMin = 0 }) => workingDay(typeof at === 'number' ? at : Date.parse(at), tz, dayStartsMin).date;

/** How much wider than the period an API's bounds are on each side: a daylight-saving change. */
const SLACK_MS = 60 * MINUTE_MS;

/**
 * The instants that bound the period for an API that takes them: from the start of `since`'s
 * working day to the start of the working day after `until`, an hour wider on each side (a
 * daylight-saving change on either day may move a working day's start by an hour). An API bound
 * only: the actions are kept exactly by `inWorkingPeriod`.
 *
 * @param {{ since: string, until: string, tz: string, dayStartsMin?: number }} period
 * @returns {{ from: number, to: number }} ms since the epoch, `to` excluded
 */
export function periodBounds({ since, until, tz, dayStartsMin = 0 }) {
  return {
    from: zonedMidnight(since, tz) + dayStartsMin * MINUTE_MS - SLACK_MS,
    to: zonedMidnight(addDays(until, 1), tz) + dayStartsMin * MINUTE_MS + SLACK_MS,
  };
}
