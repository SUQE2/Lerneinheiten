const test = require("node:test");
const assert = require("node:assert/strict");
const { consolidateEntries, calculateStreaks, calculateTimeBalance } = require("../logic.js");

test("legacy multi-group rows count as one personal entry", () => {
  const entries = consolidateEntries([
    { id: "a", ownerId: "user", groupId: "group-a", createdAt: 100, date: "2026-07-18", minutes: 240 },
    { id: "b", ownerId: "user", groupId: "group-b", createdAt: 100, date: "2026-07-18", minutes: 240 }
  ]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].groupIds, ["group-a", "group-b"]);
  assert.deepEqual(entries[0].linkedEntryIds, ["a", "b"]);
});

test("canonical entries with associations stay independent", () => {
  const entries = consolidateEntries([
    { id: "a", ownerId: "user", groupIds: ["group-a", "group-b"], createdAt: 100 },
    { id: "b", ownerId: "user", groupIds: ["group-a"], createdAt: 100 }
  ]);
  assert.equal(entries.length, 2);
});

test("current and best learning streaks are calculated independently", () => {
  const entries = [
    { date: "2026-07-10" }, { date: "2026-07-11" }, { date: "2026-07-12" },
    { date: "2026-07-16" }, { date: "2026-07-17" }, { date: "2026-07-18" },
    { date: "2026-07-18" }
  ];
  assert.deepEqual(calculateStreaks(entries, "2026-07-18"), { current: 3, best: 3 });
});

test("a streak remains active until the end of a day without an entry", () => {
  const entries = [{ date: "2026-07-16" }, { date: "2026-07-17" }, { date: "2026-07-20" }, { date: "2026-07-21" }, { date: "2026-07-22" }];
  assert.deepEqual(calculateStreaks(entries, "2026-07-18"), { current: 2, best: 2 });
});

test("learning time is compared with the full seated time", () => {
  const balance = calculateTimeBalance([
    { minutes: 45, elapsedMinutes: 60 },
    { minutes: 30, elapsedMinutes: 90 }
  ]);
  assert.deepEqual(balance, {
    learnedMinutes: 75,
    elapsedMinutes: 150,
    unfocusedMinutes: 75,
    focusRate: 50
  });
});

test("legacy entries count as fully focused", () => {
  assert.deepEqual(calculateTimeBalance([{ minutes: 40 }]), {
    learnedMinutes: 40,
    elapsedMinutes: 40,
    unfocusedMinutes: 0,
    focusRate: 100
  });
});
