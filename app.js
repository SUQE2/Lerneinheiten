const STORAGE_KEY = "lernzeit.entries.v1";
const categories = {
  studium: { label: "Studium", color: "var(--primary)" },
  arbeit: { label: "Arbeit", color: "var(--orange)" },
  persoenlich: { label: "Persönlich", color: "var(--yellow)" },
  sonstiges: { label: "Sonstiges", color: "var(--blue)" }
};
const dayNames = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const monthNames = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const shortMonths = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const memberColors = ["#164f43", "#df7b4b", "#567e9b", "#9a6e8f", "#b49338"];

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
let group = null;
let members = [];
let realtimeChannel = null;
let refreshTimer = null;
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
      const visibility = options.showVisibility
        ? `<span class="entry-visibility ${entry.visibility}">${entry.visibility === "private" ? "Privat" : "Gruppe"}</span> · `
        : "";
      const owner = options.showOwner ? `<span class="entry-owner">${escapeHtml(memberName(entry.ownerId))}</span> · ${visibility}` : visibility;
      const canDelete = options.allowDelete !== false && (!session || entry.ownerId === session.user.id || options.allowManage);
      return `<div class="entry-row">
        <div class="entry-date"><strong>${date.getDate()}</strong><span>${shortMonths[date.getMonth()]}</span></div>
        <div class="entry-info"><strong>${escapeHtml(entry.topic || "Lerneinheit")}</strong><span>${owner}<i class="entry-dot ${entry.category}"></i>${category.label} · ${dayNames[(date.getDay() + 6) % 7]}</span></div>
        <span class="entry-duration">${formatDuration(entry.minutes)}</span>
        ${canDelete ? `<button class="delete-button" data-delete="${entry.id}" aria-label="Eintrag löschen" title="Eintrag löschen">×</button>` : "<span></span>"}
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
    element.innerHTML = `<div class="comparison-cta"><div><strong>Vergleiche dich mit deinen Freunden</strong>Melde dich an und erstelle eine private Gruppe mit bis zu fünf Personen.</div><button class="primary-button" data-online-action="login">Online starten</button></div>`;
    return;
  }
  if (!group) {
    element.innerHTML = `<div class="comparison-cta"><div><strong>Noch keine Gruppe</strong>Erstelle eine Gruppe oder tritt mit einem Einladungs-Code bei.</div><button class="primary-button" data-online-action="group">Gruppe einrichten</button></div>`;
    return;
  }

  const publicEntries = entriesBetween(start, end, sharedEntries).filter(entry => entry.visibility === "group");
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

  $("#weekLabel").textContent = `KW ${getWeekNumber(weekCursor)}`;
  $("#weekDateRange").textContent = `${weekCursor.getDate()}. ${shortMonths[weekCursor.getMonth()]} – ${end.getDate()}. ${shortMonths[end.getMonth()]} ${end.getFullYear()}`;
  $("#weekTotal").textContent = formatDuration(total);
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
  $("#allEntries").innerHTML = entryRows(filtered, "Keine passenden Einträge gefunden.");
}

function currentStreak() {
  const dates = new Set(entries.map(entry => entry.date));
  let cursor = new Date();
  if (!dates.has(localISO(cursor))) cursor = addDays(cursor, -1);
  let count = 0;
  while (dates.has(localISO(cursor))) {
    count++;
    cursor = addDays(cursor, -1);
  }
  return count;
}

function renderGroup() {
  $("#groupLoggedOut").classList.toggle("hidden", Boolean(session));
  $("#groupNoMembership").classList.toggle("hidden", !session || Boolean(group));
  $("#groupDashboard").classList.toggle("hidden", !session || !group);
  if (!session) return;

  $("#welcomeName").textContent = profile?.displayName || "";
  if (!group) return;
  $("#groupName").textContent = group.name;
  $("#memberCount").textContent = members.length;
  const ownMember = currentMember();
  const administrator = isGroupAdmin();
  const roleLabels = { owner: "Hauptadmin", admin: "Admin", member: "Mitglied" };
  $("#groupRoleLabel").textContent = roleLabels[ownMember?.role] || "Mitglied";
  $("#inviteBox").classList.toggle("hidden", !administrator);
  $("#inviteCode").textContent = group.inviteCode || "–";
  $("#groupActivityNote").textContent = administrator
    ? "Admins sehen freigegebene und private Einträge"
    : "Du siehst nur freigegebene Einträge";

  const start = startOfWeek(new Date());
  const end = addDays(start, 6);
  const publicWeekEntries = entriesBetween(start, end, sharedEntries).filter(entry => entry.visibility === "group");
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

  const visibleActivity = (administrator
    ? sharedEntries
    : sharedEntries.filter(entry => entry.visibility === "group"))
    .slice(0, 20);
  $("#groupActivity").innerHTML = entryRows(
    visibleActivity,
    "Noch keine sichtbaren Einträge in eurer Gruppe.",
    { showOwner: true, showVisibility: administrator, allowDelete: administrator, allowManage: administrator }
  );
}

function renderAccount() {
  const label = session ? (profile?.displayName || session.user.email) : (cloudEnabled ? "Anmelden" : "Online einrichten");
  $("#accountLabel").textContent = label;
  $("#accountButton").classList.toggle("online", Boolean(session));
  $("#storageNote").textContent = session ? "Deine Daten werden sicher synchronisiert." : "Anmeldung erforderlich.";
  $$(".auth-required").forEach(element => element.classList.toggle("hidden", !session));
  $("#openEntryButton").classList.toggle("hidden", !session);
  $("#groupLoginButton").textContent = cloudEnabled ? "Anmelden oder registrieren" : "Online-Modus einrichten";
  if (session) {
    $("#accountName").textContent = profile?.displayName || "Dein Konto";
    $("#accountEmail").textContent = session.user.email || "";
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
  history.replaceState(null, "", `#${view}`);
}

function openDialog() {
  if (!session) {
    openAuthDialog();
    return;
  }
  $("#entryDate").value = localISO(new Date());
  $("#formError").textContent = "";
  $("#visibilityField").classList.toggle("hidden", !session || !group);
  const visibility = $(`input[name=visibility][value=${group ? "group" : "private"}]`);
  if (visibility) visibility.checked = true;
  $("#entryDialog").showModal();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2600);
}

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
  $("#authDisplayName").required = register;
  $("#authPassword").autocomplete = register ? "new-password" : "current-password";
}

function mapCloudEntry(row) {
  return {
    id: row.id,
    ownerId: row.user_id,
    date: row.entry_date,
    category: row.category,
    minutes: row.minutes,
    topic: row.topic,
    visibility: row.visibility,
    createdAt: new Date(row.created_at).getTime()
  };
}

async function migrateLocalEntries() {
  const localEntries = loadEntries();
  const marker = `lernzeit.cloud-imported.${session.user.id}`;
  if (!localEntries.length || localStorage.getItem(marker)) return;
  const rows = localEntries.map(entry => ({
    id: crypto.randomUUID(),
    user_id: session.user.id,
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

async function loadCloudState({ migrate = false } = {}) {
  if (!session) return;
  try {
    if (migrate) await migrateLocalEntries();
    const userId = session.user.id;
    const profileResult = await cloud.from("profiles").select("id, display_name").eq("id", userId).single();
    if (profileResult.error) throw profileResult.error;
    profile = { id: profileResult.data.id, displayName: profileResult.data.display_name };

    const membershipResult = await cloud.from("group_members").select("group_id, role, joined_at").eq("user_id", userId).maybeSingle();
    if (membershipResult.error) throw membershipResult.error;
    group = null;
    members = [];

    if (membershipResult.data) {
      const groupId = membershipResult.data.group_id;
      const administrator = ["owner", "admin"].includes(membershipResult.data.role);
      const [groupResult, membershipsResult, inviteResult] = await Promise.all([
        cloud.from("groups").select("id, name, owner_id, max_members").eq("id", groupId).single(),
        cloud.from("group_members").select("user_id, role, joined_at").eq("group_id", groupId).order("joined_at"),
        administrator ? cloud.rpc("get_group_invite_code") : Promise.resolve({ data: null, error: null })
      ]);
      if (groupResult.error) throw groupResult.error;
      if (membershipsResult.error) throw membershipsResult.error;
      if (inviteResult.error) throw inviteResult.error;
      group = {
        id: groupResult.data.id,
        name: groupResult.data.name,
        inviteCode: inviteResult.data,
        ownerId: groupResult.data.owner_id,
        maxMembers: groupResult.data.max_members
      };
      const ids = membershipsResult.data.map(item => item.user_id);
      const profilesResult = await cloud.from("profiles").select("id, display_name").in("id", ids);
      if (profilesResult.error) throw profilesResult.error;
      const names = new Map(profilesResult.data.map(item => [item.id, item.display_name]));
      members = membershipsResult.data.map(item => ({
        id: item.user_id,
        displayName: names.get(item.user_id) || "Mitglied",
        role: item.role,
        joinedAt: item.joined_at
      }));
    }

    const entriesResult = await cloud.from("entries")
      .select("id, user_id, entry_date, category, minutes, topic, visibility, created_at")
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (entriesResult.error) throw entriesResult.error;
    sharedEntries = entriesResult.data.map(mapCloudEntry);
    entries = sharedEntries.filter(entry => entry.ownerId === userId);
    renderAll();
    setupRealtime();
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
    .subscribe();
}

async function handleSession(nextSession, migrate = false) {
  session = nextSession;
  if (!session) {
    profile = null;
    group = null;
    members = [];
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
  });
}

$$('.nav-item').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$$('[data-go]').forEach(button => button.addEventListener('click', () => showView(button.dataset.go)));
$(".brand").addEventListener("click", event => { event.preventDefault(); showView("woche"); });
$("#openEntryButton").addEventListener("click", openDialog);
$("#closeDialog").addEventListener("click", () => $("#entryDialog").close());
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

  const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const entry = {
    id,
    date: $("#entryDate").value,
    category: $("input[name=category]:checked").value,
    minutes: total,
    topic: $("#entryTopic").value.trim(),
    visibility: session && group ? $("input[name=visibility]:checked").value : "private",
    createdAt: Date.now()
  };

  const { error } = await cloud.from("entries").insert({
    id: entry.id,
    user_id: session.user.id,
    entry_date: entry.date,
    category: entry.category,
    minutes: entry.minutes,
    topic: entry.topic,
    visibility: entry.visibility,
    created_at: new Date(entry.createdAt).toISOString()
  });
  if (error) {
    $("#formError").textContent = readableError(error);
    return;
  }
  await loadCloudState();

  $("#entryDialog").close();
  $("#entryHours").value = 0;
  $("#entryMinutes").value = 30;
  $("#entryTopic").value = "";
  showToast(entry.visibility === "group" ? "Lernzeit wurde mit der Gruppe geteilt" : "Lernzeit wurde gespeichert");
});

document.addEventListener("click", async event => {
  const removeButton = event.target.closest("[data-remove-member]");
  if (removeButton) {
    if (!confirm(`${removeButton.dataset.memberName} wirklich aus der Gruppe entfernen?`)) return;
    const { error } = await cloud.rpc("remove_group_member", { target_user_id: removeButton.dataset.removeMember });
    if (error) return showToast(readableError(error));
    await loadCloudState();
    showToast("Mitglied wurde entfernt");
    return;
  }

  const deleteButton = event.target.closest("[data-delete]");
  if (deleteButton) {
    if (!confirm("Diesen Eintrag wirklich löschen?")) return;
    if (session) {
      const { error } = await cloud.from("entries").delete().eq("id", deleteButton.dataset.delete);
      if (error) return showToast(readableError(error));
      await loadCloudState();
    } else {
      entries = entries.filter(entry => entry.id !== deleteButton.dataset.delete);
      saveEntries();
      renderAll();
    }
    showToast("Eintrag gelöscht");
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

$("#accountButton").addEventListener("click", () => session ? $("#accountDialog").showModal() : openAuthDialog());
$("#groupLoginButton").addEventListener("click", openAuthDialog);
$("#closeAuthDialog").addEventListener("click", () => $("#authDialog").close());
$("#closeAccountDialog").addEventListener("click", () => $("#accountDialog").close());
$("#authModeSwitch").addEventListener("click", () => {
  authMode = authMode === "login" ? "register" : "login";
  $("#authError").textContent = "";
  updateAuthMode();
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

$("#createGroupForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("#createGroupError").textContent = "";
  const { error } = await cloud.rpc("create_private_group", { group_name: $("#newGroupName").value.trim() });
  if (error) {
    $("#createGroupError").textContent = readableError(error);
    return;
  }
  $("#createGroupForm").reset();
  await loadCloudState();
  showToast("Deine Gruppe ist bereit");
});

$("#joinGroupForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("#joinGroupError").textContent = "";
  const { error } = await cloud.rpc("join_private_group", { invitation_code: $("#inviteCodeInput").value.trim() });
  if (error) {
    $("#joinGroupError").textContent = readableError(error);
    return;
  }
  $("#joinGroupForm").reset();
  await loadCloudState();
  showToast("Du bist der Gruppe beigetreten");
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
initializeCloud();
