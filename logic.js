(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LernzeitLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function consolidateEntries(items) {
    const batches = new Map();
    items.forEach(entry => {
      const key = entry.groupIds
        ? entry.id
        : `${entry.ownerId || "local"}:${entry.createdAt}`;
      const existing = batches.get(key);
      if (!existing) {
        batches.set(key, {
          ...entry,
          groupIds: entry.groupIds || (entry.groupId ? [entry.groupId] : []),
          linkedEntryIds: entry.linkedEntryIds || [entry.id]
        });
        return;
      }
      if (entry.groupId && !existing.groupIds.includes(entry.groupId)) existing.groupIds.push(entry.groupId);
      if (!existing.linkedEntryIds.includes(entry.id)) existing.linkedEntryIds.push(entry.id);
    });
    return [...batches.values()];
  }

  function isoDayNumber(value) {
    const [year, month, day] = value.split("-").map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  }

  function calculateStreaks(items, todayISO) {
    const today = isoDayNumber(todayISO);
    const days = [...new Set(items.map(entry => entry.date))]
      .filter(Boolean)
      .map(isoDayNumber)
      .filter(day => day <= today)
      .sort((a, b) => a - b);
    if (!days.length) return { current: 0, best: 0 };

    let best = 1;
    let run = 1;
    for (let index = 1; index < days.length; index++) {
      run = days[index] === days[index - 1] + 1 ? run + 1 : 1;
      best = Math.max(best, run);
    }

    const learnedDays = new Set(days);
    let cursor = learnedDays.has(today) ? today : today - 1;
    let current = 0;
    while (learnedDays.has(cursor)) {
      current++;
      cursor--;
    }
    return { current, best };
  }

  function calculateTimeBalance(items) {
    const learnedMinutes = items.reduce((total, entry) => total + entry.minutes, 0);
    const elapsedMinutes = items.reduce((total, entry) => {
      const elapsed = entry.elapsedMinutes ?? entry.minutes;
      return total + Math.max(entry.minutes, elapsed);
    }, 0);
    return {
      learnedMinutes,
      elapsedMinutes,
      unfocusedMinutes: elapsedMinutes - learnedMinutes,
      focusRate: elapsedMinutes ? Math.round(learnedMinutes / elapsedMinutes * 100) : 0
    };
  }

  return { consolidateEntries, calculateStreaks, calculateTimeBalance };
});
