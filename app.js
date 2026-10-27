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
  show("cal"); $("timeline").innerHTML = "<p class='muted pad'>Loading…</p>";
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
    else $("timeline").innerHTML = "<p class='msg pad'>Error: " + esc(e.message) + "</p>";
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

// --- Rendering ---
function fmt(d) { return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
function render() {
  $("dayLabel").textContent = day.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  const next = new Date(day); next.setDate(day.getDate() + 1);
  const todays = events.filter(e => e.start < next && e.end > day).sort((a, b) => a.start - b.start);
  // lanes for overlaps
  const lanes = []; for (const e of todays) { let i = lanes.findIndex(end => end <= e.start); if (i < 0) { i = lanes.length; lanes.push(0); } lanes[i] = e.end; e.lane = i; }
  const n = Math.max(1, lanes.length), laneH = 96, H = 24 + n * (laneH + 8);
  const pct = d => ((d.getHours() + d.getMinutes() / 60 - START_H) / (END_H - START_H)) * 100;
  const tl = $("timeline"); tl.innerHTML = ""; const track = document.createElement("div"); track.className = "track"; track.style.height = H + "px"; tl.appendChild(track);
  for (let h = START_H; h <= END_H; h++) { const d = document.createElement("div"); d.className = "hour"; d.style.left = ((h - START_H) / (END_H - START_H) * 100) + "%"; d.textContent = h + ":00"; track.appendChild(d); }
  const now = new Date(); if (now >= day && now < next) { const nm = document.createElement("div"); nm.className = "now"; nm.style.left = Math.min(100, Math.max(0, pct(now))) + "%"; track.appendChild(nm); }
  const list = $("list"); list.innerHTML = "";
  if (!todays.length) list.innerHTML = "<li class='muted'>No events on this day.</li>";
  for (const e of todays) {
    const a = document.createElement("a"); a.className = "ev"; a.target = "_blank"; a.rel = "noopener";
    const l = Math.max(0, pct(e.start)), r = Math.min(100, pct(e.end));
    a.style.left = l + "%"; a.style.width = `calc(${Math.max(r - l, 2)}% - 4px)`; a.style.top = (24 + e.lane * (laneH + 8)) + "px"; a.style.height = laneH + "px";
    a.innerHTML = `<span class="room">${esc(e.location ? e.location.split(",")[0] : "–")}</span><span class="t">${fmt(e.start)}–${fmt(e.end)}</span><br>${esc(e.title)}`;
    a.title = `${e.title}\n${e.location || ""}`;
    track.appendChild(a);
    const li = document.createElement("li");
    li.innerHTML = `<div class="room">${esc(e.location ? e.location.split(",")[0] : "–")}</div><div>${fmt(e.start)}–${fmt(e.end)} · ${esc(e.title)}</div><div class="muted">${esc(e.location)}</div>`;
    list.appendChild(li);
    resolveRoom(e.location).then(rm => {
      if (!rm) return; a.href = rm.map;
      a.querySelector(".room").textContent = rm.short;
      li.querySelector(".room").innerHTML = `<a href="${esc(rm.map)}" target="_blank" rel="noopener">${esc(rm.short)}</a>`;
      li.querySelector(".muted").textContent = [rm.name, rm.building, rm.campus].filter(Boolean).join(" · ");
    });
  }
}

function logout() { clearInterval(pollTimer); sessionStorage.clear(); events = []; roomCache.clear(); $("tumid").value = $("tokenIn").value = ""; $("msg").textContent = $("msg2").textContent = ""; show("login"); }
function shift(n) { day = new Date(day); day.setDate(day.getDate() + n); render(); }

$("req").onclick = requestToken;
$("tumid").onkeydown = e => { if (e.key === "Enter") requestToken(); };
$("useTok").onclick = () => { const t = $("tokenIn").value.trim(); if (!t) return; sessionStorage.setItem("tok", t); startActivation(t); };
$("ics").onchange = async e => { const f = e.target.files[0]; if (!f) return; events = parseICS(await f.text()); show("cal"); render(); };
$("logout").onclick = logout;
$("prev").onclick = () => shift(-1); $("next").onclick = () => shift(1);
$("today").onclick = () => { day = startOfDay(new Date()); render(); };
document.addEventListener("keydown", e => { if ($("cal").hidden || e.target.tagName === "INPUT") return; if (e.key === "ArrowLeft") shift(-1); if (e.key === "ArrowRight") shift(1); });
let tx = null; $("timeline").addEventListener("touchstart", e => tx = e.touches[0].clientX, { passive: true });
$("timeline").addEventListener("touchend", e => { if (tx == null) return; const dx = e.changedTouches[0].clientX - tx; if (Math.abs(dx) > 80 && $("timeline").scrollLeft === 0) shift(dx > 0 ? -1 : 1); tx = null; });
const saved = sessionStorage.getItem("tok"); if (saved) startActivation(saved); else show("login");
