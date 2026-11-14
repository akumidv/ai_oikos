// Working days and weeks in one time zone: the date arithmetic the report and its fact sections share.
// report.mjs re-exports these, so the sources keep importing them from there.

const DAY_MS = 86_400_000;
/** Minutes in a day: a minute at or past it belongs to the day after its working day's date. */
export const DAY_MINUTES = 1440;

/**
 * The date `n` days after `date`.
 *
 * @param {string} date `YYYY-MM-DD`
 * @param {number} n days, negative for before
 * @returns {string} `YYYY-MM-DD`
 */
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Every date of a period.
 *
 * @param {string} since the first date, `YYYY-MM-DD`
 * @param {string} until the last date, included
 * @returns {string[]} the dates in order
 */
export function daysOf(since, until) {
  const days = [];
  for (let d = since; d <= until; d = addDays(d, 1)) days.push(d);
  return days;
}

/**
 * The Monday of the week of `date`.
 *
 * @param {string} date `YYYY-MM-DD`
 * @returns {string} `YYYY-MM-DD`
 */
export function weekOf(date) {
  const wd = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -wd);
}

/**
 * The local date and time of an instant.
 *
 * @param {number|string|Date} instant ms, an ISO string or a Date
 * @param {string} tz an IANA time zone
 * @returns {{ date: string, time: string }} `YYYY-MM-DD` and `HH:MM` in `tz`
 * @throws {RangeError} when `instant` is not a valid time
 */
export function localParts(instant, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * The working day of an instant and its minute in that day: a working day begins at `startMin`
 * past local midnight, so an action before it belongs to the day before, at a minute of 1440 or
 * more (shown `01:30+1`). With `startMin` 0 it is the local date and time.
 *
 * @param {number|string|Date} instant ms, an ISO string or a Date
 * @param {string} tz an IANA time zone
 * @param {number} [startMin] minutes past midnight at which a working day begins, 0–1439
 * @returns {{ date: string, minute: number }} `YYYY-MM-DD` and the minute since that date's midnight
 * @throws {RangeError} when `instant` is not a valid time
 */
export function workingDay(instant, tz, startMin = 0) {
  const { date, time } = localParts(instant, tz);
  const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return minute < startMin ? { date: addDays(date, -1), minute: minute + DAY_MINUTES } : { date, minute };
}
