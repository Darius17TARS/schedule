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
const MIN_H = 7, MAX_H = 21; let START_H = MIN_H, END_H = MAX_H;
let zoom = +localStorage.getItem("tumSchedZoom") || 1, trim = localStorage.getItem("tumSchedTrim") === "1";
let events = [], cancelled = [], day = startOfDay(new Date()), pollTimer = null;
const roomCache = new Map();
const FOPT = { referrerPolicy: "no-referrer", credentials: "omit" };

function semesterMonths() { const n = new Date(), m = n.getMonth(); const ws = m >= 9 || m < 3; const startM = ws ? (m >= 9 ? m - 9 : m + 3) : m - 3; return { pMonateVor: startM + 1, pMonateNach: 6 - startM }; }
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function show(id) { for (const s of ["login", "activate", "cal"]) $(s).hidden = s !== id; $("logout").hidden = id === "login"; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

async function api(method, params) {
  const r = await fetch(BASE + method + "?" + new URLSearchParams(params), { referrerPolicy: "no-referrer", credentials: "omit", cache: "no-store" });
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
    const doc = await api("requestToken", { pUsername: id, pTokenName: "Darius Schedule Improvisory App Token" });
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
        const r = await (await fetch(NAV + "search?" + new URLSearchParams({ q }), FOPT)).json();
        id = r.sections?.find(s => s.facet === "rooms")?.entries?.[0]?.id;
        if (!id) return null;
      }
      const d = await (await fetch(NAV + "locations/" + encodeURIComponent(id), FOPT)).json();
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
function shortName(title) {
  let n = baseName(title)
    .replace(/^(Übung|Übungen|Tutorium|Tutorübung|Zentralübung|Vorlesung|Praktikum|Seminar)\s+(zu|zur|zum)?\s*/i, "")
    .replace(/^(Grundlagen|Einführung|Einf\.)\s+(der|des|in die|in das|in den|in)\s+/i, "")
    .replace(/\s+für\s+/gi, " f. ").replace(/\s+und\s+/gi, " & ").replace(/Ingenieur(e|innen|wesen)?(\s*\/?\s*-?innen)?/gi, "Ing.")
    .replace(/Maschinenbau(s)?/gi, "MB").replace(/Technische(n|r)?\s+/gi, "Techn. ").replace(/Mathematik/gi, "Mathe").replace(/\s*[-–:]\s+.*$/, "").trim();
  n = n.replace(/(?<![\p{L}])(Übung|Übungen|Zentralübung|Tutorübung|Tutorium|Vorlesung)(?![\p{L}])/giu, "").replace(/Ing\. & Ing\./g, "Ing.").replace(/\s{2,}/g, " ").trim();
  n = n.split(" ").map(x => x.length > (n.length > 20 ? 8 : 11) ? x.slice(0, 6).replace(/[aeiouäöü]+$/i, "") + "." : x).join(" ");
  return n || baseName(title);
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
  a.innerHTML = `${t.k ? `<i class="tb" data-t="${t.k}">${t.k}</i>` : ""}<span class="nm" lang="de"><span class="fn">${esc(baseName(e.title))}</span><span class="sn">${esc(shortName(e.title))}</span></span><span class="loc">${esc(locLine(e))}</span>` + (compact ? "" : `<span class="t">${fmt(e.start)}–${fmt(e.end)}</span>`);
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
  for (const [k, name] of seen) { const s = el("span", "lg", `${k ? `<i class="tb" data-t="${k}">${k}</i>` : `<i class="sw" data-type="X"></i>`}${esc(name)}`); lg.appendChild(s); }
  if (list.some(e => e.clash)) lg.appendChild(el("span", "lg", `<i class="sw clashsw"></i>Overlap`));
  return lg;
}
function hourAxis() { const ax = el("div", "axis"); for (let h = START_H; h <= END_H; h += 1) { const x = el("span", "", h % 2 ? "" : String(h)); x.style.left = ((h - START_H) / (END_H - START_H) * 100) + "%"; ax.appendChild(x); } return ax; }

function renderDay(v) {
  setRange(eventsOn(day)); const list = eventsOn(day), today = sameDay(day, new Date()), { conflicts } = layout(list);
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
    c.innerHTML = `<div class="row1"><span class="t">${fmt(e.start)}–${fmt(e.end)}</span>${t.k ? `<i class="tb" data-t="${t.k}">${esc(t.name)}</i>` : ""}${e.clash ? '<i class="cb">overlap</i>' : ""}</div>
      <div class="nm">${esc(baseName(e.title))}</div><div class="loc">${esc(locLine(e))}</div><div class="full muted">${esc(e.location || "")}</div><a class="map" target="_blank" rel="noopener" hidden>Open map →</a>`;
    c.title = details(e); fillRoom(c, e); cards.appendChild(c);
  }
  v.appendChild(cards);
}

function weekDays(m) { const ds = []; for (let i = 0; i < 7; i++) { const d = addDays(m, i); if (i < 5 || eventsOn(d).length) ds.push(d); } return ds; }
function renderWeek(v) {
  const m = monday(day), sun = addDays(m, 6);
  setRange(weekDays(m).flatMap(eventsOn));
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

function setRange(list) {
  START_H = MIN_H; END_H = MAX_H; if (!trim || !list.length) return;
  START_H = Math.max(MIN_H, Math.min(...list.map(e => e.start.getHours())) - 1);
  END_H = Math.min(MAX_H, Math.max(...list.map(e => Math.ceil((e.end.getHours() * 60 + e.end.getMinutes()) / 60))) + 1);
  if (END_H - START_H < 4) END_H = Math.min(MAX_H, START_H + 4);
}
function zoomTarget() { const tl = $("view").querySelector(".tl"); return tl && [tl, tl.querySelector(".winner") || tl.querySelector(".track")]; }
function applyZoom(z, clientX) {
  zoom = Math.min(6, Math.max(1, Math.round(z * 100) / 100));
  const zt = zoomTarget(); $("zFit").textContent = Math.round(zoom * 100) + "%"; $("zFit").disabled = zoom === 1;
  if (localStorage.getItem("tumSchedTok")) localStorage.setItem("tumSchedZoom", zoom); else localStorage.removeItem("tumSchedZoom");
  if (!zt) return; const [tl, inner] = zt, r = tl.getBoundingClientRect(), x = (clientX ?? r.left + r.width / 2) - r.left;
  const frac = (tl.scrollLeft + x) / tl.scrollWidth; tl.style.scrollBehavior = "auto";
  inner.style.width = (zoom * 100) + "%"; tl.scrollLeft = frac * tl.scrollWidth - x; tl.style.scrollBehavior = "";
}
function render(dx = 0) {
  try { renderExams(); } catch (e) { console.warn(e); }
  const v = $("view"); if (events.length) loadJsPDF().catch(() => {});
  const draw = () => { v.innerHTML = ""; try { mode === "day" ? renderDay(v) : renderWeek(v); applyZoom(zoom); } catch (e) { showError("Render", e); } v.classList.remove("fade"); };
  if (!dx) return draw();
  v.style.setProperty("--dx", (dx > 0 ? -24 : 24) + "px"); v.classList.add("fade"); setTimeout(draw, 140);
}
function setMode(m) { mode = m; $("vDay").classList.toggle("on", m === "day"); $("vWeek").classList.toggle("on", m === "week"); render(); }

// --- Semester PDF: ONE A4 landscape page with a typical week + exceptions ---
function isCancelled(e) { return /cancel|storn|abgesagt|entf(ä|ae)llt|f(ä|ae)llt aus/i.test((e.status || "").trim()) || /\b(abgesagt|entfällt|storniert|cancell?ed)\b/i.test(e.title || ""); }
const APPV = 19;
const hm = d => d.getHours() * 60 + d.getMinutes();
const dShort = d => `${DOW[(d.getDay() + 6) % 7]} ${d.getDate()}.${d.getMonth() + 1}.`;
function semesterModel() {
  const all = events.filter(e => !isExam(e)).sort((a, b) => a.start - b.start);
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
  for (let d = new Date(first); d <= last; d = addDays(d, 1)) if (slotDays.has(d.getDay())) { const tot = slots.filter(s => s.e.start.getDay() === d.getDay() && d >= startOfDay(s.from) && d <= s.to).length, miss = missing.filter(m => sameDay(m.d, d)).length; if (miss && (miss >= tot * 0.6 || !eventsOn(d).length)) noLect.push(new Date(d)); }
  const isNo = d => noLect.some(x => sameDay(x, d));
  return { first, last, slots, oneOffs, roomChanges, missing: missing.filter(m => !isNo(m.d)), noLect };
}
// --- Vector PDF (jsPDF, vendored) — one A4 landscape page, identical on every browser ---
const TCOL = { VO: "#2563eb", UE: "#059669", "ZÜ": "#d97706", TUT: "#db2777", PR: "#7c3aed", SE: "#0891b2" };
function hsl2rgb(h, s, l) { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))); return [f(0), f(8), f(4)]; }
function hex2rgb(x) { return [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16)); }
const pdfTxt = s => String(s || "").normalize("NFC").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D\u201E]/g, '"').replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2022\u2026\u20AC]/g, c => c.normalize("NFKD").replace(/[^\x20-\x7E]/g, "") || "?");
let jspdfP;
function loadJsPDF() { return jspdfP || (jspdfP = new Promise((ok, no) => { if (window.jspdf) return ok(window.jspdf); const s = document.createElement("script"); s.src = "vendor/jspdf.umd.min.js?v=" + APPV; s.onload = () => window.jspdf ? ok(window.jspdf) : no(new Error("jsPDF missing")); s.onerror = () => { jspdfP = null; no(new Error("jsPDF failed to load")); }; document.head.appendChild(s); })); }
function fitLine(doc, s, w) { s = pdfTxt(s); if (doc.getTextWidth(s) <= w) return s; while (s.length > 1 && doc.getTextWidth(s + "…") > w) s = s.slice(0, -1); return s.trimEnd() + "…"; }
function wrapLines(doc, s, w, max) { const ls = doc.splitTextToSize(pdfTxt(s), w); if (ls.length <= max) return ls; const o = ls.slice(0, max); o[max - 1] = fitLine(doc, ls.slice(max - 1).join(" "), w); return o; }
function buildPdf(J, M, loc, items) {
  const doc = new J.jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  const PW = 297, PH = 210, m = 10, X0 = m, X1 = PW - m;
  const D = o => dlabel(o, { day: "numeric", month: "short", year: "numeric" });
  doc.setProperties({ title: "Semester timetable", creator: "TUM Schedule" });
  doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(17); doc.text("Semester timetable", X0, m + 5);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(90); doc.text(pdfTxt(`${D(M.first)} – ${D(M.last)} · typical week · TUM Schedule`), X1, m + 5, { align: "right" });
  // exceptions: 3 columns flowing top-to-bottom, lines wrap inside the column (no truncation)
  const gTop = m + 9, legH = 7, minGrid = 105;
  let ex = null;
  if (items.length) {
    const avail = PH - m - gTop - minGrid - legH, gap = 6, colW = (X1 - X0 - 2 * gap) / 3;
    for (const fs of [6.5, 6, 5.5, 5, 4.6, 4.2, 3.8]) {
      const lh = fs * 0.43; doc.setFontSize(fs);
      const L = items.map(([, b, r]) => { doc.setFont("helvetica", "bold"); const bw = doc.getTextWidth(pdfTxt(b) + " "); doc.setFont("helvetica", "normal");
        const f = doc.splitTextToSize(pdfTxt(r), colW - bw)[0] || ""; const rest = pdfTxt(r).slice(f.length).trim(); return { b: pdfTxt(b), bw, lines: [f, ...(rest ? doc.splitTextToSize(rest, colW) : [])] }; });
      const tot = L.reduce((a, x) => a + x.lines.length, 0);
      for (let H = Math.max(...L.map(x => x.lines.length), Math.ceil(tot / 3)); H * lh + 5 <= avail; H++) {
        const cols = [[]]; let used = 0; for (const x of L) { if (used + x.lines.length > H) { cols.push([]); used = 0; } cols[cols.length - 1].push(x); used += x.lines.length; }
        if (cols.length <= 3) { ex = { fs, lh, colW, gap, cols, h: 5 + H * lh }; break; }
      }
      if (ex) break;
    }
    if (!ex) { const fs = 3.8, lh = fs * 0.43; doc.setFontSize(fs); const H = Math.floor((avail - 5) / lh), cols = [[]]; let used = 0, cut = 0;
      for (const [, b, r] of items) { const lines = doc.splitTextToSize(pdfTxt(r), colW - 8); if (used + lines.length > H) { if (cols.length === 3) { cut++; continue; } cols.push([]); used = 0; } doc.setFont("helvetica", "bold"); cols[cols.length - 1].push({ b: pdfTxt(b), bw: doc.getTextWidth(pdfTxt(b) + " "), lines }); used += lines.length; }
      ex = { fs, lh, colW, gap, cols, h: 5 + H * lh, cut }; }
  }
  const gBot = PH - m - (ex ? ex.h + 1 : 0) - legH;
  const cols = [1, 2, 3, 4, 5]; if (M.slots.some(s => s.e.start.getDay() === 6)) cols.push(6); if (M.slots.some(s => s.e.start.getDay() === 0)) cols.push(0);
  let h0 = Math.max(MIN_H, Math.min(...M.slots.map(s => s.e.start.getHours()), 10)), h1 = Math.min(MAX_H, Math.max(...M.slots.map(s => Math.ceil(hm(s.e.end) / 60)), 16));
  const ax = 9, dh = 5, bodyT = gTop + dh, bodyH = gBot - bodyT, cw = (X1 - X0 - ax) / cols.length;
  const Y = min => bodyT + Math.min(1, Math.max(0, (min / 60 - h0) / (h1 - h0))) * bodyH;
  doc.setDrawColor(215); doc.setLineWidth(0.2); doc.setFillColor(246, 247, 249); doc.rect(X0, gTop, X1 - X0, dh, "F");
  doc.setFontSize(6.5); doc.setTextColor(110);
  for (let h = h0; h <= h1; h++) { const y = Y(h * 60); doc.setDrawColor(228); doc.line(X0 + ax, y, X1, y); doc.text(`${h}:00`, X0 + ax - 1, y + (h === h0 ? 2.2 : 1), { align: "right" }); }
  cols.forEach((wd, i) => {
    const x = X0 + ax + i * cw; doc.setDrawColor(205); doc.line(x, gTop, x, gBot);
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(40); doc.text(DOW[(wd + 6) % 7], x + cw / 2, gTop + 3.6, { align: "center" });
    const ss = M.slots.filter(s => s.e.start.getDay() === wd).sort((a, b) => hm(a.e.start) - hm(b.e.start));
    const fake = ss.map(s => ({ start: new Date(2000, 0, 3, 0, hm(s.e.start)), end: new Date(2000, 0, 3, 0, hm(s.e.end)), s }));
    const { lanes } = layout(fake), lw = cw / lanes;
    for (const f of fake) {
      const s = f.s, t = evType(s.e.title), hh = hue(s.e.title), bx = x + f.lane * lw + 0.4, bw = lw - 0.8, by = Y(hm(s.e.start)) + 0.3, bh = Math.max(Y(hm(s.e.end)) - by - 0.3, 3);
      doc.setFillColor(...hsl2rgb(hh, t.k === "VO" ? 70 : 75, t.k === "VO" ? 78 : 86)); doc.setDrawColor(...hsl2rgb(hh, 62, 50)); doc.setLineWidth(0.25);
      doc.roundedRect(bx, by, bw, bh, 0.8, 0.8, "FD"); doc.setFillColor(...hsl2rgb(hh, 62, 50)); doc.rect(bx, by, 1.1, bh, "F");
      const tx = bx + 1.9, tw = bw - 2.6; let pillW = 0;
      if (t.k) { doc.setFont("helvetica", "bold"); doc.setFontSize(5.2); pillW = doc.getTextWidth(pdfTxt(t.k)) + 1.6; if (bw > 14) { doc.setFillColor(...hex2rgb(TCOL[t.k])); doc.roundedRect(bx + bw - pillW - 0.7, by + 0.7, pillW, 2.6, 0.6, 0.6, "F"); doc.setTextColor(255); doc.text(pdfTxt(t.k), bx + bw - pillW / 2 - 0.7, by + 2.5, { align: "center" }); } else { doc.setFillColor(...hex2rgb(TCOL[t.k])); doc.circle(bx + bw - 1.3, by + 1.3, 0.7, "F"); pillW = 1.6; } }
      const fs = bw < 22 ? 5.6 : 6.6, lh = fs * 0.4; doc.setFont("helvetica", "bold"); doc.setFontSize(fs); doc.setTextColor(17);
      const nm = bw < 30 ? shortName(s.e.title) : baseName(s.e.title);
      const cad = s.step === 1 ? "weekly" : s.step === 2 ? "biweekly" : `every ${s.step} wks`;
      const sub = [loc(s.room), `${fmt(s.e.start)}–${fmt(s.e.end)} · ${cad} · ${s.from.getDate()}.${s.from.getMonth() + 1}.–${s.to.getDate()}.${s.to.getMonth() + 1}.`];
      const cap = Math.max(1, Math.floor((bh - 1.2) / lh)); const nl = Math.max(1, Math.min(3, cap - (cap >= 3 ? 2 : cap >= 2 ? 1 : 0)));
      const first = doc.splitTextToSize(pdfTxt(nm), tw - pillW - 0.6)[0] || ""; const rest = pdfTxt(nm).slice(first.length).trim();
      const names = [first]; if (rest && nl > 1) names.push(...wrapLines(doc, rest, tw, nl - 1)); else if (rest) names[0] = fitLine(doc, nm, tw - pillW - 0.6);
      let y = by + 0.6 + lh; for (const l of names) { doc.text(l, tx, y); y += lh; }
      doc.setFont("helvetica", "normal"); doc.setFontSize(fs - 0.8); doc.setTextColor(50);
      for (const l of sub) { if (y > by + bh - 0.4) break; doc.text(fitLine(doc, l, tw), tx, y); y += lh * 0.92; }
    }
  });
  doc.setDrawColor(205); doc.setLineWidth(0.25); doc.rect(X0, gTop, X1 - X0, gBot - gTop);
  // legend
  let lx = X0, ly = gBot + 4.3; const seen = new Map(); for (const s of M.slots) { const t = evType(s.e.title); if (!seen.has(t.k)) seen.set(t.k, t.name); }
  for (const [k, name] of seen) {
    doc.setFont("helvetica", "bold"); doc.setFontSize(6); const pw = k ? doc.getTextWidth(pdfTxt(k)) + 2 : 5;
    if (k) { doc.setFillColor(...hex2rgb(TCOL[k])); doc.roundedRect(lx, ly - 2.4, pw, 3.2, 0.7, 0.7, "F"); doc.setTextColor(255); doc.text(pdfTxt(k), lx + 1, ly); } else { doc.setDrawColor(120); doc.rect(lx, ly - 2.2, pw, 2.8); }
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(60); doc.text(pdfTxt(name), lx + pw + 1.2, ly); lx += pw + doc.getTextWidth(pdfTxt(name)) + 6;
  }
  // exceptions in 3 columns
  if (ex) {
    const ey = gBot + legH + 1; doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(20); doc.text("Exceptions & extra dates", X0, ey + 2.6);
    doc.setFontSize(ex.fs);
    ex.cols.forEach((col, c) => { const x = X0 + c * (ex.colW + ex.gap); let y = ey + 5 + 0.8 * ex.lh;
      for (const it of col) { doc.setFont("helvetica", "bold"); doc.setTextColor(20); doc.text(it.b, x, y); doc.setFont("helvetica", "normal"); doc.setTextColor(55);
        it.lines.forEach((l, k) => { doc.text(l, k ? x : x + it.bw, y); y += ex.lh; }); } });
    if (ex.cut > 0) { doc.setFont("helvetica", "italic"); doc.text(`+ ${ex.cut} more`, X1, ey + 2.6, { align: "right" }); }
  }
  return doc;
}
async function deliverPdf(doc, name = "semester-timetable.pdf", ttl = "Semester timetable") {
  const blob = doc.output("blob");
  const file = typeof File === "function" ? new File([blob], name, { type: "application/pdf" }) : null;
  const touch = matchMedia("(pointer:coarse)").matches;
  if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: ttl }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  window.__lastPdf = blob;
}
// --- Exams: read from the personal calendar (Kalender permission). TUMonline has no public "registered exams" webservice. ---
const EXAM_RE = /(^|[\s:(\[–-])(wiederholungs|end|haupt|modul|semestral)?(pr(ü|ue)fung|klausur)|\bexam(ination)?\b|\bendterm\b|\bmidterm\b|\bretake\b|wiederholungs(prüfung|klausur)/i;
const EXAM_NOT = /einsicht|anmeldung|vorbereitung|repetitorium|review|prep|probe|mock|exkursion/i;
function isExam(e) { const s = `${e.title} ${e.status || ""}`; return EXAM_RE.test(s) && !EXAM_NOT.test(s); } // "PR" alone = Praktikum, never an exam
function examCourse(t) { return (t || "").replace(/\((schriftlich|mündlich|written|oral)[^)]*\)/gi, "").replace(/\b(schriftliche|mündliche|written|oral)\b/gi, "").replace(/\b(wiederholungs)?(pr(ü|ue)fung|klausur)(stermin)?\b|\b(final |re-?)?exam(ination)?\b|\b(endterm|midterm|retake)\b/gi, "").replace(/\(\s*\)/g, "").replace(/^[\s:–-]+|[\s:–-]+$/g, "").replace(/\s{2,}/g, " ").trim() || t; }
function examReg() { return events.filter(isExam).sort((a, b) => a.start - b.start).map(e => ({ e, course: examCourse(e.title), h: hue(examCourse(e.title)), min: Math.round((e.end - e.start) / 6e4) })); }
// --- Planned exams: public TUMonline exam list (no personal data), baked into data/ and matched locally by course name or module number ---
let PLAN = null, planP = null;
function loadPlan() { loadEcts(); return planP || (planP = fetch("data/exams-ws2026.json?v=" + APPV, { credentials: "omit" }).then(r => r.ok ? r.json() : null).catch(() => null).then(j => { PLAN = j; if (events.length) renderExams(); return j; })); }
const normE = t => examCourse(t || "").replace(/\s+[-–:]\s+(klausur|exam|prüfung)\b.*$/i, "").toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const normC = t => examCourse(baseName(t || "")).replace(/\s+[-–:]\s+(klausur|exam|prüfung)\b.*$/i, "").toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const MODNR = /\b([A-Z]{2,4}\d{3,6}(?:-\d+)?)\b/;
function plannedExams(reg) {
  if (!PLAN || !PLAN.exams) return [];
  const today = startOfDay(new Date()), byName = new Map(), byCode = new Map();
  for (const x of PLAN.exams) { const d = new Date(x.d + "T" + x.s + ":00"); if (d < today) continue; const k = normE(x.t); (byName.get(k) || byName.set(k, []).get(k)).push(x); (byCode.get(x.c) || byCode.set(x.c, []).get(x.c)).push(x); }
  const regN = new Set(reg.map(r => normC(r.course))), regT = reg.map(r => r.e.title).join(" "), seen = new Set(), out = [];
  const courses = new Map(); for (const e of events) if (!isExam(e) && !EXAM_NOT.test(e.title)) { const k = normC(e.title); if (k && !courses.has(k)) courses.set(k, e.title); }
  for (const [k, title] of courses) {
    const code = (title.match(MODNR) || [])[1], k2 = normC(title.split(/\s+[–-]\s+/)[0]); let c = code && byCode.get(code);
    if (!c) c = byName.get(k) || byName.get(k2);
    if (!c || !c.length || regN.has(k) || regN.has(k2) || (code && regT.includes(code))) continue;
    c = [...c].sort((a, b) => (a.d + a.s).localeCompare(b.d + b.s)); const f = c[0], key = f.t + f.d;
    if (seen.has(key)) continue; seen.add(key);
    const alt = c.filter(x => x.d === f.d && x.s === f.s), rooms = [...new Set(alt.map(x => x.r).filter(Boolean))];
    const start = new Date(f.d + "T" + f.s + ":00"), end = f.e ? new Date(f.d + "T" + f.e + ":00") : new Date(+start + 9e5 * 6), course = baseName(title).split(/\s+[–-]\s+/)[0];
    out.push({ planned: true, code: alt.map(x => x.c).join(" / "), e: { title: course, start, end, location: rooms.length === 1 ? rooms[0] : rooms.length ? "Room depends on degree programme: " + rooms.join(" | ") : "Room not published yet" }, course, h: hue(course), min: Math.round((end - start) / 6e4), noRoom: !rooms.length });
  }
  return out;
}
// --- ECTS: public module-handbook credits baked into data/ects.json (code -> ECTS, no personal data) ---
let ECTS = null, ectsP = null;
function loadEcts() { return ectsP || (ectsP = fetch("data/ects.json?v=" + APPV, { credentials: "omit" }).then(r => r.ok ? r.json() : null).catch(() => null).then(j => { ECTS = j; if (events.length) renderExams(); return j; })); }
const modBase = c => String(c || "").trim().toUpperCase().replace(/-\d+$/, "");
const ectsOf = c => { const m = ECTS && ECTS.m; if (!m || !c) return null; for (const k of String(c).split(/\s*\/\s*/)) { const v = m[modBase(k)]; if (v) return v; } return null; };
function examCode(x) {
  if (x.planned) return x.code; const c = (x.e.title.match(MODNR) || [])[1]; if (c) return c;
  if (PLAN && PLAN.exams) { const k = normC(x.course), h = PLAN.exams.find(p => normE(p.t) === k); if (h) return h.c; } return null;
}
const ectsTxt = v => (Math.round(v * 10) / 10).toString().replace(".", ",");
// --- Optional credits earned: wbservicesbasic.noten, kept in memory only (never stored, grades never shown) ---
let CRED = null, credOn = false, credBusy = false;
function passed(g) { g = String(g || "").trim(); const n = parseFloat(g.replace(",", ".")); if (!isNaN(n)) return n >= 1 && n <= 4.0; return /^(b|be|bestanden|passed|p|mit erfolg)/i.test(g); }
async function loadCredits() {
  const tok = sessionStorage.getItem("tok"); if (!tok) { CRED = { err: "Credits need a TUMonline token (not available for .ics uploads)." }; return; }
  credBusy = true; renderExams(); await loadEcts();
  try {
    const doc = await api("noten", { pToken: tok }), rows = [...doc.querySelectorAll("row")], got = new Map(), unk = new Set();
    const f = (r, ...n) => { for (const k of n) { const v = r.querySelector(k)?.textContent?.trim(); if (v) return v; } return ""; };
    for (const r of rows) {
      if (!passed(f(r, "uninotenamekurz", "note", "grade"))) continue;
      const code = modBase(f(r, "lv_nummer")), key = code || f(r, "lv_titel"); if (!key || got.has(key)) continue;
      const own = parseFloat(f(r, "lv_credits", "credits", "ects", "ects_credits").replace(",", "."));
      const v = own > 0 ? own : ectsOf(code); if (v) got.set(key, v); else { unk.add(key); got.set(key, 0); }
    }
    CRED = { sum: [...got.values()].reduce((a, b) => a + b, 0), passed: new Set(got.keys()), n: got.size, unk: unk.size, rows: rows.length };
  } catch (e) { CRED = { err: /berechtigung|permission|rechte|not allowed|keine/i.test(e.message) ? "Your token doesn’t have the “Noten” permission. Enable it in the TUMonline token settings, then tick again." : "Couldn’t load credits: " + e.message }; }
  credBusy = false; renderExams();
}
function examList() { const R = examReg(); return [...R, ...plannedExams(R)].sort((a, b) => a.e.start - b.e.start); }
const planNote = () => PLAN ? `Planned = not registered yet. Date/room from the public TUMonline exam list (${PLAN.source.replace(/^https?:\/\//, "").replace(/\?.*$/, "")}), as of ${PLAN.updated}; matched to your courses by name/module number on this device. Binding info only in TUMonline after you register (WiSe 26/27 registration 16.11.2026–15.01.2027).` : "";
const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 864e5);
function studyDays(a, b) { // every calendar day without an exam between the two exam days (weekends included)
  let n = 0; for (let d = addDays(startOfDay(a), 1); d < startOfDay(b); d = addDays(d, 1)) n++; return n; }
const durTxt = m => m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`;
const EXAM_NONE = "No exams found in your TUMonline calendar. Exams only appear here after you register for them in TUMonline (the token's Kalender permission is enough — TUMonline offers no separate exam webservice).";
function examSummary(X) {
  const gaps = X.slice(1).map((x, i) => dayDiff(X[i].e.start, x.e.start));
  const done = CRED && CRED.passed; let ects = 0, noE = 0; for (const x of X) { const c = examCode(x); x.ects = ectsOf(c); if (done && c && done.has(modBase(String(c).split(/\s*\/\s*/)[0]))) continue; if (x.ects) ects += x.ects; else noE++; }
  return { ects, noE, n: X.length, span: X.length ? dayDiff(X[0].e.start, X[X.length - 1].e.start) : 0, gaps, min: gaps.length ? Math.min(...gaps) : null };
}
function buildExamPdf(J, X, loc) {
  const doc = new J.jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const PW = 210, PH = 297, m = 14, X0 = m, X1 = PW - m, W = X1 - X0, S = examSummary(X);
  doc.setProperties({ title: "Exam calendar", creator: "TUM Schedule" });
  doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(17); doc.text("Exam calendar", X0, m + 6);
  const DL = d => dlabel(d, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(110);
  doc.text(pdfTxt(X.length ? `${DL(X[0].e.start)} – ${DL(X[X.length - 1].e.start)} · TUM Schedule` : "TUM Schedule"), X1, m + 6, { align: "right" });
  if (!X.length) { doc.setFontSize(10); doc.setTextColor(60); doc.text(doc.splitTextToSize(pdfTxt(EXAM_NONE), W), X0, m + 20); return doc; }
  // summary chips
  let cx = X0, cy = m + 12;
  for (const [k, v] of [["Exams", String(S.n)], ["Total span", `${S.span} days`], ["Fewest study days between exams", S.min == null ? "–" : String(Math.max(0, S.min - 1))], ...(S.ects ? [["ECTS at stake", ectsTxt(S.ects)]] : []), ...(CRED && !CRED.err && credOn ? [["ECTS earned", ectsTxt(CRED.sum)], ["After this exam period", ectsTxt(CRED.sum + S.ects)]] : [])]) {
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); const vw = doc.getTextWidth(v); doc.setFont("helvetica", "normal"); doc.setFontSize(7); const kw = doc.getTextWidth(k);
    const w = Math.max(vw, kw) + 8; doc.setFillColor(244, 245, 247); doc.roundedRect(cx, cy, w, 11, 1.5, 1.5, "F");
    doc.setTextColor(110); doc.text(k, cx + 4, cy + 4); doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(20); doc.text(v, cx + 4, cy + 9); cx += w + 3;
  }
  // proportional timeline strip
  const ty = cy + 26, t0 = startOfDay(X[0].e.start), t1 = addDays(startOfDay(X[X.length - 1].e.start), 1), tx = d => X0 + 4 + (W - 8) * (d - t0) / Math.max(864e5, t1 - t0);
  doc.setDrawColor(200); doc.setLineWidth(0.5); doc.line(X0 + 4, ty, X1 - 4, ty);
  doc.setFontSize(6); doc.setTextColor(150); doc.setFont("helvetica", "normal");
  const step = (t1 - t0) / 864e5 > 70 ? 14 : 7; for (let d = new Date(t0); d <= t1; d = addDays(d, step)) { const x = tx(d); doc.setDrawColor(210); doc.setLineWidth(0.2); doc.line(x, ty - 1, x, ty + 1); doc.text(`${d.getDate()}.${d.getMonth() + 1}.`, x, ty + 4, { align: "center" }); }
  let lastX = -99, lvl = 0;
  X.forEach(x => { const px = tx(startOfDay(x.e.start)) + (W - 8) / Math.max(1, (t1 - t0) / 864e5) / 2; doc.setFillColor(...hsl2rgb(x.h, 62, 50)); doc.setDrawColor(255); doc.setLineWidth(0.5); doc.circle(px, ty, 1.8, "FD");
    lvl = px - lastX < 24 ? (lvl + 1) % 4 : 0; lastX = px; const ly = [ty - 3.6, ty + 8.2, ty - 7, ty + 11.4][lvl]; doc.setFont("helvetica", "bold"); doc.setFontSize(6.2); doc.setTextColor(40);
    const lab = fitLine(doc, shortName(x.course), 26); doc.text(lab, px, ly, { align: "center" }); });
  // list
  const top = ty + 18, gapH = 6.5, n = X.length, rowH = Math.min(22, Math.max(11, (PH - m - (X.some(x => x.planned) ? 12 : 6) - top - (n - 1) * gapH) / n)), big = rowH >= 16;
  let y = top;
  X.forEach((x, i) => {
    if (i) { const g = dayDiff(X[i - 1].e.start, x.e.start), sd = studyDays(X[i - 1].e.start, x.e.start), tight = g <= 2;
      const txt = g === 0 ? "same day · 0 study days" : `${sd} study day${sd === 1 ? "" : "s"} in between · next exam ${g} day${g > 1 ? "s" : ""} later`;
      doc.setDrawColor(215); doc.setLineWidth(0.3); doc.setLineDashPattern([0.8, 0.8], 0); doc.line(X0 + 11, y + 0.5, X0 + 11, y + gapH - 0.5); doc.setLineDashPattern([], 0);
      doc.setFont("helvetica", "bold"); doc.setFontSize(7); const w = doc.getTextWidth(pdfTxt(txt)) + 5;
      doc.setFillColor(...(tight ? [253, 236, 236] : [241, 243, 245])); doc.roundedRect(X0 + 15, y + gapH / 2 - 2.2, w, 4.4, 2.2, 2.2, "F");
      doc.setTextColor(...(tight ? [200, 50, 55] : [90, 98, 110])); doc.text(pdfTxt(txt), X0 + 17.5, y + gapH / 2 + 0.9); y += gapH; }
    const c = hsl2rgb(x.h, 62, 50), d = x.e.start;
    if (x.planned) { doc.setFillColor(255); doc.setDrawColor(...c); doc.setLineWidth(0.35); doc.setLineDashPattern([1.2, 0.9], 0); doc.roundedRect(X0, y, W, rowH, 1.6, 1.6, "FD"); doc.setLineDashPattern([], 0); }
    else { doc.setFillColor(...hsl2rgb(x.h, 70, 96)); doc.roundedRect(X0, y, W, rowH, 1.6, 1.6, "F"); doc.setFillColor(...c); doc.rect(X0, y, 1.4, rowH, "F"); }
    doc.setFont("helvetica", "bold"); doc.setFontSize(big ? 15 : 12); doc.setTextColor(...c); doc.text(String(d.getDate()), X0 + 11, y + rowH / 2 + (big ? 0.5 : 0.8), { align: "center" });
    doc.setFontSize(6.5); doc.setTextColor(90); doc.text(pdfTxt(dlabel(d, { weekday: "short" }) + " " + dlabel(d, { month: "short" })), X0 + 11, y + rowH / 2 + (big ? 4.6 : 4), { align: "center" });
    const tx2 = X0 + 22, tw = W - 26; doc.setFont("helvetica", "bold"); doc.setFontSize(big ? 10.5 : 9); doc.setTextColor(17);
    const bw = x.planned ? 40 : 0, nm = wrapLines(doc, x.course, tw - 28 - bw, big ? 2 : 1); let yy = y + (big ? 6 : 4.6); nm.forEach(l => { doc.text(l, tx2, yy); yy += big ? 4.4 : 3.8; });
    if (x.planned) { doc.setFont("helvetica", "bold"); doc.setFontSize(5.6); const bt = pdfTxt(`PLANNED · NOT REGISTERED · ${x.code}`), w = Math.min(doc.getTextWidth(bt) + 3, bw + 18); doc.setFillColor(255, 243, 205); doc.roundedRect(X1 - 3 - 26 - w, y + (big ? 3.3 : 2.2), w, 3.6, 1.8, 1.8, "F"); doc.setTextColor(146, 96, 0); doc.text(fitLine(doc, bt, w - 3), X1 - 3 - 26 - w + 1.5, y + (big ? 5.9 : 4.8)); doc.setFont("helvetica", "bold"); doc.setFontSize(big ? 10.5 : 9); }
    doc.setFont("helvetica", "bold"); doc.setFontSize(big ? 9 : 8); doc.setTextColor(40); doc.text(pdfTxt(`${fmt(x.e.start)}–${fmt(x.e.end)}`), X1 - 3, y + (big ? 6 : 4.6), { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(110); doc.text(durTxt(x.min) + (x.ects ? ` · ${ectsTxt(x.ects)} ECTS` : ""), X1 - 3, y + (big ? 10.4 : 8.4), { align: "right" });
    doc.setFontSize(big ? 7.8 : 7); doc.setTextColor(85); doc.text(fitLine(doc, loc(x.e.location), tw - 18), tx2, Math.min(yy + 0.2, y + rowH - 2.2));
    y += rowH;
  });
  if (X.some(x => x.planned)) { doc.setFont("helvetica", "normal"); doc.setFontSize(6.3); doc.setTextColor(120); doc.text(doc.splitTextToSize(pdfTxt(planNote()), W), X0, PH - m + 2); }
  return doc;
}
function renderExams() {
  const box = $("exams"); if (!box) return; if (!PLAN) loadPlan(); const X = examList(), nP = X.filter(x => x.planned).length; box.hidden = false; box.innerHTML = "";
  box.appendChild(el("h3", "", `Exams <small class="muted">${X.length || ""}</small>`));
  if (!X.length) { box.appendChild(el("p", "muted", esc(EXAM_NONE))); return; }
  const S = examSummary(X); box.appendChild(el("p", "muted", `${S.n} exam${S.n > 1 ? "s" : ""}${nP ? ` (${S.n - nP} registered, ${nP} planned)` : ""} · span ${S.span} days${S.min != null ? ` · fewest study days between exams: ${Math.max(0, S.min - 1)}` : ""}${S.ects ? ` · <b>${ectsTxt(S.ects)} ECTS</b> at stake${S.noE ? ` (${S.noE} without ECTS data)` : ""}` : ""}`));
  const cr = el("div", "excred"); cr.innerHTML = `<label class="check"><input type="checkbox" id="credChk"${credOn ? " checked" : ""}> <span>Also show my credits <small class="muted">(needs “Noten” permission; read once, kept in memory only)</small></span></label>`;
  if (credOn) { const p = el("p", "credline", ""); if (credBusy || !CRED) p.textContent = "Loading credits…"; else if (CRED.err) { p.className = "credline err"; p.textContent = CRED.err; } else p.innerHTML = `<b>${ectsTxt(CRED.sum)} ECTS earned</b> · ${ectsTxt(CRED.sum)} + ${ectsTxt(S.ects)} = <b>${ectsTxt(CRED.sum + S.ects)} ECTS</b> after this exam period <small class="muted">(${CRED.n} passed module${CRED.n === 1 ? "" : "s"}${CRED.unk ? `, ${CRED.unk} without ECTS data counted as 0` : ""})</small>`; cr.appendChild(p); }
  box.appendChild(cr); cr.querySelector("#credChk").onchange = ev => { credOn = ev.target.checked; if (credOn && !CRED) loadCredits(); else { if (!credOn) CRED = null; renderExams(); } };
  const ol = el("ol", "exl");
  X.forEach((x, i) => {
    if (i) { const g = dayDiff(X[i - 1].e.start, x.e.start); ol.appendChild(el("li", "exgap" + (g <= 2 ? " tight" : ""), g ? `${g - 1} study day${g === 2 ? "" : "s"} · Δ ${g} day${g > 1 ? "s" : ""}` : "same day · 0 study days")); }
    const li = el("li", "exi" + (x.planned ? " plan" : ""), `<b class="exd">${esc(dShort(x.e.start))}</b><span class="exn">${esc(x.course)}${x.ects ? ` <i class="exects">${ectsTxt(x.ects)} ECTS</i>` : ""}${x.planned ? ` <i class="exbadge">planned · not registered</i> <small class="muted">${esc(x.code)}</small>` : ""}</span><span class="muted">${fmt(x.e.start)}–${fmt(x.e.end)} · ${durTxt(x.min)} · ${esc(x.e.location || "–")}</span>`);
    li.style.setProperty("--h", x.h); ol.appendChild(li);
  });
  box.appendChild(ol);
  if (nP) box.appendChild(el("p", "muted exsrc", esc(planNote())));
}
async function exportExams() {
  await loadPlan(); const X = examList(), btn = $("examPdf"); btn.disabled = true; btn.textContent = "Preparing…";
  const jp = loadJsPDF().catch(e => e);
  const rooms = new Map(await Promise.all([...new Set(X.filter(x => !x.planned).map(x => x.e.location))].map(async l => [l, await resolveRoom(l)])));
  const loc = l => { const r = rooms.get(l); return r ? [r.short, r.name, r.building].filter(Boolean).join(" · ") : (l || "–"); };
  try { const J = await jp; if (J instanceof Error) throw J; await deliverPdf(buildExamPdf(J, X, loc), "exam-calendar.pdf", "Exam calendar"); }
  catch (e) { showError("Exam PDF", e); }
  btn.disabled = false; btn.textContent = "Download exam calendar";
}
function pdfItems(M, loc) {
  const items = [];
  for (const d of M.noLect) items.push([d, dShort(d), "– no lectures"]);
  const byDay = new Map(); for (const m of M.missing) { const k = m.d.getTime(); (byDay.get(k) || byDay.set(k, []).get(k)).push(m); }
  for (const [k, ms] of byDay) { const d = new Date(k); items.push([d, dShort(d), ms.map(m => `${shortName(m.s.e.title)} ${evType(m.s.e.title).k} ${fmt(m.s.e.start)}${m.why ? " (cancelled)" : ""}`).join(", ") + ` – ${ms.length > 1 ? "do" : "does"} not take place`]); }
  for (const r of M.roomChanges) items.push([r.e.start, dShort(r.e.start), `${baseName(r.e.title)} ${fmt(r.e.start)} – room change: ${loc(r.e.location)}`]);
  for (const e of M.oneOffs) items.push([e.start, dShort(e.start), `${fmt(e.start)}–${fmt(e.end)} ${baseName(e.title)} ${evType(e.title).k} · ${loc(e.location)} (extra)`]);
  return items.sort((a, b) => a[0] - b[0]);
}
async function exportPdf() {
  const M = semesterModel(); if (!M) return showError("PDF", new Error("No events loaded."));
  const btn = $("print"); btn.disabled = true; btn.textContent = "Preparing…";
  const locs = new Set([...M.slots.map(s => s.room), ...M.oneOffs.map(e => e.location), ...M.roomChanges.map(r => r.e.location)]);
  const jp = loadJsPDF().catch(e => e);
  const rooms = new Map(await Promise.all([...locs].map(async l => [l, await resolveRoom(l)])));
  const loc = l => { const r = rooms.get(l); return r ? [r.short, r.building].filter(Boolean).join(" · ") : (l || "–"); };
  try { const J = await jp; if (J instanceof Error) throw J; await deliverPdf(buildPdf(J, M, loc, pdfItems(M, loc))); btn.disabled = false; btn.textContent = "Save semester PDF"; return; }
  catch (e) { console.warn("PDF file failed, using print fallback", e); }
  btn.disabled = false; btn.textContent = "Save semester PDF";
  const out = $("printout"); out.innerHTML = "";
  const pg = el("div", "ppage"), fit = el("div", "pfit"); pg.appendChild(fit);
  const D = o => dlabel(o, { day: "numeric", month: "short", year: "numeric" });
  fit.appendChild(el("div", "ph", `<h1>Semester timetable</h1><span>${esc(D(M.first))} – ${esc(D(M.last))} · typical week · TUM Schedule</span>`));
  const cols = [1, 2, 3, 4, 5]; if (M.slots.some(s => s.e.start.getDay() === 6)) cols.push(6); if (M.slots.some(s => s.e.start.getDay() === 0)) cols.push(0);
  let h0 = Math.min(...M.slots.map(s => s.e.start.getHours()), 10), h1 = Math.max(...M.slots.map(s => Math.ceil(hm(s.e.end) / 60)), 16);
  h0 = Math.max(MIN_H, h0); h1 = Math.min(MAX_H, h1);
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
      b.title = s.e.title; b.innerHTML = `${t.k ? `<i class="tb" data-t="${t.k}">${t.k}</i>` : ""}<b lang="de"><span class="fn">${esc(baseName(s.e.title))}</span><span class="sn">${esc(shortName(s.e.title))}</span></b><span>${esc(loc(s.room))}</span><small>${fmt(s.e.start)}–${fmt(s.e.end)} · ${cad} · ${s.from.getDate()}.${s.from.getMonth() + 1}.–${s.to.getDate()}.${s.to.getMonth() + 1}.</small>`;
      cb.appendChild(b);
    }
    col.appendChild(cb); grid.appendChild(col);
  }
  fit.appendChild(grid); fit.appendChild(legendFor(M.slots.map(s => s.e)));
  const items = [];
  for (const d of M.noLect) items.push([d, `<b>${dShort(d)}</b> – no lectures`]);
  const byDay = new Map(); for (const m of M.missing) { const k = m.d.getTime(); (byDay.get(k) || byDay.set(k, []).get(k)).push(m); }
  for (const [k, ms] of byDay) { const d = new Date(k); items.push([d, `<b>${dShort(d)}</b> ` + ms.map(m => `${esc(shortName(m.s.e.title))} ${evType(m.s.e.title).k} ${fmt(m.s.e.start)}${m.why ? " (cancelled)" : ""}`).join(", ") + ` – ${ms.length > 1 ? "do" : "does"} not take place`]); }
  for (const r of M.roomChanges) items.push([r.e.start, `<b>${dShort(r.e.start)}</b> ${esc(baseName(r.e.title))} ${fmt(r.e.start)} – room change: ${esc(loc(r.e.location))}`]);
  for (const e of M.oneOffs) items.push([e.start, `<b>${dShort(e.start)}</b> ${fmt(e.start)}–${fmt(e.end)} ${esc(baseName(e.title))} ${evType(e.title).k} · ${esc(loc(e.location))} <i>(extra)</i>`]);
  items.sort((a, b) => a[0] - b[0]);
  if (items.length) { const ex = el("div", "pex", `<h3>Exceptions &amp; extra dates</h3>`); const ul = el("ul"); for (const [, h] of items) ul.appendChild(el("li", "", h)); ex.appendChild(ul); fit.appendChild(ex); }
  out.appendChild(pg);
  // scale to guarantee a single page (A4 landscape minus 10mm margins ≈ 1046×718 CSS px)
  setTimeout(() => window.print(), 50);
}

function logout() { clearInterval(pollTimer); store.clear(); CRED = null; credOn = false; $("remember").checked = false; events = []; cancelled = []; localStorage.removeItem("tumSchedZoom"); localStorage.removeItem("tumSchedTrim"); roomCache.clear(); $("tumid").value = $("tokenIn").value = ""; $("msg").textContent = ""; $("msg2").textContent = "Waiting for activation – checking every 5 s…"; $("printout").innerHTML = ""; show("login"); }
function shift(n) { day = addDays(day, n * (mode === "week" ? 7 : 1)); render(n); }

$("req").onclick = requestToken;
$("tumid").onkeydown = e => { if (e.key === "Enter") requestToken(); };
$("useTok").onclick = () => { const t = $("tokenIn").value.trim(); if (!t) return; store.set(t); startActivation(t); };
$("ics").onchange = async e => { const f = e.target.files[0]; if (!f) return; const all = parseICS(await f.text()); cancelled = all.filter(isCancelled); events = all.filter(e => !isCancelled(e)); show("cal"); render(); };
$("logout").onclick = logout;
$("prev").onclick = () => shift(-1); $("next").onclick = () => shift(1);
$("today").onclick = () => { day = startOfDay(new Date()); render(); };
$("vDay").onclick = () => setMode("day"); $("vWeek").onclick = () => setMode("week");
$("print").onclick = exportPdf; $("examPdf").onclick = exportExams;
$("theme").onclick = () => { const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; r.dataset.theme = dark ? "light" : "dark"; };
document.addEventListener("keydown", e => { if ($("cal").hidden || e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return; if (e.key === "ArrowLeft") shift(-1); if (e.key === "ArrowRight") shift(1); if (e.key === "t") $("today").click(); });
let tx = null, ty = null;
$("zIn").onclick = () => applyZoom(zoom * 1.4); $("zOut").onclick = () => applyZoom(zoom / 1.4); $("zFit").onclick = () => applyZoom(1);
$("trim").checked = trim; $("trim").onchange = () => { trim = $("trim").checked; if (localStorage.getItem("tumSchedTok")) localStorage.setItem("tumSchedTrim", trim ? "1" : "0"); render(); };
$("view").addEventListener("wheel", e => { if (!e.ctrlKey || !e.target.closest(".tl")) return; e.preventDefault(); applyZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX); }, { passive: false });
let pinch = null;
const pop = el("div", "pop"); pop.hidden = true; document.body.appendChild(pop);
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest(".ev");
  if (!a || !matchMedia("(hover: none)").matches) { if (!e.target.closest?.(".pop")) pop.hidden = true; return; }
  if (pop.dataset.for === a.title && !pop.hidden) return; // second tap opens the map
  e.preventDefault(); pop.dataset.for = a.title; const [l1, ...rest] = a.title.split("\n");
  pop.innerHTML = `<b>${esc(l1)}</b><div>${esc(rest.join(" "))}</div>` + (a.href ? `<a href="${esc(a.href)}" target="_blank" rel="noopener">Open map →</a>` : "");
  const r = a.getBoundingClientRect(); pop.hidden = false; pop.style.left = Math.max(8, Math.min(innerWidth - 268, r.left)) + "px"; pop.style.top = (r.bottom + 6 + scrollY) + "px";
}, true);
$("view").addEventListener("touchstart", e => { if (e.touches.length === 2 && e.target.closest(".tl")) { const [a, b] = e.touches; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: zoom }; tx = null; } }, { passive: true });
$("view").addEventListener("touchmove", e => { if (!pinch || e.touches.length !== 2) return; e.preventDefault(); const [a, b] = e.touches; applyZoom(pinch.z * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d, (a.clientX + b.clientX) / 2); }, { passive: false });
$("view").addEventListener("touchend", e => { if (e.touches.length < 2) pinch = null; }, { passive: true });
$("view").addEventListener("touchstart", e => { if (e.touches.length > 1) return; tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
$("view").addEventListener("touchend", e => { if (tx == null) return; const dx = e.changedTouches[0].clientX - tx, dy = e.changedTouches[0].clientY - ty; const tl = e.target.closest(".tl"); const atEdge = !tl || tl.scrollLeft <= 0 || tl.scrollLeft + tl.clientWidth >= tl.scrollWidth - 1;
  if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && atEdge) shift(dx > 0 ? -1 : 1); tx = null; });
setInterval(() => { const n = new Date(); document.querySelectorAll(".now").forEach(x => { x.style.left = pct(n) + "%"; if (x.dataset.t) x.dataset.t = fmt(n); }); }, 60000);
const saved = store.get(); if (localStorage.getItem("tumSchedTok")) $("remember").checked = true; if (saved) startActivation(saved); else show("login");
$("remember").onchange = () => { const t = sessionStorage.getItem("tok"); if ($("remember").checked) { if (t) localStorage.setItem("tumSchedTok", t); } else localStorage.removeItem("tumSchedTok"); };
