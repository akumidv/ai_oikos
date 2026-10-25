// The desk's shared facts (ADR 0006): where it lives in `.local/`, the unit statuses a `plan.md`
// uses, and the `desk:` part of the installation's `oikos.yaml` with its defaults. The `desk` agent's
// tool (tools/desk) and the config reader both use it, so a threshold is spelled once.
//
//   desk: { warm_days: 30, cold_days: 90 }   # compaction thresholds, in days since a topic's last activity

/** The desk's folder under `.local/`: the one name `handoff` keeps for itself (it is not a package). */
export const DESK_FOLDER = 'desk';

/** The status of a unit in a topic's `plan.md`. */
export const UNIT_STATUSES = Object.freeze(['open', 'drafted', 'created', 'sent', 'dropped']);

/** The statuses after which a unit asks nothing more of the desk; a topic is compacted only when all its units are in these. */
export const FINAL_STATUSES = Object.freeze(['created', 'sent', 'dropped']);

/** The retention thresholds when `desk:` does not give them (ADR 0006 D03). */
export const DESK_DEFAULTS = Object.freeze({ warm_days: 30, cold_days: 90 });

const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isDays = (v) => Number.isInteger(v) && v > 0;

/** Every problem of the `desk:` part `desk` (a mapping, maybe empty), each naming its key. */
export function deskProblems(desk) {
  const problems = [];
  if (!isMap(desk)) return problems;
  for (const key of Object.keys(desk)) {
    if (!Object.hasOwn(DESK_DEFAULTS, key)) problems.push(`desk.${key}: unknown key (${Object.keys(DESK_DEFAULTS).join(', ')})`);
    else if (!isDays(desk[key])) problems.push(`desk.${key}: must be a whole number of days, 1 or more (got ${JSON.stringify(desk[key])})`);
  }
  const { warmDays, coldDays } = deskSettings(desk);
  if (!problems.length && coldDays <= warmDays) problems.push(`desk.cold_days (${coldDays}) must be greater than desk.warm_days (${warmDays})`);
  return problems;
}

/** { warmDays, coldDays } of the `desk:` part `desk`, a missing or invalid key taking its default. */
export function deskSettings(desk) {
  const pick = (key) => (isMap(desk) && isDays(desk[key]) ? desk[key] : DESK_DEFAULTS[key]);
  return { warmDays: pick('warm_days'), coldDays: pick('cold_days') };
}
