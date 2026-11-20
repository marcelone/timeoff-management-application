'use strict';

/*
 * Worked-time computation (block 2).
 *
 * Definitions, fixed here so they cannot drift between screens:
 *   elapsed   = end − start                      (or now − start while open)
 *   breakTotal= sum of every break duration
 *   countable = sum of breaks with countsAsWork = true
 *   computed  = elapsed − (breaks that do NOT count as worked time)
 *
 * An ACTIVE non-countable break is subtracted up to "now" (we do not present a
 * running personal break as worked time); an active countable break is not
 * subtracted, because it counts as worked time by policy.
 *
 * Everything is computed in milliseconds from UTC instants and floored to whole
 * minutes only at the end, so no rounding accumulates and DST changes cannot
 * distort a duration (never subtract local wall-clock times).
 */

function ms(value) {
  return value ? new Date(value).getTime() : null;
}

/**
 * @param {object} args
 * @param {Date|string} args.startedAt
 * @param {Date|string|null} args.endedAt
 * @param {Array<{startedAt, endedAt, countsAsWork}>} args.breaks
 * @param {Date|string} [args.now] server reference instant for open sessions
 */
function summarize({ startedAt, endedAt, breaks, now }) {
  const startMs = ms(startedAt);
  const referenceMs = endedAt ? ms(endedAt) : ms(now) || Date.now();
  const isOpen = !endedAt;

  const elapsedMs = Math.max(0, referenceMs - startMs);

  let breakMs = 0;
  let countableMs = 0;
  let nonCountableMs = 0;
  let activeBreak = null;

  (breaks || []).forEach((b) => {
    const bStart = ms(b.startedAt);
    const bEnd = b.endedAt ? ms(b.endedAt) : referenceMs;
    // Never count time outside the session window.
    const from = Math.max(startMs, bStart);
    const to = Math.min(referenceMs, bEnd);
    const duration = Math.max(0, to - from);

    breakMs += duration;
    if (b.countsAsWork === true) {
      countableMs += duration;
    } else {
      nonCountableMs += duration;
    }
    if (!b.endedAt) activeBreak = b;
  });

  const computedMs = Math.max(0, elapsedMs - nonCountableMs);

  return {
    isOpen,
    elapsedMinutes: Math.floor(elapsedMs / 60000),
    breakMinutes: Math.floor(breakMs / 60000),
    countableBreakMinutes: Math.floor(countableMs / 60000),
    nonCountableBreakMinutes: Math.floor(nonCountableMs / 60000),
    computedMinutes: Math.floor(computedMs / 60000),
    hasActiveBreak: !!activeBreak,
    activeBreakCountable: activeBreak ? activeBreak.countsAsWork === true : null,
  };
}

/**
 * Computed minutes of a whole local day, across every session that overlaps it.
 *
 * Sessions and breaks are CLIPPED to the local-day window, so:
 *   - several sessions on the same day are added together (a single open session
 *     is not the day total);
 *   - a session that crosses local midnight only contributes the part inside the
 *     day being shown;
 *   - a break is only counted for the part that overlaps both its session and the
 *     window.
 *
 * @param {object} args windowStart/windowEnd local-day bounds as instants,
 *                      now server reference, entries with their breaks
 */
function computedWithinWindow({ windowStart, windowEnd, now, entries }) {
  const wStart = ms(windowStart);
  const wEnd = ms(windowEnd);
  const ref = ms(now) || Date.now();

  let elapsedMs = 0;
  let breakMs = 0;
  let countableMs = 0;
  let nonCountableMs = 0;

  (entries || []).forEach((entry) => {
    const eStart = Math.max(ms(entry.startedAt), wStart);
    const eEnd = Math.min(entry.endedAt ? ms(entry.endedAt) : ref, wEnd);
    if (!(eEnd > eStart)) return;

    elapsedMs += eEnd - eStart;

    (entry.breaks || []).forEach((b) => {
      const bStart = Math.max(ms(b.startedAt), eStart);
      const bRawEnd = b.endedAt ? ms(b.endedAt) : Math.min(ref, eEnd);
      const bEnd = Math.min(bRawEnd, eEnd);
      const duration = Math.max(0, bEnd - bStart);
      breakMs += duration;
      if (b.countsAsWork === true) countableMs += duration;
      else nonCountableMs += duration;
    });
  });

  return {
    elapsedMinutes: Math.floor(elapsedMs / 60000),
    breakMinutes: Math.floor(breakMs / 60000),
    countableBreakMinutes: Math.floor(countableMs / 60000),
    nonCountableBreakMinutes: Math.floor(nonCountableMs / 60000),
    computedMinutes: Math.floor((elapsedMs - nonCountableMs) / 60000),
  };
}

/**
 * Expected minutes between two 'HH:MM' local times on a given local date.
 * Both are parsed in the effective timezone, so a DST day yields its real length
 * instead of a naive 8h.
 */
function expectedMinutesForDay({ day, startTime, endTime, timezone, moment }) {
  if (!startTime || !endTime) return null;
  const zone = timezone || 'UTC';
  const from = moment.tz(`${day} ${startTime}`, 'YYYY-MM-DD HH:mm', zone);
  const to = moment.tz(`${day} ${endTime}`, 'YYYY-MM-DD HH:mm', zone);
  if (!from.isValid() || !to.isValid()) return null;
  const diff = to.diff(from, 'minutes');
  return diff > 0 ? diff : null;
}

module.exports = { summarize, computedWithinWindow, expectedMinutesForDay };