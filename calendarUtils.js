// ============================================================
// CampusHub — calendar date helpers
// Dates are always plain "YYYY-MM-DD" strings, compared/handled as local
// calendar dates (no timezone math) — this matches <input type="date">.
// ============================================================

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseISODate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO() {
  return toISODate(new Date());
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function weekdayName(date) {
  return WEEKDAY_NAMES[date.getDay()];
}

export function monthName(monthIndex) {
  return MONTH_NAMES[monthIndex];
}

// Sunday-first week containing `date`.
export function startOfWeek(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

export function isDateInRange(dateStr, startStr, endStr) {
  if (!startStr || !endStr) return false;
  return dateStr >= startStr && dateStr <= endStr;
}

// Which semester (1, 2, or null) a given date falls in, given the two
// `semesters` docs ({1: {startDate,endDate}, 2: {...}}).
export function currentSemesterNumber(semesters, dateStr = todayISO()) {
  const s1 = semesters[1], s2 = semesters[2];
  if (s1 && isDateInRange(dateStr, s1.startDate, s1.endDate)) return 1;
  if (s2 && isDateInRange(dateStr, s2.startDate, s2.endDate)) return 2;
  return null;
}

// The next semester due to start after `dateStr` (for a friendly
// "no active semester right now" message). Null if neither is upcoming.
export function nextSemester(semesters, dateStr = todayISO()) {
  const candidates = [semesters[1], semesters[2]].filter((s) => s && s.startDate && s.startDate > dateStr);
  candidates.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return candidates[0] || null;
}

// Every calendar date in [startStr, endStr] (inclusive) whose weekday name
// matches `dayOfWeek` — i.e. every occurrence of a weekly class.
export function datesForWeekdayInRange(dayOfWeek, startStr, endStr) {
  if (!startStr || !endStr || startStr > endStr) return [];
  const out = [];
  let d = parseISODate(startStr);
  const end = parseISODate(endStr);
  let guard = 0;
  while (weekdayName(d) !== dayOfWeek && d <= end && guard < 7) {
    d = addDays(d, 1);
    guard++;
  }
  while (d <= end) {
    out.push(toISODate(d));
    d = addDays(d, 7);
  }
  return out;
}

// Effective status for one class occurrence on one date, applying
// overrides in priority order: a whole day off beats a single-entry
// override, which beats the entry's own default status.
export function effectiveStatus(entry, dateStr, dayOffSet, overrideMap) {
  if (dayOffSet && dayOffSet.has(dateStr)) return "Cancelled";
  const ov = overrideMap && overrideMap.get(entry.id + "_" + dateStr);
  if (ov) return ov.status;
  return entry.status || "Happening";
}

// Build the 6x7 grid of dates (Sun-first) needed to render a month view,
// including the leading/trailing days from neighboring months.
export function monthGridDates(year, monthIndex) {
  const first = new Date(year, monthIndex, 1);
  const gridStart = startOfWeek(first);
  const dates = [];
  for (let i = 0; i < 42; i++) dates.push(addDays(gridStart, i));
  return dates;
}
