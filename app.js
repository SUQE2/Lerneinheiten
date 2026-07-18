const STORAGE_KEY = "lernzeit.entries.v1";
const THEME_KEY = "lernzeit.appearance-theme";
const OFFLINE_QUEUE_PREFIX = "lernzeit.offline-queue";
const categories = {
  studium: { label: "Studium", color: "var(--primary)" },
  arbeit: { label: "Arbeit", color: "var(--orange)" },
  persoenlich: { label: "Persönlich", color: "var(--yellow)" },
  sonstiges: { label: "Sonstiges", color: "var(--blue)" }
};
const dayNames = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const monthNames = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const shortMonths = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const memberColors = ["#713c76", "#ee7658", "#665d9f", "#a64f70", "#efa94f", "#845c91", "#d65f68", "#5f568e", "#8f477a", "#ba694e"];

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const onlineConfig = window.LERNZEIT_CONFIG || {};
const cloudEnabled = Boolean(
  onlineConfig.supabaseUrl &&
  onlineConfig.supabaseAnonKey &&
  window.supabase?.createClient
);
const cloud = cloudEnabled
  ? window.supabase.createClient(onlineConfig.supabaseUrl, onlineConfig.supabaseAnonKey)
  : null;

let entries = [];
let sharedEntries = [];
let session = null;
let profile = null;
let groups = [];
let group = null;
let members = [];
let joinRequests = [];
let auditLogs = [];
let adminSettings = null;
let groupWeeklyGoalMinutes = null;
let ownPendingRequests = 0;
let weeklyGoalMinutes = 600;
let editingEntryId = null;
let editingEntryIds = [];
let editingEntryOwnerId = null;
let installPrompt = null;
let appearanceTheme = localStorage.getItem(THEME_KEY) || "sunset";
let showGroupSetup = false;
let realtimeChannel = null;
let refreshTimer = null;
let toastTimer = null;
let toastActionHandler = null;
let authMode = "login";
let weekCursor = startOfWeek(new Date());
let monthCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let yearCursor = new Date().getFullYear();

function localISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDate(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function addDays(date, amount) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function loadEntries() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function saveEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function formatDuration(minutes) {
  if (!minutes) return "0 Min.";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hours) return `${mins} Min.`;
  return mins ? `${hours} Std. ${mins} Min.` : `${hours} Std.`;
}

function compactDuration(minutes) {
  if (minutes < 60) return `${minutes} Min.`;
  const value = minutes / 60;
  return `${Number.isInteger(value) ? value : value.toFixed(1).replace(".", ",")} Std.`;
}

function sum(items) {
  return items.reduce((total, item) => total + item.minutes, 0);
}

function consolidateOwnEntries(items) {
  return window.LernzeitLogic.consolidateEntries(items);
}

function entryGroupNames(entry) {
  const groupIds = entry.groupIds || (entry.groupId ? [entry.groupId] : []);
  return groupIds.map(groupId => groups.find(item => item.id === groupId)?.name || "Unbekannte Gruppe");
}

function entryBelongsToGroup(entry, groupId) {
  return (entry.groupIds || (entry.groupId ? [entry.groupId] : [])).includes(groupId);
}

function offlineQueueKey() {
  return `${OFFLINE_QUEUE_PREFIX}.${session?.user.id || "guest"}`;
}

function getOfflineQueue() {
  try {
    const queue = JSON.parse(localStorage.getItem(offlineQueueKey()));
    return Array.isArray(queue) ? queue : [];
  } catch {
    return [];
  }
}

function setOfflineQueue(queue) {
  if (queue.length) localStorage.setItem(offlineQueueKey(), JSON.stringify(queue));
  else localStorage.removeItem(offlineQueueKey());
}

function entriesBetween(start, end, source = entries) {
  const from = localISO(start);
  const to = localISO(end);
  return source.filter(entry => entry.date >= from && entry.date <= to);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function applyTheme(theme, persist = true) {
  appearanceTheme = ["sunset", "noir"].includes(theme) ? theme : "sunset";
  document.body.dataset.theme = appearanceTheme;
  if (persist) localStorage.setItem(THEME_KEY, appearanceTheme);
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = appearanceTheme === "noir" ? "#171a1f" : "#342041";
  $$('[data-theme-choice]').forEach(button => {
    const active = button.dataset.themeChoice === appearanceTheme;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function memberName(userId) {
  return members.find(member => member.id === userId)?.displayName || "Gruppenmitglied";
}

function memberColor(userId) {
  const index = Math.max(0, members.findIndex(member => member.id === userId));
  return memberColors[index % memberColors.length];
}

function currentMember() {
  return members.find(member => member.id === session?.user.id);
}

function isGroupAdmin() {
  return ["owner", "admin"].includes(currentMember()?.role);
}

function activeGroupStorageKey() {
  return `lernzeit.active-group.${session?.user.id || "guest"}`;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "?";
}

function renderCategoryList(element, items) {
  const total = sum(items);
  element.innerHTML = Object.entries(categories).map(([key, category]) => {
    const amount = sum(items.filter(entry => entry.category === key));
    const percent = total ? Math.round(amount / total * 100) : 0;
    return `<div>
      <div class="category-name-row"><span class="category-name"><i class="dot ${key}"></i>${category.label}</span><span class="category-value">${formatDuration(amount)} · ${percent}%</span></div>
      <div class="progress-track"><div class="progress-value" style="width:${percent}%;background:${category.color}"></div></div>
    </div>`;
  }).join("");
}

function entryRows(items, emptyText, options = {}) {
  if (!items.length) return `<div class="empty-state">${emptyText}</div>`;
  return [...items]
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
    .map(entry => {
      const date = parseDate(entry.date);
      const category = categories[entry.category] || categories.sonstiges;
      const visibilityLabels = { group: "Gruppe", admins: "Admins", private: "Nur ich" };
      const visibility = options.showVisibility
        ? `<span class="entry-visibility ${entry.visibility}">${visibilityLabels[entry.visibility] || "Privat"}</span> · `
        : "";
      const groupNames = entryGroupNames(entry);
      const groupLabel = options.showGroup
        ? `${escapeHtml(groupNames.length ? groupNames.join(", ") : "Ohne Gruppe")} · `
        : "";
      const owner = options.showOwner ? `<span class="entry-owner">${escapeHtml(memberName(entry.ownerId))}</span> · ${groupLabel}${visibility}` : `${groupLabel}${visibility}`;
      const ownsEntry = !session || entry.ownerId === session.user.id;
      const canEdit = options.allowEdit !== false && (ownsEntry || (options.allowManage && entry.visibility !== "private"));
      const canDelete = options.allowDelete !== false && (ownsEntry || (options.allowManage && entry.visibility !== "private"));
      return `<div class="entry-row">
        <div class="entry-date"><strong>${date.getDate()}</strong><span>${shortMonths[date.getMonth()]}</span></div>
        <div class="entry-info"><strong>${escapeHtml(entry.topic || "Lerneinheit")}</strong><span>${owner}<i class="entry-dot ${entry.category}"></i>${category.label} · ${dayNames[(date.getDay() + 6) % 7]}</span></div>
        <span class="entry-duration">${formatDuration(entry.minutes)}</span>
        <div class="entry-actions">
          ${canEdit ? `<button class="edit-button" data-edit="${entry.id}" aria-label="Eintrag bearbeiten" title="Eintrag bearbeiten">✎</button>` : ""}
          ${canDelete ? `<button class="delete-button" data-delete="${entry.id}" aria-label="Eintrag löschen" title="Eintrag löschen">×</button>` : ""}
        </div>
      </div>`;
    }).join("");
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function renderComparison(element, start, end) {
  if (!session) {
    element.innerHTML = `<div class="comparison-cta"><div><strong>Vergleiche dich mit deinen Freunden</strong>Melde dich an und erstelle eine private Gruppe mit bis zu zehn Personen.</div><button class="primary-button" data-online-action="login">Online starten</button></div>`;
    return;
  }
  if (!group) {
    element.innerHTML = `<div class="comparison-cta"><div><strong>Noch keine Gruppe</strong>Erstelle eine Gruppe oder tritt mit einem Einladungs-Code bei.</div><button class="primary-button" data-online-action="group">Gruppe einrichten</button></div>`;
    return;
  }

  const publicEntries = entriesBetween(start, end, sharedEntries).filter(entry =>
    entryBelongsToGroup(entry, group.id) && entry.visibility === "group"
  );
  const rows = members.map(member => {
    const items = publicEntries.filter(entry => entry.ownerId === member.id);
    return { member, items, total: sum(items) };
  }).sort((a, b) => b.total - a.total || a.member.joinedAt.localeCompare(b.member.joinedAt));
  const maximum = Math.max(...rows.map(row => row.total), 1);

  element.innerHTML = `<div class="comparison-list">${rows.map(({ member, items, total }) => {
    const latest = [...items].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)[0];
    const detail = latest?.topic || (total ? `${items.length} ${items.length === 1 ? "Eintrag" : "Einträge"}` : "Noch keine Lernzeit");
    const color = memberColor(member.id);
    const dots = Object.keys(categories).map(key => {
      const amount = sum(items.filter(entry => entry.category === key));
      return amount ? `<i class="${key}" style="--part:${amount};background:${categories[key].color}"></i>` : "";
    }).join("");
    return `<div class="comparison-row" style="--avatar:${color}">
      <div class="person"><span class="avatar">${initials(member.displayName)}</span><span><strong>${escapeHtml(member.displayName)}${member.id === session.user.id ? " · Du" : ""}</strong><small>${escapeHtml(detail)}</small></span></div>
      <div class="comparison-bar-wrap"><div class="comparison-bar"><span style="--width:${total / maximum * 100}%"></span></div><div class="category-dots">${dots}</div></div>
      <strong class="comparison-total">${compactDuration(total)}</strong>
    </div>`;
  }).join("")}</div>`;
}

function renderWeek() {
  const end = addDays(weekCursor, 6);
  const weekEntries = entriesBetween(weekCursor, end);
  const total = sum(weekEntries);
  const activeDates = new Set(weekEntries.map(entry => entry.date));
  const previousTotal = sum(entriesBetween(addDays(weekCursor, -7), addDays(weekCursor, -1)));
  renderWeekMotivation();

  $("#weekLabel").textContent = `KW ${getWeekNumber(weekCursor)}`;
  $("#weekDateRange").textContent = `${weekCursor.getDate()}. ${shortMonths[weekCursor.getMonth()]} – ${end.getDate()}. ${shortMonths[end.getMonth()]} ${end.getFullYear()}`;
  $("#weekTotal").textContent = formatDuration(total);
  const goalPercent = Math.min(100, Math.round(total / weeklyGoalMinutes * 100));
  $("#goalProgressText").textContent = `${compactDuration(total)} von ${compactDuration(weeklyGoalMinutes)}`;
  $("#goalProgressBar").style.width = `${goalPercent}%`;
  $("#goalRemaining").textContent = total >= weeklyGoalMinutes
    ? `Ziel erreicht – ${formatDuration(total - weeklyGoalMinutes)} darüber.`
    : `Noch ${formatDuration(weeklyGoalMinutes - total)} bis zu deinem Ziel.`;
  $("#activeDays").innerHTML = `${activeDates.size} <small>/ 7</small>`;
  $("#dailyAverage").textContent = formatDuration(activeDates.size ? Math.round(total / activeDates.size) : 0);
  if (!total) $("#weekDelta").textContent = "Noch keine Lernzeit";
  else if (!previousTotal) $("#weekDelta").textContent = "Dein Wochenstart";
  else {
    const delta = Math.round((total - previousTotal) / previousTotal * 100);
    $("#weekDelta").textContent = `${delta >= 0 ? "+" : ""}${delta}% zur Vorwoche`;
  }

  const byCategory = Object.keys(categories)
    .map(key => [key, sum(weekEntries.filter(entry => entry.category === key))])
    .sort((a, b) => b[1] - a[1]);
  $("#topCategory").textContent = byCategory[0][1] ? categories[byCategory[0][0]].label : "–";
  $("#topCategoryDetail").textContent = byCategory[0][1] ? formatDuration(byCategory[0][1]) : "Noch offen";
  $("#weekLegend").innerHTML = Object.entries(categories).map(([key, category]) => `<span><i class="${key}"></i>${category.label}</span>`).join("");

  const daily = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekCursor, index);
    const items = weekEntries.filter(entry => entry.date === localISO(date));
    return { date, items, total: sum(items) };
  });
  const maximum = Math.max(...daily.map(day => day.total), 60);
  const strongestDay = [...daily].sort((a, b) => b.total - a.total)[0];
  const comparisonText = !total
    ? "Noch offen"
    : !previousTotal
      ? "Erster Vergleich"
      : `${Math.round((total - previousTotal) / previousTotal * 100) >= 0 ? "+" : ""}${Math.round((total - previousTotal) / previousTotal * 100)} %`;
  $("#weeklyReview").innerHTML = [
    ["Lerneinheiten", String(weekEntries.length)],
    ["Stärkster Tag", strongestDay?.total ? `${dayNames[(strongestDay.date.getDay() + 6) % 7]} · ${compactDuration(strongestDay.total)}` : "Noch offen"],
    ["Top-Bereich", byCategory[0][1] ? categories[byCategory[0][0]].label : "Noch offen"],
    ["Zur Vorwoche", comparisonText]
  ].map(([label, value]) => `<div class="review-item"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#weekChart").innerHTML = daily.map((day, index) => {
    const height = day.total ? Math.max(7, day.total / maximum * 88) : 2;
    const segments = Object.keys(categories).map(key => {
      const amount = sum(day.items.filter(entry => entry.category === key));
      return amount ? `<div class="stack-segment" style="height:${amount / day.total * 100}%;background:${categories[key].color}"></div>` : "";
    }).join("");
    const today = localISO(day.date) === localISO(new Date());
    return `<div class="day-column"><span class="bar-total">${day.total ? compactDuration(day.total) : ""}</span><div class="stack-bar" style="height:${height}%">${segments}</div><span class="day-label ${today ? "today" : ""}">${dayNames[index]}</span></div>`;
  }).join("");

  renderCategoryList($("#weekCategories"), weekEntries);
  $("#weekEntries").innerHTML = entryRows(weekEntries.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4), "Für diese Woche gibt es noch keine Einträge.");
  renderComparison($("#weekComparison"), weekCursor, end);
}

function renderWeekMotivation() {
  const streak = currentStreak();
  const messages = [
    ["Kleine Schritte werden zu großen Veränderungen.", "Du musst heute nicht alles schaffen – nur anfangen."],
    ["Konstanz schlägt den perfekten Plan.", "Ein konzentrierter Schritt bringt dich deinem Ziel näher."],
    ["Dein zukünftiges Ich wird dir danken.", "Was du heute lernst, macht morgen ein Stück leichter."],
    ["Fortschritt beginnt mit dem nächsten Schritt.", "Auch eine kurze Lerneinheit hält deinen Rhythmus lebendig."],
    ["Nicht alles auf einmal. Nur das Nächste.", "Richte den Blick auf die Aufgabe, die jetzt vor dir liegt."],
    ["Dranbleiben ist eine Entscheidung für dich.", "Jeder Lerntag ist ein Beweis, dass du vorankommst."],
    ["Aus Wiederholung wird Stärke.", "Deine Serie wächst nicht durch Perfektion, sondern durchs Weitermachen."]
  ];
  const dayNumber = Number(localISO(new Date()).replaceAll("-", ""));
  const [title, text] = messages[(dayNumber + streak) % messages.length];
  $("#weekMotivationEyebrow").textContent = streak
    ? `${streak} ${streak === 1 ? "Tag" : "Tage"} · dein Rhythmus`
    : "Dein nächster Schritt";
  $("#weekMotivationTitle").textContent = title;
  $("#weekMotivationText").textContent = streak
    ? text
    : "Trage heute deine erste Lerneinheit ein und starte deinen Rhythmus.";
  $("#weekStreak").textContent = streak;
  $("#weekBestStreak").textContent = `Rekord: ${bestStreak()}`;
}

function renderMonth() {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const last = new Date(year, month + 1, 0);
  const items = entriesBetween(monthCursor, last);
  const total = sum(items);
  const active = new Set(items.map(entry => entry.date)).size;
  $("#monthLabel").textContent = `${monthNames[month]} ${year}`;
  $("#monthTotal").textContent = formatDuration(total);
  $("#monthSessions").textContent = `${items.length} ${items.length === 1 ? "Eintrag" : "Einträge"}`;
  $("#monthActive").textContent = active;
  $("#monthAverage").textContent = formatDuration(active ? Math.round(total / active) : 0);

  const offset = (monthCursor.getDay() + 6) % 7;
  const cells = Array(offset).fill('<div class="calendar-day blank"></div>');
  for (let day = 1; day <= last.getDate(); day++) {
    const date = new Date(year, month, day);
    const amount = sum(items.filter(entry => entry.date === localISO(date)));
    const level = amount === 0 ? 0 : amount < 45 ? 1 : amount < 90 ? 2 : amount < 180 ? 3 : 4;
    const today = localISO(date) === localISO(new Date());
    cells.push(`<div class="calendar-day level-${level} ${today ? "today" : ""}" title="${formatDuration(amount)}"><span>${day}</span><strong>${amount ? compactDuration(amount) : ""}</strong></div>`);
  }
  $("#monthCalendar").innerHTML = cells.join("");
  renderCategoryList($("#monthCategories"), items);
  renderComparison($("#monthComparison"), monthCursor, last);
}

function renderYear() {
  const first = new Date(yearCursor, 0, 1);
  const last = new Date(yearCursor, 11, 31);
  const items = entriesBetween(first, last);
  const totals = Array.from({ length: 12 }, (_, month) => sum(items.filter(entry => parseDate(entry.date).getMonth() === month)));
  const maximum = Math.max(...totals, 60);
  const best = Math.max(...totals);
  const bestIndex = totals.indexOf(best);
  $("#yearLabel").textContent = yearCursor;
  $("#yearHeroYear").textContent = yearCursor;
  $("#yearTotal").textContent = formatDuration(sum(items));
  $("#yearSessions").textContent = `${items.length} ${items.length === 1 ? "Eintrag" : "Einträge"}`;
  $("#yearActiveMonths").innerHTML = `${totals.filter(Boolean).length} <small>/ 12</small>`;
  $("#bestMonth").textContent = best ? monthNames[bestIndex] : "–";
  $("#bestMonthDetail").textContent = best ? formatDuration(best) : "Noch offen";
  $("#yearChart").innerHTML = totals.map((total, month) => {
    const height = total ? Math.max(4, total / maximum * 88) : 2;
    const current = yearCursor === new Date().getFullYear() && month === new Date().getMonth();
    return `<div class="month-column"><span class="month-value" style="--height:${height}%">${total ? compactDuration(total) : ""}</span><div class="month-bar ${current ? "current" : ""}" style="height:${height}%"></div><span class="month-label">${shortMonths[month]}</span></div>`;
  }).join("");
  renderCategoryList($("#yearCategories"), items);
  renderComparison($("#yearComparison"), first, last);
}

function renderAllEntries() {
  const search = $("#entrySearch").value.trim().toLowerCase();
  const category = $("#categoryFilter").value;
  const filtered = entries.filter(entry =>
    (category === "all" || entry.category === category) &&
    (!search || (entry.topic || "Lerneinheit").toLowerCase().includes(search))
  );
  $("#allEntriesTotal").textContent = formatDuration(sum(filtered));
  $("#allEntries").innerHTML = entryRows(filtered, "Keine passenden Einträge gefunden.", { showGroup: true, showVisibility: true });
}

function currentStreak() {
  return window.LernzeitLogic.calculateStreaks(entries, localISO(new Date())).current;
}

function bestStreak() {
  return window.LernzeitLogic.calculateStreaks(entries, localISO(new Date())).best;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function auditDescription(item) {
  const target = escapeHtml(item.details?.targetName || memberName(item.targetUserId));
  const labels = {
    group_created: "hat die Gruppe erstellt",
    join_requested: `${target} hat den Beitritt angefragt`,
    join_approved: `${target} wurde aufgenommen`,
    join_rejected: `Anfrage von ${target} wurde abgelehnt`,
    admin_granted: `${target} wurde zum Admin gemacht`,
    admin_revoked: `${target} wurden Adminrechte entzogen`,
    member_removed: `${target} wurde entfernt`,
    member_left: `${target} hat die Gruppe verlassen`,
    ownership_transferred: `${target} ist jetzt Hauptadmin`,
    group_renamed: `hat die Gruppe in „${escapeHtml(item.details?.name || "–")}“ umbenannt`,
    invite_settings_changed: "hat die Einladungseinstellungen geändert",
    invite_code_rotated: "hat einen neuen Einladungscode erzeugt",
    capacity_changed: `hat die Platzanzahl auf ${Number(item.details?.maxMembers) || "–"} geändert`,
    group_goal_changed: `hat das Wochenziel auf ${compactDuration(Number(item.details?.weeklyMinutes) || 0)} gesetzt`,
    entry_deleted_by_admin: "hat einen Gruppeneintrag gelöscht"
  };
  return labels[item.action] || "hat eine Änderung vorgenommen";
}

function renderGroup() {
  const hasGroups = groups.length > 0;
  const setupVisible = Boolean(session) && (!hasGroups || showGroupSetup);
  $("#groupLoggedOut").classList.toggle("hidden", Boolean(session));
  $("#groupSetup").classList.toggle("hidden", !setupVisible);
  $("#groupDashboard").classList.toggle("hidden", !session || !group || setupVisible);
  if (!session) return;

  $("#welcomeName").textContent = profile?.displayName || "";
  $("#groupSetupTitle").textContent = hasGroups ? "Weitere Gruppe hinzufügen" : "Starte deine Lerngruppe";
  $("#pendingJoinNote").classList.toggle("hidden", ownPendingRequests === 0);
  $("#pendingJoinNote").textContent = ownPendingRequests === 1
    ? "Eine Beitrittsanfrage wartet noch auf die Bestätigung eines Admins."
    : `${ownPendingRequests} Beitrittsanfragen warten noch auf die Bestätigung der Admins.`;
  $("#cancelGroupSetup").classList.toggle("hidden", !hasGroups);
  if (!group) return;
  $("#groupSelector").innerHTML = groups.map(item =>
    `<option value="${item.id}" ${item.id === group.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`
  ).join("");
  $("#groupName").textContent = group.name;
  $("#memberCount").textContent = members.length;
  $("#groupMaxMembers").textContent = group.maxMembers;
  const ownMember = currentMember();
  const administrator = isGroupAdmin();
  const owner = ownMember?.role === "owner";
  const roleLabels = { owner: "Hauptadmin", admin: "Admin", member: "Mitglied" };
  $("#groupRoleLabel").textContent = roleLabels[ownMember?.role] || "Mitglied";
  $("#inviteBox").classList.toggle("hidden", !administrator);
  $("#inviteCode").textContent = adminSettings?.inviteCode || group.inviteCode || "–";
  $("#groupCapacitySelect").value = String(group.maxMembers);
  $("#groupCapacitySelect").disabled = false;
  $("#groupActivityNote").textContent = administrator
    ? "Admins sehen Gruppen- und Admin-Einträge – niemals echte private Einträge"
    : "Du siehst nur Einträge für die ganze Gruppe";
  $$(".admin-only").forEach(element => element.classList.toggle("hidden", !administrator));
  $$(".owner-only").forEach(element => element.classList.toggle("hidden", !owner));
  $("#leaveGroupButton").classList.toggle("hidden", owner);
  $("#renameGroupInput").value = group.name;
  if (adminSettings) {
    $("#inviteEnabled").checked = Boolean(adminSettings.inviteEnabled);
    $("#inviteExpiry").value = adminSettings.inviteExpiresAt
      ? new Date(new Date(adminSettings.inviteExpiresAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
      : "";
  }
  const transferCandidates = members.filter(member => member.id !== session.user.id);
  $("#transferOwnerSelect").innerHTML = transferCandidates.length
    ? transferCandidates.map(member => `<option value="${member.id}">${escapeHtml(member.displayName)}</option>`).join("")
    : '<option value="">Noch kein weiteres Mitglied</option>';
  $("#transferOwnerForm").querySelector("button").disabled = !transferCandidates.length;

  const start = startOfWeek(new Date());
  const end = addDays(start, 6);
  const publicWeekEntries = entriesBetween(start, end, sharedEntries).filter(entry =>
    entryBelongsToGroup(entry, group.id) && entry.visibility === "group"
  );
  const groupWeekTotal = sum(publicWeekEntries);
  if (groupWeeklyGoalMinutes) {
    const groupGoalPercent = Math.min(100, Math.round(groupWeekTotal / groupWeeklyGoalMinutes * 100));
    $("#groupGoalTitle").textContent = `${compactDuration(groupWeekTotal)} von ${compactDuration(groupWeeklyGoalMinutes)}`;
    $("#groupGoalProgressBar").style.width = `${groupGoalPercent}%`;
    $("#groupGoalProgressText").textContent = groupWeekTotal >= groupWeeklyGoalMinutes
      ? `Challenge geschafft – ${formatDuration(groupWeekTotal - groupWeeklyGoalMinutes)} über dem Ziel.`
      : `Noch ${formatDuration(groupWeeklyGoalMinutes - groupWeekTotal)} bis zu eurem Wochenziel.`;
    $("#groupGoalHours").value = Math.floor(groupWeeklyGoalMinutes / 60);
    $("#groupGoalMinutes").value = groupWeeklyGoalMinutes % 60;
  } else {
    $("#groupGoalTitle").textContent = "Noch kein Wochenziel";
    $("#groupGoalProgressBar").style.width = "0%";
    $("#groupGoalProgressText").textContent = administrator
      ? "Lege eine gemeinsame Challenge für diese Woche fest."
      : "Ein Admin kann ein gemeinsames Ziel festlegen.";
  }
  $("#groupMembers").innerHTML = members.map(member => {
    const total = sum(publicWeekEntries.filter(entry => entry.ownerId === member.id));
    const canSetRole = ownMember?.role === "owner" && member.role !== "owner";
    const canRemove = member.id !== session.user.id && member.role !== "owner" &&
      (ownMember?.role === "owner" || (ownMember?.role === "admin" && member.role === "member"));
    const roleControl = canSetRole ? `<label class="member-role-control">Berechtigung
      <select data-member-role="${member.id}">
        <option value="member" ${member.role === "member" ? "selected" : ""}>Mitglied</option>
        <option value="admin" ${member.role === "admin" ? "selected" : ""}>Admin</option>
      </select>
    </label>` : `<span class="member-role-label">${roleLabels[member.role] || "Mitglied"}</span>`;
    const removeControl = canRemove
      ? `<button class="member-remove" type="button" data-remove-member="${member.id}" data-member-name="${escapeHtml(member.displayName)}">Entfernen</button>`
      : "";
    return `<div class="member-card" style="--avatar:${memberColor(member.id)}">
      <span class="avatar">${initials(member.displayName)}</span>
      <strong>${escapeHtml(member.displayName)}${member.id === session.user.id ? " · Du" : ""}</strong>
      ${roleControl}
      <strong class="member-time">${compactDuration(total)}</strong>
      ${removeControl}
    </div>`;
  }).join("");

  const groupEntries = sharedEntries.filter(entry => entryBelongsToGroup(entry, group.id) && entry.visibility !== "private");
  const visibleActivity = (administrator
    ? groupEntries
    : groupEntries.filter(entry => entry.visibility === "group"))
    .slice(0, 20);
  $("#groupActivity").innerHTML = entryRows(
    visibleActivity,
    "Noch keine sichtbaren Einträge in eurer Gruppe.",
    { showOwner: true, showVisibility: administrator, allowDelete: administrator, allowManage: administrator }
  );

  $("#joinRequestCount").textContent = joinRequests.length;
  $("#joinRequests").innerHTML = joinRequests.length ? joinRequests.map(request => `
    <div class="request-row">
      <span class="avatar">${initials(request.displayName)}</span>
      <span><strong>${escapeHtml(request.displayName)}</strong><small>${formatDateTime(request.createdAt)}</small></span>
      <div class="button-row"><button class="text-button" data-decide-request="approve" data-request-user="${request.userId}">Annehmen</button><button class="text-button danger-text" data-decide-request="reject" data-request-user="${request.userId}">Ablehnen</button></div>
    </div>`).join("") : '<div class="empty-state">Keine offenen Beitrittsanfragen.</div>';

  $("#auditLog").innerHTML = auditLogs.length ? auditLogs.map(item => `
    <div class="audit-row"><span>${escapeHtml(item.actorName || "Unbekannt")} ${auditDescription(item)}</span><small>${formatDateTime(item.createdAt)}</small></div>
  `).join("") : '<div class="empty-state">Noch keine Verwaltungsaktionen protokolliert.</div>';
}

function renderAccount() {
  const label = session ? (profile?.displayName || session.user.email) : (cloudEnabled ? "Anmelden" : "Online einrichten");
  $("#accountLabel").textContent = label;
  $("#accountButton").classList.toggle("online", Boolean(session));
  const pendingSync = session ? getOfflineQueue().length : 0;
  $("#storageNote").textContent = !session
    ? "Anmeldung erforderlich."
    : pendingSync
      ? `${pendingSync} ${pendingSync === 1 ? "Eintrag wartet" : "Einträge warten"} auf Synchronisierung.`
      : navigator.onLine
        ? "Deine Daten werden sicher synchronisiert."
        : "Offline – neue Einträge werden vorgemerkt.";
  $$(".auth-required").forEach(element => element.classList.toggle("hidden", !session));
  $("#openEntryButton").classList.toggle("hidden", !session);
  $("#groupLoginButton").textContent = cloudEnabled ? "Anmelden oder registrieren" : "Online-Modus einrichten";
  if (session) {
    $("#accountName").textContent = profile?.displayName || "Dein Konto";
    $("#accountEmail").textContent = session.user.email || "";
    $("#accountDisplayName").value = profile?.displayName || "";
    $("#accountEmailInput").value = session.user.email || "";
  }
}

function renderAll() {
  renderWeek();
  renderMonth();
  renderYear();
  renderAllEntries();
  renderGroup();
  renderAccount();
  $("#sidebarStreak").textContent = currentStreak();
}

function showView(view) {
  const labels = {
    woche: ["Dein Lernfortschritt", "Diese Woche"],
    monat: ["Der größere Blick", "Monatsübersicht"],
    jahr: ["Deine Entwicklung", "Jahresübersicht"],
    eintraege: ["Alles an einem Ort", "Deine Einträge"],
    gruppe: ["Gemeinsam dranbleiben", "Meine Gruppe"]
  };
  if (!session && ["woche", "monat", "jahr", "eintraege"].includes(view)) view = "gruppe";
  $$(".view").forEach(element => element.classList.toggle("active", element.id === `view-${view}`));
  $$(".nav-item").forEach(element => element.classList.toggle("active", element.dataset.view === view));
  $("#viewEyebrow").textContent = labels[view][0];
  $("#viewTitle").textContent = labels[view][1];
  document.body.dataset.view = view;
  history.replaceState(null, "", `#${view}`);
}

function syncVisibilityAvailability() {
  const hasGroup = selectedEntryGroupIds().length > 0;
  $$("input[name=visibility]").forEach(input => {
    input.disabled = !hasGroup && input.value !== "private";
  });
  if (!hasGroup) $("input[name=visibility][value=private]").checked = true;
}

function selectedEntryGroupIds() {
  return $$("input[name=entryGroup]:checked").map(input => input.value);
}

function renderEntryGroupPicker(entry, editingOwnEntry) {
  const selectedGroupIds = new Set(entry?.groupIds || (entry?.groupId ? [entry.groupId] : group?.id ? [group.id] : []));
  const groupSelectionLocked = Boolean(entry?.linkedEntryIds?.length > 1);
  $("#entryGroupPicker").innerHTML = groups.length
    ? groups.map(item => `<label>
        <input type="checkbox" name="entryGroup" value="${item.id}" ${selectedGroupIds.has(item.id) ? "checked" : ""} ${entry && (!editingOwnEntry || groupSelectionLocked) ? "disabled" : ""}>
        <span><span class="group-picker-name">${escapeHtml(item.name)}</span></span>
      </label>`).join("")
    : '<div class="group-picker-empty">Du bist noch in keiner Gruppe. Der Eintrag bleibt privat.</div>';
  $("#entryGroupHint").textContent = groupSelectionLocked
    ? "Dieser gemeinsame Eintrag bleibt den ausgewählten Gruppen zugeordnet."
    : entry
      ? "Du kannst die Gruppenzuordnungen dieses Eintrags ändern."
      : "Du kannst mehrere Gruppen gleichzeitig auswählen.";
}

function openDialog(entry = null) {
  if (!session) {
    openAuthDialog();
    return;
  }
  editingEntryId = entry?.id || null;
  editingEntryIds = entry?.linkedEntryIds || (entry?.id ? [entry.id] : []);
  editingEntryOwnerId = entry?.ownerId || session.user.id;
  const editingOwnEntry = editingEntryOwnerId === session.user.id;
  $("#entryDialogEyebrow").textContent = entry ? "Lerneinheit ändern" : "Neue Lerneinheit";
  $("#entryDialogTitle").textContent = entry ? "Eintrag bearbeiten" : "Lernzeit eintragen";
  $("#entrySubmitButton").textContent = entry ? "Änderungen speichern" : "Eintrag speichern";
  $("#entryDate").value = entry?.date || localISO(new Date());
  $("#entryHours").value = entry ? Math.floor(entry.minutes / 60) : 0;
  $("#entryMinutes").value = entry ? entry.minutes % 60 : 30;
  $("#entryTopic").value = entry?.topic || "";
  if (entry) $(`input[name=category][value=${entry.category}]`).checked = true;
  renderEntryGroupPicker(entry, editingOwnEntry);
  $("#formError").textContent = "";
  const visibility = $(`input[name=visibility][value=${entry?.visibility || (selectedEntryGroupIds().length ? "group" : "private")}]`);
  if (visibility) visibility.checked = true;
  syncVisibilityAvailability();
  $("input[name=visibility][value=private]").disabled = !editingOwnEntry;
  $("#entryDialog").showModal();
}

function showToast(message, action = null) {
  const toast = $("#toast");
  clearTimeout(toastTimer);
  toastActionHandler = action?.handler || null;
  $("#toastMessage").textContent = message;
  $("#toastAction").textContent = action?.label || "Rückgängig";
  $("#toastAction").classList.toggle("hidden", !action);
  toast.classList.add("show");
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    toastActionHandler = null;
  }, action ? 6000 : 2600);
}

$("#toastAction").addEventListener("click", async () => {
  const handler = toastActionHandler;
  toastActionHandler = null;
  $("#toastAction").classList.add("hidden");
  if (handler) await handler();
});

function readableError(error) {
  const message = error?.message || "Etwas ist schiefgelaufen.";
  if (/invalid login credentials/i.test(message)) return "E-Mail oder Passwort ist nicht korrekt.";
  if (/user already registered/i.test(message)) return "Für diese E-Mail gibt es bereits ein Konto.";
  if (/password should be/i.test(message)) return "Das Passwort muss mindestens acht Zeichen lang sein.";
  if (/failed to fetch/i.test(message)) return "Der Online-Dienst ist gerade nicht erreichbar.";
  return message;
}

function openAuthDialog() {
  if (!cloudEnabled) {
    showToast("Der Online-Modus muss zuerst in config.js eingerichtet werden.");
    return;
  }
  authMode = "login";
  updateAuthMode();
  $("#authError").textContent = "";
  $("#authDialog").showModal();
}

function updateAuthMode() {
  const register = authMode === "register";
  $("#authTitle").textContent = register ? "Konto erstellen" : "Anmelden";
  $("#authSubmit").textContent = register ? "Registrieren" : "Anmelden";
  $("#authModeSwitch").textContent = register ? "Schon ein Konto? Anmelden" : "Noch kein Konto? Registrieren";
  $("#displayNameLabel").classList.toggle("hidden", !register);
  $("#forgotPasswordButton").classList.toggle("hidden", register);
  $("#authDisplayName").required = register;
  $("#authPassword").autocomplete = register ? "new-password" : "current-password";
}

function mapCloudEntry(row) {
  const hasGroupAssociations = Array.isArray(row.entry_groups);
  const groupIds = hasGroupAssociations ? row.entry_groups.map(item => item.group_id) : [];
  return {
    id: row.id,
    ownerId: row.user_id,
    groupId: row.group_id,
    ...(hasGroupAssociations ? { groupIds } : {}),
    date: row.entry_date,
    category: row.category,
    minutes: row.minutes,
    topic: row.topic,
    visibility: row.visibility,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at || row.created_at).getTime()
  };
}

async function migrateLocalEntries() {
  const localEntries = loadEntries();
  const marker = `lernzeit.cloud-imported.${session.user.id}`;
  if (!localEntries.length || localStorage.getItem(marker)) return;
  const rows = localEntries.map(entry => ({
    id: crypto.randomUUID(),
    user_id: session.user.id,
    group_id: null,
    entry_date: entry.date,
    category: entry.category,
    minutes: entry.minutes,
    topic: entry.topic || "",
    visibility: "private",
    created_at: new Date(entry.createdAt || Date.now()).toISOString()
  }));
  const { error } = await cloud.from("entries").upsert(rows, { onConflict: "id" });
  if (error) throw error;
  localStorage.setItem(marker, "true");
  showToast(`${rows.length} lokale ${rows.length === 1 ? "Eintrag wurde" : "Einträge wurden"} privat übernommen`);
}

async function fetchCloudEntries() {
  let result = await cloud.from("entries")
    .select("id, user_id, group_id, entry_date, category, minutes, topic, visibility, created_at, updated_at, deleted_at, entry_groups(group_id)")
    .is("deleted_at", null)
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (result.error && /entry_groups|deleted_at/i.test(result.error.message || "")) {
    result = await cloud.from("entries")
      .select("id, user_id, group_id, entry_date, category, minutes, topic, visibility, created_at, updated_at")
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false });
  }
  return result;
}

function commandToEntry(command) {
  return {
    id: command.id,
    ownerId: session.user.id,
    groupId: command.groupIds[0] || null,
    groupIds: command.groupIds,
    linkedEntryIds: [command.id],
    date: command.date,
    category: command.category,
    minutes: command.minutes,
    topic: command.topic,
    visibility: command.groupIds.length ? command.visibility : "private",
    createdAt: command.createdAt,
    updatedAt: Date.now(),
    pendingSync: true
  };
}

function overlayOfflineQueue() {
  if (!session) return;
  const queuedEntries = getOfflineQueue().map(commandToEntry);
  const queuedIds = new Set(queuedEntries.map(entry => entry.id));
  sharedEntries = [...sharedEntries.filter(entry => !queuedIds.has(entry.id)), ...queuedEntries];
  entries = consolidateOwnEntries(sharedEntries.filter(entry => entry.ownerId === session.user.id));
}

function isMissingMultiGroupRpc(error) {
  return /save_learning_entry|schema cache|could not find the function/i.test(error?.message || "");
}

function isConnectionError(error) {
  return !navigator.onLine || /failed to fetch|network|load failed/i.test(error?.message || "");
}

async function persistLearningCommand(command) {
  if (command.managed) {
    return cloud.from("entries").update({
      entry_date: command.date,
      category: command.category,
      minutes: command.minutes,
      topic: command.topic,
      visibility: command.visibility,
      updated_at: new Date().toISOString()
    }).eq("id", command.id);
  }
  let result = await cloud.rpc("save_learning_entry", {
    target_entry_id: command.id,
    target_entry_date: command.date,
    target_category: command.category,
    target_minutes: command.minutes,
    target_topic: command.topic,
    target_visibility: command.visibility,
    target_group_ids: command.groupIds
  });
  if (!result.error || !isMissingMultiGroupRpc(result.error)) return result;

  const payload = {
    entry_date: command.date,
    category: command.category,
    minutes: command.minutes,
    topic: command.topic,
    visibility: command.groupIds.length ? command.visibility : "private",
    updated_at: new Date().toISOString()
  };
  if (command.existingIds?.length) {
    const legacyPayload = command.existingIds.length > 1
      ? payload
      : { ...payload, group_id: command.groupIds[0] || null };
    return cloud.from("entries").update(legacyPayload).in("id", command.existingIds);
  }
  const targetGroupIds = command.groupIds.length ? command.groupIds : [null];
  return cloud.from("entries").insert(targetGroupIds.map((groupId, index) => ({
    ...payload,
    id: index ? crypto.randomUUID() : command.id,
    user_id: session.user.id,
    group_id: groupId,
    created_at: new Date(command.createdAt).toISOString()
  })));
}

function queueLearningCommand(command) {
  const queue = getOfflineQueue().filter(item => item.id !== command.id);
  queue.push(command);
  setOfflineQueue(queue);
  overlayOfflineQueue();
  renderAll();
}

async function flushOfflineQueue() {
  if (!session || !navigator.onLine) return;
  const queue = getOfflineQueue();
  if (!queue.length) return;
  const remaining = [];
  for (const command of queue) {
    const { error } = await persistLearningCommand(command);
    if (error) {
      remaining.push(command);
      if (!isConnectionError(error)) console.error(error);
    }
  }
  setOfflineQueue(remaining);
  if (remaining.length === 0) {
    await loadCloudState();
    showToast(`${queue.length} offline gespeicherte ${queue.length === 1 ? "Lernzeit wurde" : "Lernzeiten wurden"} synchronisiert`);
  }
}

function setEntryFormSaving(saving) {
  const button = $("#entrySubmitButton");
  button.disabled = saving;
  button.setAttribute("aria-busy", String(saving));
  if (saving) {
    button.dataset.label = button.textContent;
    button.textContent = "Wird gespeichert …";
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
}

async function loadCloudState({ migrate = false } = {}) {
  if (!session) return;
  try {
    const userId = session.user.id;
    const profileResult = await cloud.from("profiles").select("id, display_name, appearance_theme").eq("id", userId).single();
    if (profileResult.error) throw profileResult.error;
    profile = {
      id: profileResult.data.id,
      displayName: profileResult.data.display_name,
      appearanceTheme: profileResult.data.appearance_theme || "sunset"
    };
    applyTheme(profile.appearanceTheme);
    const ownRequestsResult = await cloud.from("group_join_requests")
      .select("group_id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "pending");
    if (ownRequestsResult.error) throw ownRequestsResult.error;
    ownPendingRequests = ownRequestsResult.count || 0;

    const membershipResult = await cloud.from("group_members")
      .select("group_id, role, joined_at")
      .eq("user_id", userId)
      .order("joined_at");
    if (membershipResult.error) throw membershipResult.error;
    groups = [];
    group = null;
    members = [];
    joinRequests = [];
    auditLogs = [];
    adminSettings = null;
    groupWeeklyGoalMinutes = null;

    if (membershipResult.data.length) {
      const membershipByGroup = new Map(membershipResult.data.map(item => [item.group_id, item]));
      const groupIds = membershipResult.data.map(item => item.group_id);
      const groupResult = await cloud.from("groups")
        .select("id, name, owner_id, max_members")
        .in("id", groupIds);
      if (groupResult.error) throw groupResult.error;
      const groupDataById = new Map(groupResult.data.map(item => [item.id, item]));
      groups = groupIds.map(id => {
        const item = groupDataById.get(id);
        const membership = membershipByGroup.get(id);
        return item ? {
          id: item.id,
          name: item.name,
          inviteCode: null,
          ownerId: item.owner_id,
          maxMembers: item.max_members,
          role: membership.role,
          joinedAt: membership.joined_at
        } : null;
      }).filter(Boolean);

      const storedGroupId = localStorage.getItem(activeGroupStorageKey());
      group = groups.find(item => item.id === storedGroupId) || groups[0];
      localStorage.setItem(activeGroupStorageKey(), group.id);
      const administrator = ["owner", "admin"].includes(group.role);
      const [membershipsResult, settingsResult, requestsResult, auditResult, groupGoalResult] = await Promise.all([
        cloud.from("group_members").select("user_id, role, joined_at").eq("group_id", group.id).order("joined_at"),
        administrator
          ? cloud.rpc("get_group_admin_settings", { target_group_id: group.id })
          : Promise.resolve({ data: null, error: null }),
        administrator
          ? cloud.from("group_join_requests").select("user_id, created_at").eq("group_id", group.id).eq("status", "pending").order("created_at")
          : Promise.resolve({ data: [], error: null }),
        administrator
          ? cloud.from("group_audit_log").select("id, actor_id, action, target_user_id, details, created_at").eq("group_id", group.id).order("created_at", { ascending: false }).limit(50)
          : Promise.resolve({ data: [], error: null }),
        cloud.from("group_weekly_goals").select("weekly_minutes").eq("group_id", group.id).maybeSingle()
      ]);
      if (membershipsResult.error) throw membershipsResult.error;
      if (settingsResult.error) throw settingsResult.error;
      if (requestsResult.error) throw requestsResult.error;
      if (auditResult.error) throw auditResult.error;
      if (groupGoalResult.error && !/group_weekly_goals/i.test(groupGoalResult.error.message || "")) throw groupGoalResult.error;
      adminSettings = settingsResult.data;
      groupWeeklyGoalMinutes = groupGoalResult.data?.weekly_minutes || null;
      group.inviteCode = adminSettings?.inviteCode || null;
      const ids = [...new Set([
        ...membershipsResult.data.map(item => item.user_id),
        ...requestsResult.data.map(item => item.user_id),
        ...auditResult.data.map(item => item.actor_id).filter(Boolean)
      ])];
      const profilesResult = await cloud.from("profiles").select("id, display_name").in("id", ids);
      if (profilesResult.error) throw profilesResult.error;
      const names = new Map(profilesResult.data.map(item => [item.id, item.display_name]));
      members = membershipsResult.data.map(item => ({
        id: item.user_id,
        displayName: names.get(item.user_id) || "Mitglied",
        role: item.role,
        joinedAt: item.joined_at
      }));
      joinRequests = requestsResult.data.map(item => ({
        userId: item.user_id,
        displayName: names.get(item.user_id) || "Interessent",
        createdAt: item.created_at
      }));
      auditLogs = auditResult.data.map(item => ({
        id: item.id,
        actorId: item.actor_id,
        actorName: names.get(item.actor_id) || item.details?.actorName || "Unbekannt",
        action: item.action,
        targetUserId: item.target_user_id,
        details: item.details || {},
        createdAt: item.created_at
      }));
    }

    if (migrate) await migrateLocalEntries();

    const [entriesResult, goalResult] = await Promise.all([
      fetchCloudEntries(),
      cloud.from("learning_goals").select("weekly_minutes").eq("user_id", userId).maybeSingle()
    ]);
    if (entriesResult.error) throw entriesResult.error;
    if (goalResult.error) throw goalResult.error;
    weeklyGoalMinutes = goalResult.data?.weekly_minutes || 600;
    $("#goalHours").value = Math.floor(weeklyGoalMinutes / 60);
    $("#goalMinutes").value = weeklyGoalMinutes % 60;
    sharedEntries = entriesResult.data.map(mapCloudEntry);
    entries = consolidateOwnEntries(sharedEntries.filter(entry => entry.ownerId === userId));
    overlayOfflineQueue();
    renderAll();
    setupRealtime();
    if (navigator.onLine) setTimeout(flushOfflineQueue, 0);
  } catch (error) {
    console.error(error);
    showToast(readableError(error));
  }
}

function setupRealtime() {
  if (!cloud || !session || realtimeChannel) return;
  realtimeChannel = cloud.channel(`lernzeit-${session.user.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "entries" }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadCloudState(), 250);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "group_members" }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadCloudState(), 250);
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "groups" }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadCloudState(), 250);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "group_join_requests" }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadCloudState(), 250);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "group_audit_log" }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadCloudState(), 250);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "learning_goals" }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadCloudState(), 250);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "group_weekly_goals" }, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadCloudState(), 250);
    })
    .subscribe();
}

async function handleSession(nextSession, migrate = false) {
  session = nextSession;
  if (!session) {
    profile = null;
    groups = [];
    group = null;
    members = [];
    joinRequests = [];
    auditLogs = [];
    adminSettings = null;
    groupWeeklyGoalMinutes = null;
    ownPendingRequests = 0;
    showGroupSetup = false;
    sharedEntries = [];
    entries = [];
    if (realtimeChannel) await cloud.removeChannel(realtimeChannel);
    realtimeChannel = null;
    renderAll();
    showView("gruppe");
    return;
  }
  await loadCloudState({ migrate });
}

async function initializeCloud() {
  renderAll();
  if (!cloud) {
    showView("gruppe");
    return;
  }
  const { data, error } = await cloud.auth.getSession();
  if (error) {
    showToast(readableError(error));
    return;
  }
  await handleSession(data.session, Boolean(data.session));
  if (data.session && ["woche", "monat", "jahr", "eintraege", "gruppe"].includes(requestedView)) showView(requestedView);
  else showView("gruppe");
  cloud.auth.onAuthStateChange((event, nextSession) => {
    if (event === "SIGNED_IN" && nextSession?.user.id !== session?.user.id) {
      setTimeout(() => handleSession(nextSession, true), 0);
    }
    if (event === "SIGNED_OUT") setTimeout(() => handleSession(null), 0);
    if (event === "PASSWORD_RECOVERY") setTimeout(async () => {
      await handleSession(nextSession);
      $("#accountDialog").showModal();
      $("#newPassword").focus();
      showToast("Lege jetzt dein neues Passwort fest");
    }, 0);
  });
}

$$('.nav-item').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$$('[data-go]').forEach(button => button.addEventListener('click', () => showView(button.dataset.go)));
$(".brand").addEventListener("click", event => { event.preventDefault(); showView("woche"); });
$("#openEntryButton").addEventListener("click", () => openDialog());
$("#entryGroupPicker").addEventListener("change", syncVisibilityAvailability);
$("#closeDialog").addEventListener("click", () => { editingEntryId = null; editingEntryIds = []; editingEntryOwnerId = null; $("#entryDialog").close(); });
$("#entryDialog").addEventListener("click", event => {
  if (event.target === $("#entryDialog")) $("#entryDialog").close();
});

$("#entryForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!session) {
    $("#entryDialog").close();
    openAuthDialog();
    return;
  }
  const hours = Number($("#entryHours").value || 0);
  const minutes = Number($("#entryMinutes").value || 0);
  const total = hours * 60 + minutes;
  if (!total || total < 1) {
    $("#formError").textContent = "Bitte trage eine Dauer von mindestens einer Minute ein.";
    return;
  }
  if (minutes > 59 || hours > 23 || total > 1439) {
    $("#formError").textContent = "Bitte prüfe Stunden und Minuten.";
    return;
  }

  const selectedGroupIds = selectedEntryGroupIds();
  const wasEditing = Boolean(editingEntryId);
  const command = {
    id: editingEntryId || crypto.randomUUID(),
    existingIds: [...editingEntryIds],
    managed: Boolean(editingEntryId && editingEntryOwnerId !== session.user.id),
    date: $("#entryDate").value,
    category: $("input[name=category]:checked").value,
    minutes: total,
    topic: $("#entryTopic").value.trim(),
    groupIds: selectedGroupIds,
    visibility: selectedGroupIds.length ? $("input[name=visibility]:checked").value : "private",
    createdAt: Date.now()
  };
  setEntryFormSaving(true);
  let queuedOffline = false;
  try {
    if (!navigator.onLine) {
      if (command.managed) {
        $("#formError").textContent = "Fremde Gruppeneinträge können nur online bearbeitet werden.";
        return;
      }
      queueLearningCommand(command);
      queuedOffline = true;
    } else {
      const { error } = await persistLearningCommand(command);
      if (error && isConnectionError(error)) {
        if (command.managed) {
          $("#formError").textContent = "Fremde Gruppeneinträge können nur online bearbeitet werden.";
          return;
        }
        queueLearningCommand(command);
        queuedOffline = true;
      } else if (error) {
        $("#formError").textContent = readableError(error);
        return;
      } else {
        await loadCloudState();
      }
    }
  } finally {
    setEntryFormSaving(false);
  }

  $("#entryDialog").close();
  $("#entryHours").value = 0;
  $("#entryMinutes").value = 30;
  $("#entryTopic").value = "";
  editingEntryId = null;
  editingEntryIds = [];
  editingEntryOwnerId = null;
  const saveMessage = selectedGroupIds.length > 1
    ? command.visibility === "group"
      ? `Lernzeit wurde mit ${selectedGroupIds.length} Gruppen geteilt`
      : `Lernzeit wurde für ${selectedGroupIds.length} Gruppen gespeichert`
    : command.visibility === "group"
      ? "Lernzeit wurde mit der Gruppe geteilt"
      : "Lernzeit wurde gespeichert";
  showToast(queuedOffline ? "Offline gespeichert – wird später synchronisiert" : wasEditing ? "Eintrag wurde aktualisiert" : saveMessage);
});

document.addEventListener("click", async event => {
  const requestButton = event.target.closest("[data-decide-request]");
  if (requestButton) {
    requestButton.disabled = true;
    const approve = requestButton.dataset.decideRequest === "approve";
    const { error } = await cloud.rpc("decide_group_join_request", {
      target_group_id: group.id,
      target_user_id: requestButton.dataset.requestUser,
      approve_request: approve
    });
    if (error) return showToast(readableError(error));
    await loadCloudState();
    showToast(approve ? "Mitglied wurde aufgenommen" : "Anfrage wurde abgelehnt");
    return;
  }

  const editButton = event.target.closest("[data-edit]");
  if (editButton) {
    const entry = entries.find(item => item.id === editButton.dataset.edit || item.linkedEntryIds?.includes(editButton.dataset.edit))
      || sharedEntries.find(item => item.id === editButton.dataset.edit);
    if (entry) openDialog(entry);
    return;
  }

  const removeButton = event.target.closest("[data-remove-member]");
  if (removeButton) {
    if (!confirm(`${removeButton.dataset.memberName} wirklich aus der Gruppe entfernen?`)) return;
    const { error } = await cloud.rpc("remove_group_member", {
      target_group_id: group.id,
      target_user_id: removeButton.dataset.removeMember
    });
    if (error) return showToast(readableError(error));
    await loadCloudState();
    showToast("Mitglied wurde entfernt");
    return;
  }

  const deleteButton = event.target.closest("[data-delete]");
  if (deleteButton) {
    const ownEntry = entries.find(item => item.id === deleteButton.dataset.delete || item.linkedEntryIds?.includes(deleteButton.dataset.delete));
    const targetEntryId = ownEntry?.id || deleteButton.dataset.delete;
    if (!ownEntry && !confirm("Diesen Gruppeneintrag wirklich löschen?")) return;
    if (session) {
      const { error } = ownEntry
        ? await cloud.rpc("delete_entry", { target_entry_id: targetEntryId })
        : await cloud.rpc("remove_entry_from_group", { target_entry_id: targetEntryId, target_group_id: group.id });
      if (error) return showToast(readableError(error));
      await loadCloudState();
    } else {
      entries = entries.filter(entry => entry.id !== deleteButton.dataset.delete);
      saveEntries();
      renderAll();
    }
    if (ownEntry && session) {
      showToast("Eintrag gelöscht", {
        label: "Rückgängig",
        handler: async () => {
          const { error } = await cloud.rpc("restore_own_entry", { target_entry_id: targetEntryId });
          if (error) return showToast(readableError(error));
          await loadCloudState();
          showToast("Eintrag wiederhergestellt");
        }
      });
    } else {
      showToast("Gruppeneintrag gelöscht");
    }
    return;
  }

  const onlineAction = event.target.closest("[data-online-action]")?.dataset.onlineAction;
  if (onlineAction === "login") openAuthDialog();
  if (onlineAction === "group") showView("gruppe");
});

document.addEventListener("change", async event => {
  const roleSelect = event.target.closest("[data-member-role]");
  if (!roleSelect) return;
  roleSelect.disabled = true;
  const { error } = await cloud.rpc("set_group_member_role", {
    target_group_id: group.id,
    target_user_id: roleSelect.dataset.memberRole,
    new_role: roleSelect.value
  });
  if (error) {
    showToast(readableError(error));
    await loadCloudState();
    return;
  }
  await loadCloudState();
  showToast(roleSelect.value === "admin" ? "Adminrechte wurden vergeben" : "Adminrechte wurden entzogen");
});

$("#weekPrev").addEventListener("click", () => { weekCursor = addDays(weekCursor, -7); renderWeek(); });
$("#weekNext").addEventListener("click", () => { weekCursor = addDays(weekCursor, 7); renderWeek(); });
$("#weekToday").addEventListener("click", () => { weekCursor = startOfWeek(new Date()); renderWeek(); });
$("#monthPrev").addEventListener("click", () => { monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1); renderMonth(); });
$("#monthNext").addEventListener("click", () => { monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1); renderMonth(); });
$("#monthToday").addEventListener("click", () => { monthCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1); renderMonth(); });
$("#yearPrev").addEventListener("click", () => { yearCursor--; renderYear(); });
$("#yearNext").addEventListener("click", () => { yearCursor++; renderYear(); });
$("#yearToday").addEventListener("click", () => { yearCursor = new Date().getFullYear(); renderYear(); });
$("#entrySearch").addEventListener("input", renderAllEntries);
$("#categoryFilter").addEventListener("change", renderAllEntries);
$("#goalForm").addEventListener("submit", async event => {
  event.preventDefault();
  const minutes = Number($("#goalHours").value || 0) * 60 + Number($("#goalMinutes").value || 0);
  if (minutes < 30 || minutes > 10080) return showToast("Das Wochenziel muss zwischen 30 Minuten und 168 Stunden liegen.");
  const { error } = await cloud.from("learning_goals").upsert({
    user_id: session.user.id,
    weekly_minutes: minutes,
    updated_at: new Date().toISOString()
  });
  if (error) return showToast(readableError(error));
  weeklyGoalMinutes = minutes;
  renderWeek();
  showToast("Wochenziel gespeichert");
});

$("#groupGoalForm").addEventListener("submit", async event => {
  event.preventDefault();
  const minutes = Number($("#groupGoalHours").value || 0) * 60 + Number($("#groupGoalMinutes").value || 0);
  if (minutes < 30 || minutes > 100800) return showToast("Das Gruppenziel muss zwischen 30 Minuten und 1.680 Stunden liegen.");
  const button = event.submitter;
  button.disabled = true;
  const { error } = await cloud.rpc("set_group_weekly_goal", {
    target_group_id: group.id,
    target_minutes: minutes
  });
  button.disabled = false;
  if (error) return showToast(readableError(error));
  groupWeeklyGoalMinutes = minutes;
  await loadCloudState();
  showToast("Gemeinsame Challenge gespeichert");
});

function exportEntriesCsv() {
  const safeCell = value => {
    let text = String(value ?? "");
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows = [["Datum", "Bereich", "Dauer (Minuten)", "Thema", "Gruppe", "Sichtbarkeit"], ...entries.map(entry => [
    entry.date,
    categories[entry.category]?.label || entry.category,
    entry.minutes,
    entry.topic,
    entryGroupNames(entry).join(", ") || "Keine",
    { group: "Gruppe", admins: "Admins", private: "Nur ich" }[entry.visibility]
  ])];
  const csv = `\ufeff${rows.map(row => row.map(safeCell).join(";")).join("\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `lernzeit-export-${localISO(new Date())}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

$("#exportCsvButton").addEventListener("click", exportEntriesCsv);
$("#exportPdfButton").addEventListener("click", () => window.print());
$("#groupSelector").addEventListener("change", async event => {
  localStorage.setItem(activeGroupStorageKey(), event.target.value);
  await loadCloudState();
  showToast("Aktive Gruppe gewechselt");
});
$("#groupCapacitySelect").addEventListener("change", async event => {
  const previous = group.maxMembers;
  event.target.disabled = true;
  const { error } = await cloud.rpc("set_group_max_members", {
    target_group_id: group.id,
    new_max_members: Number(event.target.value)
  });
  if (error) {
    event.target.value = String(previous);
    event.target.disabled = false;
    return showToast(readableError(error));
  }
  await loadCloudState();
  showToast("Platzanzahl wurde geändert");
});
$("#openGroupSetup").addEventListener("click", () => {
  showGroupSetup = true;
  renderGroup();
});
$("#cancelGroupSetup").addEventListener("click", () => {
  showGroupSetup = false;
  renderGroup();
});

$("#renameGroupForm").addEventListener("submit", async event => {
  event.preventDefault();
  const { error } = await cloud.rpc("rename_group", { target_group_id: group.id, new_name: $("#renameGroupInput").value.trim() });
  if (error) return showToast(readableError(error));
  await loadCloudState();
  showToast("Gruppenname geändert");
});

$("#inviteSettingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  const expiry = $("#inviteExpiry").value;
  const { error } = await cloud.rpc("set_group_invite_settings", {
    target_group_id: group.id,
    invitations_enabled: $("#inviteEnabled").checked,
    expires_at: expiry ? new Date(expiry).toISOString() : null
  });
  if (error) return showToast(readableError(error));
  await loadCloudState();
  showToast("Einladungseinstellungen gespeichert");
});

$("#rotateInviteButton").addEventListener("click", async () => {
  if (!confirm("Den bisherigen Einladungscode wirklich ungültig machen?")) return;
  const { data, error } = await cloud.rpc("rotate_group_invite_code", { target_group_id: group.id });
  if (error) return showToast(readableError(error));
  await loadCloudState();
  showToast(`Neuer Code: ${data}`);
});

$("#transferOwnerForm").addEventListener("submit", async event => {
  event.preventDefault();
  const target = $("#transferOwnerSelect").value;
  const name = members.find(member => member.id === target)?.displayName;
  if (!target || !confirm(`${name} wirklich zum Hauptadmin machen? Du wirst danach normaler Admin.`)) return;
  const { error } = await cloud.rpc("transfer_group_ownership", { target_group_id: group.id, target_user_id: target });
  if (error) return showToast(readableError(error));
  await loadCloudState();
  showToast("Hauptadmin wurde übertragen");
});

$("#leaveGroupButton").addEventListener("click", async () => {
  if (!confirm(`„${group.name}“ wirklich verlassen? Deine Einträge bleiben in deinem Konto, werden aber von der Gruppe getrennt.`)) return;
  const { error } = await cloud.rpc("leave_group", { target_group_id: group.id });
  if (error) return showToast(readableError(error));
  localStorage.removeItem(activeGroupStorageKey());
  await loadCloudState();
  showToast("Du hast die Gruppe verlassen");
});

$("#deleteGroupButton").addEventListener("click", async () => {
  const confirmation = prompt(`Zum endgültigen Löschen bitte den Gruppennamen „${group.name}“ eingeben:`);
  if (confirmation !== group.name) return;
  const { error } = await cloud.rpc("delete_group", { target_group_id: group.id });
  if (error) return showToast(readableError(error));
  localStorage.removeItem(activeGroupStorageKey());
  await loadCloudState();
  showToast("Gruppe wurde gelöscht");
});

$("#accountButton").addEventListener("click", () => session ? $("#accountDialog").showModal() : openAuthDialog());
$("#groupLoginButton").addEventListener("click", openAuthDialog);
$("#closeAuthDialog").addEventListener("click", () => $("#authDialog").close());
$("#closeAccountDialog").addEventListener("click", () => $("#accountDialog").close());
$("#authModeSwitch").addEventListener("click", () => {
  authMode = authMode === "login" ? "register" : "login";
  $("#authError").textContent = "";
  updateAuthMode();
});
$("#forgotPasswordButton").addEventListener("click", async () => {
  const email = $("#authEmail").value.trim();
  if (!email) return $("#authError").textContent = "Trage zuerst deine E-Mail-Adresse ein.";
  const { error } = await cloud.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}${location.pathname}#woche` });
  if (error) return $("#authError").textContent = readableError(error);
  $("#authDialog").close();
  showToast("Der Link zum Zurücksetzen wurde per E-Mail versendet");
});

$("#authForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("#authError").textContent = "";
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  let result;
  if (authMode === "register") {
    result = await cloud.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: $("#authDisplayName").value.trim() },
        emailRedirectTo: `${location.origin}${location.pathname}#gruppe`
      }
    });
  } else {
    result = await cloud.auth.signInWithPassword({ email, password });
  }
  if (result.error) {
    $("#authError").textContent = readableError(result.error);
    return;
  }
  $("#authDialog").close();
  $("#authForm").reset();
  if (!result.data.session) showToast("Bitte bestätige zuerst den Link in deiner E-Mail.");
  else await handleSession(result.data.session, true);
});

$("#logoutButton").addEventListener("click", async () => {
  $("#accountDialog").close();
  const { error } = await cloud.auth.signOut();
  if (error) showToast(readableError(error));
});

$("#profileForm").addEventListener("submit", async event => {
  event.preventDefault();
  const displayName = $("#accountDisplayName").value.trim();
  const email = $("#accountEmailInput").value.trim();
  const profileResult = await cloud.from("profiles").update({ display_name: displayName }).eq("id", session.user.id);
  if (profileResult.error) return showToast(readableError(profileResult.error));
  const authResult = await cloud.auth.updateUser({ email, data: { display_name: displayName } });
  if (authResult.error) return showToast(readableError(authResult.error));
  await loadCloudState();
  showToast(email !== session.user.email ? "Bitte bestätige die neue E-Mail-Adresse" : "Kontodaten gespeichert");
});

$("#passwordForm").addEventListener("submit", async event => {
  event.preventDefault();
  const { error } = await cloud.auth.updateUser({ password: $("#newPassword").value });
  if (error) return showToast(readableError(error));
  $("#passwordForm").reset();
  showToast("Passwort wurde geändert");
});

$("#deleteAccountButton").addEventListener("click", async () => {
  if (prompt('Zum Löschen deines Kontos bitte „LÖSCHEN“ eingeben:') !== "LÖSCHEN") return;
  const { error } = await cloud.rpc("delete_own_account");
  if (error) return showToast(readableError(error));
  $("#accountDialog").close();
  await cloud.auth.signOut();
  showToast("Konto und Daten wurden gelöscht");
});

$$('[data-theme-choice]').forEach(button => button.addEventListener("click", async () => {
  const previousTheme = appearanceTheme;
  const nextTheme = button.dataset.themeChoice;
  if (nextTheme === previousTheme) return;
  applyTheme(nextTheme);
  const { error } = await cloud.from("profiles")
    .update({ appearance_theme: nextTheme })
    .eq("id", session.user.id);
  if (error) {
    applyTheme(previousTheme);
    return showToast(readableError(error));
  }
  if (profile) profile.appearanceTheme = nextTheme;
  showToast(nextTheme === "noir" ? "Wayne Noir wurde gespeichert" : "Sonnenuntergang wurde gespeichert");
}));

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  $("#installAppButton").classList.remove("hidden");
});
$("#installAppButton").addEventListener("click", async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  installPrompt = null;
  $("#installAppButton").classList.add("hidden");
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("#installAppButton").classList.add("hidden");
  showToast("Lernzeit wurde als App installiert");
});
window.addEventListener("online", flushOfflineQueue);
window.addEventListener("offline", renderAccount);

$("#createGroupForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("#createGroupError").textContent = "";
  const { data, error } = await cloud.rpc("create_private_group", { group_name: $("#newGroupName").value.trim() });
  if (error) {
    $("#createGroupError").textContent = readableError(error);
    return;
  }
  $("#createGroupForm").reset();
  localStorage.setItem(activeGroupStorageKey(), data);
  showGroupSetup = false;
  await loadCloudState();
  showToast("Deine Gruppe ist bereit");
});

$("#joinGroupForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("#joinGroupError").textContent = "";
  const { data, error } = await cloud.rpc("join_private_group", { invitation_code: $("#inviteCodeInput").value.trim() });
  if (error) {
    $("#joinGroupError").textContent = readableError(error);
    return;
  }
  $("#joinGroupForm").reset();
  showGroupSetup = groups.length > 0;
  await loadCloudState();
  showToast("Beitrittsanfrage gesendet – ein Admin muss sie noch bestätigen");
});

$("#copyInviteButton").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(group.inviteCode);
    showToast("Einladungs-Code kopiert");
  } catch {
    showToast(`Einladungs-Code: ${group.inviteCode}`);
  }
});

const requestedView = location.hash.slice(1) || "gruppe";
applyTheme(appearanceTheme);
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(console.error));
initializeCloud();
