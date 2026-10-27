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
  const v = $("view"); if (events.length) loadJsPDF().catch(() => {});
  const draw = () => { v.innerHTML = ""; try { mode === "day" ? renderDay(v) : renderWeek(v); applyZoom(zoom); } catch (e) { showError("Render", e); } v.classList.remove("fade"); };
  if (!dx) return draw();
  v.style.setProperty("--dx", (dx > 0 ? -24 : 24) + "px"); v.classList.add("fade"); setTimeout(draw, 140);
}
function setMode(m) { mode = m; $("vDay").classList.toggle("on", m === "day"); $("vWeek").classList.toggle("on", m === "week"); render(); }

// --- Semester PDF: ONE A4 landscape page with a typical week + exceptions ---
function isCancelled(e) { return /cancel|storn|abgesagt|entf(ä|ae)llt|f(ä|ae)llt aus/i.test((e.status || "").trim()) || /\b(abgesagt|entfällt|storniert|cancell?ed)\b/i.test(e.title || ""); }
const APPV = 15;
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
  const gTop = m + 9, legH = 7, minGrid = 112;
  const exA = items.length ? Math.min(PH - m - gTop - minGrid - legH, 8 + Math.max(...items.map(g => g.rows.reduce((h, r) => h + r.entries.length * 3 + 1.1, 0)))) : 0;
  const gBot = PH - m - (exA ? exA + 1 : 0) - legH;
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
  if (exA) drawEx(doc, items, X0, gBot + legH + 1, X1 - X0, exA);
  return doc;
}
async function deliverPdf(doc) {
  const name = "semester-timetable.pdf", blob = doc.output("blob");
  const file = typeof File === "function" ? new File([blob], name, { type: "application/pdf" }) : null;
  const touch = matchMedia("(pointer:coarse)").matches;
  if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Semester timetable" }); return; } catch (e) { if (e && e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  window.__lastPdf = blob;
}
// --- Exceptions model shared by PDF + print fallback: categories with rows {date, entries:[{h, main, sub}]} ---
const EXCAT = { off: ["No lectures", "#64748b"], can: ["Cancelled", "#e5484d"], room: ["Room changes", "#d97706"], extra: ["Extra dates", "#059669"] };
function exGroups(M, loc) {
  const dk = d => startOfDay(d).getTime(), byDate = (arr, f) => { const m = new Map(); for (const x of arr) { const d = f(x), k = dk(d); (m.get(k) || m.set(k, { d: startOfDay(d), list: [] }).get(k)).list.push(x); } return [...m.values()].sort((a, b) => a.d - b.d); };
  const T = e => { const k = evType(e.title).k; return shortName(e.title) + (k ? " " + k : ""); };
  // merge consecutive no-lecture days (gaps of days without any events are bridged)
  // breaks: runs of weekdays where >=50% of the expected slots are missing become "no lectures" ranges
  const exp = d => M.slots.filter(s => s.e.start.getDay() === d.getDay() && d >= startOfDay(s.from) && d <= s.to).length;
  const missOn = new Map(); for (const m of M.missing) missOn.set(dk(m.d), (missOn.get(dk(m.d)) || 0) + 1);
  const heavy = [...missOn].filter(([k, n]) => n >= Math.max(1, exp(new Date(k)) * 0.5)).map(([k]) => new Date(k)).sort((a, b) => a - b);
  const runs = []; for (const d of heavy) { const r = runs[runs.length - 1]; if (r && (d - r[r.length - 1]) / 864e5 <= 4) r.push(d); else runs.push([d]); }
  const brk = new Set(); for (const r of runs) if (r.length >= 3) for (const d of r) brk.add(d.getTime());
  const missing = M.missing.filter(m => !brk.has(dk(m.d)));
  const off = [], nl = [...M.noLect, ...[...brk].map(t => new Date(t))].sort((a, b) => a - b).filter((d, i, a) => !i || !sameDay(d, a[i - 1]));
  for (const d of nl) { const r = off[off.length - 1]; let ok = false; if (r) { ok = true; for (let x = addDays(r.to, 1); x < d; x = addDays(x, 1)) if (eventsOn(x).length) { ok = false; break; } if ((d - r.to) / 864e5 > 6) ok = false; } if (ok) r.to = d; else off.push({ from: d, to: d }); }
  const rng = r => sameDay(r.from, r.to) ? dShort(r.from) : `${dShort(r.from)}–${dShort(r.to)}`;
  const xmas = r => { for (let x = r.from; x <= r.to; x = addDays(x, 1)) if (x.getMonth() === 11 && x.getDate() >= 24 && x.getDate() <= 26) return true; return false; };
  const G = [];
  if (off.length) G.push({ k: "off", rows: off.map(r => ({ date: rng(r), entries: [{ main: xmas(r) ? "Christmas break" : sameDay(r.from, r.to) ? "No lectures" : "Lecture-free", sub: sameDay(r.from, r.to) ? "" : `${Math.round((r.to - r.from) / 864e5) + 1} days` }] })) });
  if (missing.length) G.push({ k: "can", rows: byDate(missing, m => m.d).map(g => ({ date: dShort(g.d), entries: g.list.sort((a, b) => hm(a.s.e.start) - hm(b.s.e.start)).map(m => ({ h: hue(m.s.e.title), main: T(m.s.e), sub: fmt(m.s.e.start) + (m.why ? " · cancelled" : "") })) })) });
  if (M.roomChanges.length) G.push({ k: "room", rows: byDate(M.roomChanges, r => r.e.start).map(g => ({ date: dShort(g.d), entries: g.list.map(r => ({ h: hue(r.e.title), main: `${T(r.e)} ${fmt(r.e.start)}`, sub: `${loc(r.room)} → ${loc(r.e.location)}` })) })) });
  if (M.oneOffs.length) G.push({ k: "extra", rows: byDate(M.oneOffs, e => e.start).map(g => ({ date: dShort(g.d), entries: g.list.map(e => ({ h: hue(e.title), main: T(e), sub: `${fmt(e.start)}–${fmt(e.end)} · ${loc(e.location)}` })) })) });
  return G;
}
function planEx(doc, G, A, W) { // pick font size + split each category into sub-columns so all fits in A mm height
  for (const fs of [6.8, 6.4, 6, 5.6, 5.2, 4.8, 4.4, 4]) {
    const lh = fs * 0.44, gap = 1.1, head = 6.5, cols = [];
    for (const g of G) { let cur = { g, rows: [], h: 0, first: true }; cols.push(cur); for (const r of g.rows) { const rh = r.entries.length * lh + gap; if (cur.rows.length && cur.h + rh > A - head) { cur = { g, rows: [], h: 0 }; cols.push(cur); } cur.rows.push(r); cur.h += rh; } }
    if (cols.length * 40 <= W && cols.every(c => c.h <= A - head)) return { fs, lh, gap, head, cols };
  }
  return null;
}
function drawEx(doc, G, x0, y0, W, A) {
  let P = planEx(doc, G, A, W);
  if (!P) { const fs = 4, lh = fs * 0.44, gap = 0.8, head = 6.5, cols = [], per = Math.max(1, Math.floor(W / 46)); for (const g of G) cols.push({ g, rows: g.rows, h: 0, first: true }); P = { fs, lh, gap, head, cols: cols.slice(0, per) }; }
  const wt = c => c.g.k === "room" || c.g.k === "extra" ? 1.6 : 1, tw = P.cols.reduce((a, c) => a + wt(c), 0), dw = P.fs * 2.55; let cx = x0;
  P.cols.forEach((c, i) => {
    const cw = Math.min(c.g.k === "off" ? 60 : 95, W * wt(c) / tw), x = cx, [title, col] = EXCAT[c.g.k]; cx += cw;
    if (c.first) { doc.setFillColor(...hex2rgb(col)); doc.roundedRect(x, y0 + 0.6, 2.4, 2.4, 0.5, 0.5, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(7.2); doc.setTextColor(25); doc.text(title, x + 3.6, y0 + 2.7);
      const n = c.g.rows.reduce((s, r) => s + r.entries.length, 0); doc.setFont("helvetica", "normal"); doc.setTextColor(140); doc.text(String(n), x + 4.6 + doc.getTextWidth(title) + 0.4, y0 + 2.7); }
    doc.setDrawColor(...hex2rgb(col)); doc.setLineWidth(0.25); doc.line(x, y0 + 4.2, x + cw - 4, y0 + 4.2);
    let y = y0 + P.head;
    c.rows.forEach((r, ri) => {
      if (ri) { doc.setDrawColor(232); doc.setLineWidth(0.1); doc.line(x, y - P.gap / 2 - P.lh * 0.25, x + cw - 4, y - P.gap / 2 - P.lh * 0.25); }
      doc.setFontSize(P.fs); doc.setFont("helvetica", "bold"); doc.setTextColor(35); doc.text(fitLine(doc, r.date, c.g.k === "off" ? cw : dw - 0.8), x, y + P.lh * 0.75);
      const ex = c.g.k === "off" ? x + doc.getTextWidth(pdfTxt(r.date)) + 2 : x + dw;
      r.entries.forEach((e, ei) => {
        const yy = y + ei * P.lh + P.lh * 0.75; let tx = ex;
        if (e.h != null) { doc.setFillColor(...hsl2rgb(e.h, 62, 50)); doc.circle(tx + 0.7, yy - P.fs * 0.12, P.fs * 0.11, "F"); tx += 2.2; }
        doc.setFont("helvetica", "normal"); doc.setTextColor(25); const avail = x + cw - 4 - tx; const mt = fitLine(doc, e.main, avail); doc.text(mt, tx, yy);
        if (e.sub) { const mw = doc.getTextWidth(mt + "  "); doc.setTextColor(125); const st = fitLine(doc, e.sub.replace("→", "»"), avail - mw); if (avail - mw > 4) doc.text(st, tx + mw, yy); }
      });
      y += r.entries.length * P.lh + P.gap;
    });
  });
}
function exHtml(G) {
  const box = el("div", "pex");
  for (const g of G) { const [title, col] = EXCAT[g.k], s = el("section", "pxg"); s.dataset.k = g.k; s.style.setProperty("--xc", col);
    s.appendChild(el("h4", "", `<i></i>${esc(title)}<small>${g.rows.reduce((n, r) => n + r.entries.length, 0)}</small>`));
    for (const r of g.rows) { const row = el("div", "pxr" + (g.k === "off" ? " off" : ""), `<b>${esc(r.date)}</b>`); const ul = el("span", "pxe");
      for (const e of r.entries) { const it = el("span", "", `${e.h != null ? "<i></i>" : ""}${esc(e.main)}${e.sub ? ` <small>${esc(e.sub)}</small>` : ""}`); if (e.h != null) it.style.setProperty("--h", e.h); ul.appendChild(it); }
      row.appendChild(ul); s.appendChild(row); }
    box.appendChild(s); }
  return box;
}
async function exportPdf() {
  const M = semesterModel(); if (!M) return showError("PDF", new Error("No events loaded."));
  const btn = $("print"); btn.disabled = true; btn.textContent = "Preparing…";
  const locs = new Set([...M.slots.map(s => s.room), ...M.oneOffs.map(e => e.location), ...M.roomChanges.map(r => r.e.location)]);
  const jp = loadJsPDF().catch(e => e);
  const rooms = new Map(await Promise.all([...locs].map(async l => [l, await resolveRoom(l)])));
  const loc = l => { const r = rooms.get(l); return r ? [r.short, r.building].filter(Boolean).join(" · ") : (l || "–"); };
  try { const J = await jp; if (J instanceof Error) throw J; await deliverPdf(buildPdf(J, M, loc, exGroups(M, loc))); btn.disabled = false; btn.textContent = "Save semester PDF"; return; }
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
  const G = exGroups(M, loc); if (G.length) { fit.appendChild(el("h3", "pexh", "Exceptions &amp; extra dates")); fit.appendChild(exHtml(G)); }
  out.appendChild(pg);
  // scale to guarantee a single page (A4 landscape minus 10mm margins ≈ 1046×718 CSS px)
  setTimeout(() => window.print(), 50);
}

function logout() { clearInterval(pollTimer); store.clear(); $("remember").checked = false; events = []; cancelled = []; localStorage.removeItem("tumSchedZoom"); localStorage.removeItem("tumSchedTrim"); roomCache.clear(); $("tumid").value = $("tokenIn").value = ""; $("msg").textContent = ""; $("msg2").textContent = "Waiting for activation – checking every 5 s…"; $("printout").innerHTML = ""; show("login"); }
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
