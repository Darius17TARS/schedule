"use strict";
// Privacy: token lives in sessionStorage only (cleared when the tab closes). Nothing is sent anywhere except TUMonline and NavigaTUM.
const BASE = "https://campus.tum.de/tumonline/wbservicesbasic.";
const NAV = "https://nav.tum.de/api/";
const $ = (id) => document.getElementById(id);
const START_H = 7, END_H = 21;
let events = [], day = startOfDay(new Date()), pollTimer = null;
const roomCache = new Map();

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
    sessionStorage.setItem("tok", tok);
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

function parseTumDate(s) { // "2026-10-27 10:15:00" (Europe/Berlin local)
  const m = String(s).trim().match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
}

async function loadCalendar(tok) {
  show("cal"); $("view").innerHTML = "<p class='muted pad'>Loading…</p>";
  try {
    const doc = await api("kalender", { pToken: tok, pMonateVor: 1, pMonateNach: 4 });
    const txt = (el, n) => el.querySelector(n)?.textContent?.trim() || "";
    events = [...doc.getElementsByTagName("event")].map(el => ({
      title: txt(el, "title"), start: parseTumDate(txt(el, "dtstart")), end: parseTumDate(txt(el, "dtend")),
      location: txt(el, "location"), status: txt(el, "status"), url: txt(el, "url")
    })).filter(e => e.start && e.end && e.status !== "CANCEL");
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
    else if (l === "END:VEVENT") { if (cur.start && cur.end && !/CANCEL/i.test(cur.status || "")) out.push(cur); cur = null; }
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
function color(title) { // stable colour per course
  const key = (title || "").replace(/\s*\((VO|UE|VI|SE|PR|TT|ZÜ|Übung|Vorlesung)[^)]*\)\s*/gi, "").trim().toLowerCase();
  let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 62% 48%)`;
}
function eventsOn(d) { const n = addDays(d, 1); return events.filter(e => e.start < n && e.end > d).sort((a, b) => a.start - b.start); }
function roomText(e) { return e.location ? e.location.split(",")[0].trim() : "–"; }
const pct = d => Math.min(100, Math.max(0, ((d.getHours() + d.getMinutes() / 60 - START_H) / (END_H - START_H)) * 100));
function lanesFor(list) { const lanes = []; for (const e of list) { let i = lanes.findIndex(end => end <= e.start); if (i < 0) { i = lanes.length; lanes.push(0); } lanes[i] = e.end; e.lane = i; } return Math.max(1, lanes.length); }
function el(tag, cls, html) { const x = document.createElement(tag); if (cls) x.className = cls; if (html != null) x.innerHTML = html; return x; }

function buildTrack(list, d, compact) {
  const n = lanesFor(list), laneH = compact ? 54 : 112, top = compact ? 6 : 26;
  const track = el("div", "track"); track.style.height = (top + n * (laneH + 6) + 4) + "px";
  if (!compact) for (let h = START_H; h <= END_H; h++) { const x = el("div", "hour", h + ":00"); x.style.left = ((h - START_H) / (END_H - START_H) * 100) + "%"; track.appendChild(x); }
  else for (let h = START_H; h <= END_H; h += 2) { const x = el("div", "hour", ""); x.style.left = ((h - START_H) / (END_H - START_H) * 100) + "%"; track.appendChild(x); }
  const now = new Date();
  if (sameDay(now, d)) { const nm = el("div", "now"); nm.style.left = pct(now) + "%"; if (!compact) nm.dataset.t = fmt(now); track.appendChild(nm); }
  for (const e of list) {
    const a = el("a", "ev" + (e.end < now ? " past" : "")); a.target = "_blank"; a.rel = "noopener"; a.style.setProperty("--c", color(e.title));
    const l = pct(e.start), r = pct(e.end);
    a.style.left = `calc(${l}% + 2px)`; a.style.width = `calc(${Math.max(r - l, 1.5)}% - 4px)`; a.style.top = (top + e.lane * (laneH + 6)) + "px"; a.style.height = laneH + "px";
    a.innerHTML = `<span class="room">${esc(roomText(e))}</span>` + (compact ? "" : `<span class="t">${fmt(e.start)}–${fmt(e.end)}</span><span class="n">${esc(e.title)}</span><span class="b"></span>`);
    a.title = `${fmt(e.start)}–${fmt(e.end)}  ${e.title}\n${e.location || ""}`;
    track.appendChild(a);
    resolveRoom(e.location).then(rm => { if (!rm) return; a.href = rm.map; a.querySelector(".room").textContent = rm.short; const b = a.querySelector(".b"); if (b) b.textContent = [rm.building, rm.campus].filter(Boolean).join(" · "); });
  }
  return track;
}

function renderDay(v) {
  const list = eventsOn(day), today = sameDay(day, new Date());
  $("dayLabel").innerHTML = esc(dlabel(day)) + (today ? '<span class="badge">TODAY</span>' : "") + `<small>${list.length} event${list.length === 1 ? "" : "s"}</small>`;
  if (!list.length) { v.appendChild(el("div", "empty", "No classes on this day 🎉")); return; }
  const tl = el("div", "tl"); tl.appendChild(buildTrack(list, day, false)); v.appendChild(tl);
  requestAnimationFrame(() => { const first = today ? new Date() : list[0].start; tl.scrollLeft = Math.max(0, (pct(first) / 100) * tl.scrollWidth - 80); });
  const cards = el("div", "cards"); const now = new Date();
  for (const e of list) {
    const c = el("div", "card" + (e.start <= now && e.end > now ? " live" : "")); c.style.setProperty("--c", color(e.title));
    c.innerHTML = `<div class="row1"><span class="room">${esc(roomText(e))}</span><span class="t">${fmt(e.start)}–${fmt(e.end)}</span></div><div class="n">${esc(e.title)}</div><div class="b">${esc(e.location || "")}</div>`;
    cards.appendChild(c);
    resolveRoom(e.location).then(rm => { if (!rm) return; c.querySelector(".room").textContent = rm.short; c.querySelector(".b").textContent = [rm.name, rm.building, rm.campus].filter(Boolean).join(" · ");
      const m = el("a", "map", "Open map →"); m.href = rm.map; m.target = "_blank"; m.rel = "noopener"; c.appendChild(m); });
  }
  v.appendChild(cards);
}

function renderWeek(v) {
  const m = monday(day), sun = addDays(m, 6);
  $("dayLabel").innerHTML = `Week of ${esc(dlabel(m, { day: "numeric", month: "short" }))} – ${esc(dlabel(sun, { day: "numeric", month: "short", year: "numeric" }))}`;
  const box = el("div", "tl week");
  for (let i = 0; i < 7; i++) {
    const d = addDays(m, i), list = eventsOn(d);
    if (i >= 5 && !list.length) continue;
    const row = el("div", "wrow" + (sameDay(d, new Date()) ? " today" : ""));
    const lab = el("div", "wd", `${DOW[i]}<small>${d.getDate()}.${d.getMonth() + 1}.</small>`); lab.onclick = () => { day = d; setMode("day"); };
    const wrap = el("div", ""); wrap.style.overflowX = "auto"; wrap.appendChild(buildTrack(list, d, true));
    row.append(lab, wrap); box.appendChild(row);
  }
  v.appendChild(box);
}

function render(dx = 0) {
  const v = $("view");
  const draw = () => { v.innerHTML = ""; mode === "day" ? renderDay(v) : renderWeek(v); v.classList.remove("fade"); };
  if (!dx) return draw();
  v.style.setProperty("--dx", (dx > 0 ? -24 : 24) + "px"); v.classList.add("fade"); setTimeout(draw, 140);
}
function setMode(m) { mode = m; $("vDay").classList.toggle("on", m === "day"); $("vWeek").classList.toggle("on", m === "week"); render(); }

// --- PDF export (print CSS + window.print) ---
async function exportPdf() {
  const r = $("range").value; let from, to;
  if (r === "day") { from = startOfDay(day); to = addDays(from, 1); }
  else if (r === "week") { from = monday(day); to = addDays(from, 7); }
  else { from = monday(day); to = addDays(from, 7 * +r); }
  const days = []; for (let d = from; d < to; d = addDays(d, 1)) { const l = eventsOn(d); if (l.length) days.push([d, l]); }
  const all = days.flatMap(x => x[1]);
  const btn = $("print"); btn.disabled = true; btn.textContent = "Preparing…";
  const rooms = await Promise.all(all.map(e => resolveRoom(e.location)));
  const rm = new Map(all.map((e, i) => [e, rooms[i]]));
  btn.disabled = false; btn.textContent = "Save as PDF";
  const out = $("printout"); out.innerHTML = "";
  const rangeTxt = `${dlabel(from, { day: "numeric", month: "short", year: "numeric" })} – ${dlabel(addDays(to, -1), { day: "numeric", month: "short", year: "numeric" })}`;
  let wk = null, wkKey = "";
  for (const [d, l] of days) {
    const k = monday(d).toDateString();
    if (k !== wkKey) { wkKey = k; wk = el("div", "pweek"); wk.appendChild(el("div", "ph", `<h1>TUM Schedule · week of ${esc(dlabel(monday(d), { day: "numeric", month: "long", year: "numeric" }))}</h1><span>${esc(rangeTxt)}</span>`)); out.appendChild(wk); }
    const sec = el("div", "pday", `<h2>${esc(dlabel(d, { weekday: "long", day: "numeric", month: "long" }))}</h2>`);
    const t = el("table", "", "<thead><tr><th>Time</th><th>Room</th><th>Course</th><th>Building · Campus</th></tr></thead>"); const tb = el("tbody");
    for (const e of l) { const x = rm.get(e); const tr = el("tr", "", `<td class="tm">${fmt(e.start)}–${fmt(e.end)}</td><td class="rm">${esc(x ? x.short : roomText(e))}</td><td class="co">${esc(e.title)}</td><td class="bd">${esc(x ? [x.building, x.campus].filter(Boolean).join(" · ") : (e.location || ""))}</td>`);
      tr.querySelector(".co").style.setProperty("--c", color(e.title)); tb.appendChild(tr); }
    t.appendChild(tb); sec.appendChild(t); wk.appendChild(sec);
  }
  if (!days.length) out.appendChild(el("div", "ph", `<h1>TUM Schedule</h1><span>No events ${esc(rangeTxt)}</span>`));
  window.print();
}

function logout() { clearInterval(pollTimer); sessionStorage.clear(); events = []; roomCache.clear(); $("tumid").value = $("tokenIn").value = ""; $("msg").textContent = ""; $("msg2").textContent = "Waiting for activation – checking every 5 s…"; $("printout").innerHTML = ""; show("login"); }
function shift(n) { day = addDays(day, n * (mode === "week" ? 7 : 1)); render(n); }

$("req").onclick = requestToken;
$("tumid").onkeydown = e => { if (e.key === "Enter") requestToken(); };
$("useTok").onclick = () => { const t = $("tokenIn").value.trim(); if (!t) return; sessionStorage.setItem("tok", t); startActivation(t); };
$("ics").onchange = async e => { const f = e.target.files[0]; if (!f) return; events = parseICS(await f.text()); show("cal"); render(); };
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
const saved = sessionStorage.getItem("tok"); if (saved) startActivation(saved); else show("login");
