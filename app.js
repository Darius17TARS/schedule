"use strict";
const store = {
  get: () => sessionStorage.getItem("tok") || localStorage.getItem("tumSchedTok"),
  set: (t) => { sessionStorage.setItem("tok", t); if (document.getElementById("remember")?.checked) localStorage.setItem("tumSchedTok", t); else localStorage.removeItem("tumSchedTok"); },
  clear: () => { sessionStorage.removeItem("tok"); $("remember").checked = false; localStorage.removeItem("tumSchedTok"); }
};
function showError(where, err) {
  const box = document.getElementById("errbox"); if (!box) return;
  box.hidden = false;
  box.querySelector("pre").textContent = `${where}: ${err && err.message ? err.message : err}\n${(err && err.stack) || ""}`.slice(0, 1500);
}
window.addEventListener("error", e => showError("Script error", e.error || e.message));
window.addEventListener("unhandledrejection", e => showError("Async error", e.reason));
// Privacy: token lives in sessionStorage (cleared on tab close), or in localStorage only if the user opts in via "Remember me". Nothing is sent anywhere except TUMonline and NavigaTUM.
const BASE = "https://campus.tum.de/tumonline/wbservicesbasic.";
const NAV = "https://nav.tum.de/api/";
const $ = (id) => document.getElementById(id);
const START_H = 7, END_H = 21;
let events = [], cancelled = [], day = startOfDay(new Date()), pollTimer = null;
const roomCache = new Map();

function semesterMonths() { const n = new Date(), m = n.getMonth(); const ws = m >= 9 || m < 3; const startM = ws ? (m >= 9 ? m - 9 : m + 3) : m - 3; return { pMonateVor: startM + 1, pMonateNach: 6 - startM }; }
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function show(id) { for (const s of ["login", "activate", "cal"]) $(s).hidden = s !== id; $("logout").hidden = id === "login"; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

async function api(method, params) {
  const r = await fetch(BASE + method + "?" + new URLSearchParams(params), { referrerPolicy: "no-referrer" });
  const doc = new DOMParser().parseFromString(await r.text(), "text/xml");
  const err = doc.querySelector("error > message");
  if (err) throw new Error(err.textContent);
  return doc;
}

async function requestToken() {
  const id = $("tumid").value.trim().toLowerCase();
  if (!/^[a-z]{2}\d{2}[a-z]{3}$/.test(id)) { $("msg").textContent = "Please enter a valid TUM ID (e.g. ab12cde)."; return; }
  $("msg").textContent = "Requesting…";
  try {
    const doc = await api("requestToken", { pUsername: id, pTokenName: "TUM Schedule" });
    const tok = doc.querySelector("token")?.textContent?.trim();
    if (!tok) throw new Error("No token in response");
    store.set(tok);
    startActivation(tok);
  } catch (e) { $("msg").textContent = "Error: " + e.message; }
}

function startActivation(tok) {
  $("tokShow").textContent = tok; show("activate");
  const check = async () => {
    try {
      const doc = await api("isTokenConfirmed", { pToken: tok });
      if (doc.querySelector("confirmed")?.textContent.trim() === "true") { clearInterval(pollTimer); loadCalendar(tok); }
      else $("msg2").textContent = "Not activated yet…";
    } catch (e) { $("msg2").textContent = "Error: " + e.message; }
  };
  check(); pollTimer = setInterval(check, 5000);
}

function parseTumDate(s) { // "2026-10-27 10:15:00" (Berlin local), or ISO with Z/offset
  s = String(s || "").trim(); if (!s) return null;
  if (/[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) { const d = new Date(s.replace(" ", "T")); return isNaN(d) ? null : d; }
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5]);
  const d = new Date(s); return isNaN(d) ? null : d;
}

async function loadCalendar(tok) {
  show("cal"); $("view").innerHTML = "<p class='muted pad'>Loading…</p>";
  try {
    const doc = await api("kalender", { pToken: tok, ...semesterMonths() });
    const pick = (el, ...names) => { for (const n of names) { const x = [...el.children].find(c => c.localName.toLowerCase() === n); if (x && x.textContent.trim()) return x.textContent.trim(); } return ""; };
    let nodes = [...doc.getElementsByTagName("event")];
    if (!nodes.length) nodes = [...doc.getElementsByTagName("row")];
    events = nodes.map(el => ({
      title: pick(el, "title", "titel", "summary", "description"), start: parseTumDate(pick(el, "dtstart", "start", "beginn", "von")), end: parseTumDate(pick(el, "dtend", "end", "ende", "bis")),
      location: pick(el, "location", "ort", "raum", "room"), status: pick(el, "status"), url: pick(el, "url")
    })).filter(e => e.start && e.end);
    cancelled = events.filter(isCancelled); events = events.filter(e => !isCancelled(e));
    if (!events.length && nodes.length) showError("Calendar", new Error(`Received ${nodes.length} entries but could not read their dates. First entry: ` + new XMLSerializer().serializeToString(nodes[0]).slice(0, 600)));
    if (!nodes.length) showError("Calendar", new Error("No events found in TUMonline response. Start of response: " + new XMLSerializer().serializeToString(doc).slice(0, 600)));
    render();
  } catch (e) {
    if (/ungültig|invalid/i.test(e.message)) { logout(); $("msg").textContent = "Token invalid. Please request a new one."; }
    else $("view").innerHTML = "<p class='msg pad'>Error: " + esc(e.message) + "</p>";
  }
}

// --- ICS fallback ---
function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = []; let cur = null;
  const unesc = v => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");
  const dt = v => { const m = v.match(/(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?(Z)?/); if (!m) return null;
    const a = [+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
    return m[7] ? new Date(Date.UTC(...a)) : new Date(...a); };
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") cur = {};
    else if (l === "END:VEVENT") { if (cur.start && cur.end) out.push(cur); cur = null; }
    else if (cur) { const i = l.indexOf(":"); if (i < 0) continue; const k = l.slice(0, i).split(";")[0], v = l.slice(i + 1);
      if (k === "SUMMARY") cur.title = unesc(v); else if (k === "DTSTART") cur.start = dt(v); else if (k === "DTEND") cur.end = dt(v);
      else if (k === "LOCATION") cur.location = unesc(v); else if (k === "STATUS") cur.status = v; else if (k === "URL") cur.url = v; }
  }
  return out;
}

// --- Room resolution via NavigaTUM ---
function roomCode(loc) { const m = (loc || "").match(/\b\d{4}\.[A-Z0-9]{2}\.[A-Z0-9]+\b/i); return m ? m[0] : null; }
async function resolveRoom(loc) {
  if (!loc) return null;
  if (roomCache.has(loc)) return roomCache.get(loc);
  const p = (async () => {
    try {
      let id = roomCode(loc);
      if (!id) {
        const q = loc.split(",")[0].trim();
        const r = await (await fetch(NAV + "search?" + new URLSearchParams({ q }))).json();
        id = r.sections?.find(s => s.facet === "rooms")?.entries?.[0]?.id;
        if (!id) return null;
      }
      const d = await (await fetch(NAV + "locations/" + encodeURIComponent(id))).json();
      if (!d.id) return null;
      const short = (d.aliases || []).find(a => /^[A-Z]+\d/.test(a)) || d.aliases?.[0] || d.id;
      return { id: d.id, short, name: d.name, building: (d.parent_names || []).slice(-1)[0], campus: (d.parent_names || [])[1], map: "https://nav.tum.de/room/" + encodeURIComponent(d.id) };
    } catch { return null; }
  })();
  roomCache.set(loc, p); return p;
}

// --- Helpers ---
let mode = "day";
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function fmt(d) { return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
function dlabel(d, o = { weekday: "long", day: "numeric", month: "long" }) { return d.toLocaleDateString("en-GB", o); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function monday(d) { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); }
function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
function el(tag, cls, html) { const x = document.createElement(tag); if (cls) x.className = cls; if (html != null) x.innerHTML = html; return x; }

// Event types: detected from the title. Each course keeps its own hue; the type changes the style + badge.
const W = w => new RegExp(`(?<![\\p{L}\\p{N}])(${w})(?![\\p{L}\\p{N}])`, "iu");
const TYPES = [
  ["ZÜ", "Zentralübung", W("ZÜ|ZU|Zentralübung")],
  ["TUT", "Tutorium", W("TUT|TÜ|Tutorium|Tutorübung|Tutorien")],
  ["UE", "Übung", W("UE|ÜB|Ü|Übung|Übungen|Exercise")],
  ["PR", "Praktikum", W("PR|Praktikum|Labor|Lab")],
  ["SE", "Seminar", W("SE|HS|PS|Seminar|Hauptseminar")],
  ["VO", "Vorlesung", W("VO|VL|VI|Vorlesung|Lecture")],
];
function evType(title) { for (const [k, name, re] of TYPES) if (re.test(title || "")) return { k, name }; return { k: "", name: "Other" }; }
function baseName(title) {
  return (title || "").replace(/\s*\([^)]*\)\s*$/g, "").replace(/\s*[-–,]\s*(VO|UE|ZÜ|TUT|PR|SE|Vorlesung|Übung|Zentralübung|Tutorium|Tutorübung|Praktikum)\b.*$/i, "")
    .replace(/\b(VO|VI|UE|ZÜ|TUT|PR|SE)\b/g, "").replace(/\b(Zentral)?übung\b|\bTutor(ium|übung)\b|\bVorlesung\b/gi, "").replace(/\s{2,}/g, " ").trim() || title || "";
}
function hue(title) { const key = baseName(title).toLowerCase(); let h = 7; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
function decorate(node, e) { const t = evType(e.title); node.style.setProperty("--h", hue(e.title)); node.dataset.type = t.k || "X"; return t; }
function eventsOn(d) { const n = addDays(d, 1); return events.filter(e => e.start < n && e.end > d).sort((a, b) => a.start - b.start || b.end - a.end); }
function roomText(e) { return e.location ? e.location.split(",")[0].trim() : ""; }
function locLine(e, rm) { return rm ? [rm.short, rm.building].filter(Boolean).join(" · ") : (e.location || "–"); }
function details(e, rm) { return `${fmt(e.start)}–${fmt(e.end)}  ${e.title}\n${rm ? [rm.short, rm.name, rm.building, rm.campus].filter(Boolean).join(" · ") : (e.location || "")}`; }
const pct = d => Math.min(100, Math.max(0, ((d.getHours() + d.getMinutes() / 60 - START_H) / (END_H - START_H)) * 100));
function layout(list) { // lanes + conflicts
  const lanes = []; for (const e of list) { let i = lanes.findIndex(end => end <= e.start); if (i < 0) { i = lanes.length; lanes.push(0); } lanes[i] = e.end; e.lane = i; e.clash = false; }
  let n = 0; for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (list[j].start < list[i].end && list[i].start < list[j].end) { list[i].clash = list[j].clash = true; n++; }
  return { lanes: Math.max(1, lanes.length), conflicts: n };
}
function fillRoom(node, e) {
  resolveRoom(e.location).then(rm => {
    if (!rm) return; const a = node.querySelector(".loc"); if (a) a.textContent = locLine(e, rm); node.title = details(e, rm);
    if (node.tagName === "A") node.href = rm.map;
    const b = node.querySelector(".full"); if (b) b.textContent = [rm.name, rm.building, rm.campus].filter(Boolean).join(" · ");
    const m = node.querySelector(".map"); if (m) { m.href = rm.map; m.hidden = false; }
  });
}
function evBlock(e, compact) {
  const a = el("a", "ev" + (e.end < new Date() ? " past" : "") + (e.clash ? " clash" : "")); a.target = "_blank"; a.rel = "noopener";
  const t = decorate(a, e);
  a.innerHTML = `<span class="nm">${t.k ? `<i class="tb">${t.k}</i>` : ""}${esc(baseName(e.title))}</span><span class="loc">${esc(locLine(e))}</span>` + (compact ? "" : `<span class="t">${fmt(e.start)}–${fmt(e.end)}</span>`);
  a.title = details(e); fillRoom(a, e); return a;
}
function buildTrack(list, d, compact) {
  const { lanes } = layout(list), laneH = compact ? 58 : 92, top = compact ? 4 : 26;
  const track = el("div", "track" + (compact ? " compact" : "")); track.style.height = (top + lanes * (laneH + 4) + 2) + "px";
  for (let h = START_H; h <= END_H; h++) { const x = el("div", "hour" + (h % 2 ? " odd" : ""), compact ? "" : h + ":00"); x.style.left = ((h - START_H) / (END_H - START_H) * 100) + "%"; track.appendChild(x); }
  const now = new Date();
  if (sameDay(now, d)) { const nm = el("div", "now"); nm.style.left = pct(now) + "%"; if (!compact) nm.dataset.t = fmt(now); track.appendChild(nm); }
  for (const e of list) {
    const a = evBlock(e, compact), l = pct(e.start), r = pct(e.end);
    a.style.left = `calc(${l}% + 1px)`; a.style.width = `calc(${Math.max(r - l, 1.5)}% - 2px)`; a.style.top = (top + e.lane * (laneH + 4)) + "px"; a.style.height = laneH + "px";
    track.appendChild(a);
  }
  return track;
}
function legendFor(list) {
  const seen = new Map(); for (const e of list) { const t = evType(e.title); if (!seen.has(t.k)) seen.set(t.k, t.name); }
  const lg = el("div", "legend");
  for (const [k, name] of seen) { const s = el("span", "lg", `<i class="sw" data-type="${k || "X"}"></i>${esc(name)}`); lg.appendChild(s); }
  if (list.some(e => e.clash)) lg.appendChild(el("span", "lg", `<i class="sw clashsw"></i>Overlap`));
  return lg;
}
function hourAxis() { const ax = el("div", "axis"); for (let h = START_H; h <= END_H; h += 1) { const x = el("span", "", h % 2 ? "" : String(h)); x.style.left = ((h - START_H) / (END_H - START_H) * 100) + "%"; ax.appendChild(x); } return ax; }

function renderDay(v) {
  const list = eventsOn(day), today = sameDay(day, new Date()), { conflicts } = layout(list);
  $("dayLabel").innerHTML = esc(dlabel(day)) + (today ? '<span class="badge">TODAY</span>' : "") + `<small>${list.length} event${list.length === 1 ? "" : "s"}</small>` + (conflicts ? `<span class="cbadge">${conflicts} overlap${conflicts > 1 ? "s" : ""}</span>` : "");
  if (!list.length) {
    const box = el("div", "empty", `<div class="big">${today ? "No classes today" : "No classes on this day"}</div>`);
    const nxt = events.filter(e => e.start >= addDays(day, 1)).sort((a, b) => a.start - b.start)[0];
    if (nxt) { const b = el("button", "primary", `Next class: ${esc(dlabel(nxt.start, { weekday: "short", day: "numeric", month: "short" }))}, ${fmt(nxt.start)} · ${esc(baseName(nxt.title))}`); b.onclick = () => { day = startOfDay(nxt.start); render(1); }; box.appendChild(b); }
    else if (!events.length) box.appendChild(el("p", "muted", "No events were loaded. If this is unexpected, check that the token has the Kalender permission."));
    v.appendChild(box); return;
  }
  v.appendChild(legendFor(list));
  const tl = el("div", "tl"); tl.appendChild(buildTrack(list, day, false)); v.appendChild(tl);
  requestAnimationFrame(() => { const first = today ? new Date() : list[0].start; tl.scrollLeft = Math.max(0, (pct(first) / 100) * tl.scrollWidth - 80); });
  const cards = el("div", "cards"); const now = new Date();
  for (const e of list) {
    const c = el("div", "card" + (e.start <= now && e.end > now ? " live" : "") + (e.clash ? " clash" : "")); const t = decorate(c, e);
    c.innerHTML = `<div class="row1"><span class="t">${fmt(e.start)}–${fmt(e.end)}</span>${t.k ? `<i class="tb">${esc(t.name)}</i>` : ""}${e.clash ? '<i class="cb">overlap</i>' : ""}</div>
      <div class="nm">${esc(baseName(e.title))}</div><div class="loc">${esc(locLine(e))}</div><div class="full muted">${esc(e.location || "")}</div><a class="map" target="_blank" rel="noopener" hidden>Open map →</a>`;
    c.title = details(e); fillRoom(c, e); cards.appendChild(c);
  }
  v.appendChild(cards);
}

function weekDays(m) { const ds = []; for (let i = 0; i < 7; i++) { const d = addDays(m, i); if (i < 5 || eventsOn(d).length) ds.push(d); } return ds; }
function renderWeek(v) {
  const m = monday(day), sun = addDays(m, 6);
  const all = []; let conflicts = 0; for (const d of weekDays(m)) { const l = eventsOn(d); conflicts += layout(l).conflicts; all.push(...l); }
  $("dayLabel").innerHTML = `Week of ${esc(dlabel(m, { day: "numeric", month: "short" }))} – ${esc(dlabel(sun, { day: "numeric", month: "short", year: "numeric" }))}<small>${all.length} events</small>` + (conflicts ? `<span class="cbadge">${conflicts} overlap${conflicts > 1 ? "s" : ""}</span>` : "");
  v.appendChild(legendFor(all));
  const box = el("div", "tl week"), inner = el("div", "winner");
  const head = el("div", "wrow whead"); head.append(el("div", "wd", ""), hourAxis()); inner.appendChild(head);
  for (const d of weekDays(m)) {
    const list = eventsOn(d), i = (d.getDay() + 6) % 7;
    const row = el("div", "wrow" + (sameDay(d, new Date()) ? " today" : ""));
    const lab = el("button", "wd", `${DOW[i]}<small>${d.getDate()}.${d.getMonth() + 1}.</small>`); lab.onclick = () => { day = d; setMode("day"); };
    row.append(lab, buildTrack(list, d, true)); inner.appendChild(row);
  }
  box.appendChild(inner); v.appendChild(box);
}

function render(dx = 0) {
  const v = $("view");
  const draw = () => { v.innerHTML = ""; try { mode === "day" ? renderDay(v) : renderWeek(v); } catch (e) { showError("Render", e); } v.classList.remove("fade"); };
  if (!dx) return draw();
  v.style.setProperty("--dx", (dx > 0 ? -24 : 24) + "px"); v.classList.add("fade"); setTimeout(draw, 140);
}
function setMode(m) { mode = m; $("vDay").classList.toggle("on", m === "day"); $("vWeek").classList.toggle("on", m === "week"); render(); }

// --- Semester PDF: ONE A4 landscape page with a typical week + exceptions ---
function isCancelled(e) { return /cancel|storn|abgesagt|entf(ä|ae)llt|f(ä|ae)llt aus/i.test((e.status || "").trim()) || /\b(abgesagt|entfällt|storniert|cancell?ed)\b/i.test(e.title || ""); }
const hm = d => d.getHours() * 60 + d.getMinutes();
const dShort = d => `${DOW[(d.getDay() + 6) % 7]} ${d.getDate()}.${d.getMonth() + 1}.`;
function semesterModel() {
  const all = events.slice().sort((a, b) => a.start - b.start);
  if (!all.length) return null;
  const first = startOfDay(all[0].start), last = startOfDay(all[all.length - 1].start);
  const groups = new Map();
  for (const e of all) { const k = [baseName(e.title), evType(e.title).k, e.start.getDay(), hm(e.start), hm(e.end)].join("|"); (groups.get(k) || groups.set(k, []).get(k)).push(e); }
  const slots = [], oneOffs = [], roomChanges = [], missing = [];
  for (const list of groups.values()) {
    if (list.length < 3) { oneOffs.push(...list); continue; }
    const rc = new Map(); for (const e of list) rc.set(e.location || "", (rc.get(e.location || "") || 0) + 1);
    const room = [...rc].sort((a, b) => b[1] - a[1])[0][0];
    const gaps = list.slice(1).map((e, i) => Math.round((startOfDay(e.start) - startOfDay(list[i].start)) / 6048e5)).filter(g => g > 0).sort((a, b) => a - b);
    const step = gaps[Math.floor(gaps.length / 2)] || 1;
    const s = { e: list[0], list, room, step, from: list[0].start, to: list[list.length - 1].start };
    slots.push(s);
    for (const e of list) if ((e.location || "") !== room) roomChanges.push({ e, room });
    const have = new Set(list.map(e => startOfDay(e.start).getTime()));
    for (let d = startOfDay(s.from); d <= s.to; d = addDays(d, 7 * step)) if (!have.has(d.getTime())) {
      const c = cancelled.find(x => sameDay(x.start, d) && baseName(x.title) === baseName(s.e.title));
      missing.push({ s, d, why: c ? "cancelled" : "" });
    }
  }
  // Days with recurring slots but no events at all = no lectures
  const slotDays = new Set(slots.map(s => s.e.start.getDay())), noLect = [];
  for (let d = new Date(first); d <= last; d = addDays(d, 1)) if (slotDays.has(d.getDay()) && !eventsOn(d).length && missing.some(m => sameDay(m.d, d))) noLect.push(new Date(d));
  const isNo = d => noLect.some(x => sameDay(x, d));
  return { first, last, slots, oneOffs, roomChanges, missing: missing.filter(m => !isNo(m.d)), noLect };
}
async function exportPdf() {
  const M = semesterModel(); if (!M) return showError("PDF", new Error("No events loaded."));
  const btn = $("print"); btn.disabled = true; btn.textContent = "Preparing…";
  const locs = new Set([...M.slots.map(s => s.room), ...M.oneOffs.map(e => e.location), ...M.roomChanges.map(r => r.e.location)]);
  const rooms = new Map(await Promise.all([...locs].map(async l => [l, await resolveRoom(l)])));
  btn.disabled = false; btn.textContent = "Save semester PDF";
  const loc = l => { const r = rooms.get(l); return r ? [r.short, r.building].filter(Boolean).join(" · ") : (l || "–"); };
  const out = $("printout"); out.innerHTML = "";
  const pg = el("div", "ppage"), fit = el("div", "pfit"); pg.appendChild(fit);
  const D = o => dlabel(o, { day: "numeric", month: "short", year: "numeric" });
  fit.appendChild(el("div", "ph", `<h1>Semester timetable</h1><span>${esc(D(M.first))} – ${esc(D(M.last))} · typical week · TUM Schedule</span>`));
  const cols = [1, 2, 3, 4, 5]; if (M.slots.some(s => s.e.start.getDay() === 6)) cols.push(6); if (M.slots.some(s => s.e.start.getDay() === 0)) cols.push(0);
  let h0 = Math.min(...M.slots.map(s => s.e.start.getHours()), 10), h1 = Math.max(...M.slots.map(s => Math.ceil(hm(s.e.end) / 60)), 16);
  h0 = Math.max(START_H, h0); h1 = Math.min(END_H, h1);
  const P = d => Math.min(100, Math.max(0, (hm(d) / 60 - h0) / (h1 - h0) * 100));
  const grid = el("div", "pgrid"); grid.style.setProperty("--cols", cols.length);
  const axis = el("div", "pax"); axis.appendChild(el("div", "pdh", ""));
  const ab = el("div", "pcolbody"); for (let h = h0; h <= h1; h++) { const t = el("span", "", h + ":00"); t.style.top = ((h - h0) / (h1 - h0) * 100) + "%"; ab.appendChild(t); }
  axis.appendChild(ab); grid.appendChild(axis);
  for (const wd of cols) {
    const ss = M.slots.filter(s => s.e.start.getDay() === wd).sort((a, b) => hm(a.e.start) - hm(b.e.start));
    const fake = ss.map(s => { const st = new Date(2000, 0, 3, 0, hm(s.e.start)), en = new Date(2000, 0, 3, 0, hm(s.e.end)); return { start: st, end: en, s }; });
    const { lanes } = layout(fake);
    const col = el("div", "pcol"); col.appendChild(el("div", "pdh", DOW[(wd + 6) % 7]));
    const cb = el("div", "pcolbody");
    for (let h = h0; h <= h1; h++) { const g = el("i", "pgl"); g.style.top = ((h - h0) / (h1 - h0) * 100) + "%"; cb.appendChild(g); }
    for (const f of fake) {
      const s = f.s, b = el("div", "pev" + (f.clash ? " clash" : "")), t = decorate(b, s.e);
      b.style.top = P(s.e.start) + "%"; b.style.height = Math.max(P(s.e.end) - P(s.e.start), 3) + "%";
      b.style.left = (f.lane / lanes * 100) + "%"; b.style.width = (100 / lanes) + "%";
      const cad = s.step === 1 ? "weekly" : s.step === 2 ? "biweekly" : `every ${s.step} wks`;
      b.innerHTML = `<b>${t.k ? `<i class="tb">${t.k}</i>` : ""}${esc(baseName(s.e.title))}</b><span>${esc(loc(s.room))}</span><small>${fmt(s.e.start)}–${fmt(s.e.end)} · ${cad} · ${s.from.getDate()}.${s.from.getMonth() + 1}.–${s.to.getDate()}.${s.to.getMonth() + 1}.</small>`;
      cb.appendChild(b);
    }
    col.appendChild(cb); grid.appendChild(col);
  }
  fit.appendChild(grid); fit.appendChild(legendFor(M.slots.map(s => s.e)));
  const items = [];
  for (const d of M.noLect) items.push([d, `<b>${dShort(d)}</b> – no lectures`]);
  for (const m of M.missing) items.push([m.d, `<b>${dShort(m.d)}</b> ${esc(baseName(m.s.e.title))} ${evType(m.s.e.title).k} ${fmt(m.s.e.start)} – ${m.why || "does not take place"}`]);
  for (const r of M.roomChanges) items.push([r.e.start, `<b>${dShort(r.e.start)}</b> ${esc(baseName(r.e.title))} ${fmt(r.e.start)} – room change: ${esc(loc(r.e.location))}`]);
  for (const e of M.oneOffs) items.push([e.start, `<b>${dShort(e.start)}</b> ${fmt(e.start)}–${fmt(e.end)} ${esc(baseName(e.title))} ${evType(e.title).k} · ${esc(loc(e.location))} <i>(extra)</i>`]);
  items.sort((a, b) => a[0] - b[0]);
  if (items.length) { const ex = el("div", "pex", `<h3>Exceptions &amp; extra dates</h3>`); const ul = el("ul"); for (const [, h] of items) ul.appendChild(el("li", "", h)); ex.appendChild(ul); fit.appendChild(ex); }
  out.appendChild(pg);
  // scale to guarantee a single page (A4 landscape minus 10mm margins ≈ 1046×718 CSS px)
  out.classList.add("measure"); fit.style.zoom = 1;
  const W = 1040, H = 712, z = Math.min(1, W / fit.scrollWidth, H / fit.scrollHeight); fit.style.zoom = z.toFixed(3);
  out.classList.remove("measure");
  setTimeout(() => window.print(), 50);
}

function logout() { clearInterval(pollTimer); store.clear(); $("remember").checked = false; events = []; cancelled = []; roomCache.clear(); $("tumid").value = $("tokenIn").value = ""; $("msg").textContent = ""; $("msg2").textContent = "Waiting for activation – checking every 5 s…"; $("printout").innerHTML = ""; show("login"); }
function shift(n) { day = addDays(day, n * (mode === "week" ? 7 : 1)); render(n); }

$("req").onclick = requestToken;
$("tumid").onkeydown = e => { if (e.key === "Enter") requestToken(); };
$("useTok").onclick = () => { const t = $("tokenIn").value.trim(); if (!t) return; store.set(t); startActivation(t); };
$("ics").onchange = async e => { const f = e.target.files[0]; if (!f) return; const all = parseICS(await f.text()); cancelled = all.filter(isCancelled); events = all.filter(e => !isCancelled(e)); show("cal"); render(); };
$("logout").onclick = logout;
$("prev").onclick = () => shift(-1); $("next").onclick = () => shift(1);
$("today").onclick = () => { day = startOfDay(new Date()); render(); };
$("vDay").onclick = () => setMode("day"); $("vWeek").onclick = () => setMode("week");
$("print").onclick = exportPdf;
$("theme").onclick = () => { const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; r.dataset.theme = dark ? "light" : "dark"; };
document.addEventListener("keydown", e => { if ($("cal").hidden || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return; if (e.key === "ArrowLeft") shift(-1); if (e.key === "ArrowRight") shift(1); if (e.key === "t") $("today").click(); });
let tx = null, ty = null;
$("view").addEventListener("touchstart", e => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
$("view").addEventListener("touchend", e => { if (tx == null) return; const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty; const tl = e.target.closest(".tl"); const atEdge = !tl || tl.scrollLeft <= 0 || tl.scrollLeft + tl.clientWidth >= tl.scrollWidth - 1;
  if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && atEdge) shift(dx > 0 ? -1 : 1); tx = null; });
setInterval(() => { const n = new Date(); document.querySelectorAll(".now").forEach(x => { x.style.left = pct(n) + "%"; if (x.dataset.t) x.dataset.t = fmt(n); }); }, 60000);
const saved = store.get(); if (localStorage.getItem("tumSchedTok")) $("remember").checked = true; if (saved) startActivation(saved); else show("login");
$("remember").onchange = () => { const t = sessionStorage.getItem("tok"); if ($("remember").checked) { if (t) localStorage.setItem("tumSchedTok", t); } else localStorage.removeItem("tumSchedTok"); };
