// --- Grade planner (v25): what-if GPA for upcoming exams. Grades are read once with the optional "Noten"
// permission and kept in memory only. Only your planner choices (what-if grades, toggles, ECTS fixes) are saved,
// in this browser's localStorage; they are cleared on "Log out". Nothing is sent anywhere except to TUMonline.
"use strict";
const GPA = {
  STEPS: [1.0, 1.3, 1.7, 2.0, 2.3, 2.7, 3.0, 3.3, 3.7, 4.0, 5.0],
  // "1,3" -> 1.3 ; "n.b." / "B" / "bestanden" -> null (ungraded) ; returns { g, passed, graded }
  parse(raw) {
    const s = String(raw || "").trim(), n = parseFloat(s.replace(",", "."));
    if (!isNaN(n) && /^\d/.test(s)) return { g: n, graded: true, passed: n >= 1 && n <= 4.0 };
    if (/^(n\.?\s?b\.?|nb|nicht bestanden|not passed|failed|fail|x|nicht erschienen|ne|ab|abgebrochen|tä|täuschung)$/i.test(s) || /nicht bestanden|not passed|failed/i.test(s)) return { g: null, graded: false, passed: false };
    if (/^(b|be|bestanden|passed|p|mit erfolg|teilgenommen|tg)$/i.test(s) || /mit erfolg|bestanden/i.test(s)) return { g: null, graded: false, passed: true };
    return { g: null, graded: false, passed: false };
  },
  // TUM APSO §17(1): one decimal is kept, further decimals are cut off without rounding.
  trunc: x => x == null || isNaN(x) ? null : Math.floor(x * 10 + 1e-9) / 10,
  // items: [{ g, ects }] -> { avg, ects } ; only passed grades 1.0–4.0 with ECTS > 0 count (fails never count)
  avg(items) {
    let s = 0, e = 0; for (const it of items) { if (it.g == null || !(it.g >= 1 && it.g <= 4.0) || !(it.ects > 0)) continue; s += it.g * it.ects; e += it.ects; }
    return { avg: e ? s / e : null, ects: e, sum: s };
  },
  // base: { sum, ects } of graded passed modules ; plan: [{ g, ects, fail }]
  project(base, plan) {
    const add = this.avg(plan.filter(p => !p.fail)), e = base.ects + add.ects;
    return { avg: e ? (base.sum + add.sum) / e : null, ects: e, addEcts: add.ects };
  },
  // average needed over the still-open exams (no grade picked, not failed on purpose) to land exactly on target
  needed(base, plan, openEcts, target) {
    if (!(openEcts > 0) || !(target >= 1 && target <= 4)) return null;
    const p = this.project(base, plan), E = p.ects + openEcts;
    return (target * E - (p.avg == null ? 0 : p.avg * p.ects)) / openEcts;
  },
};
if (typeof module !== "undefined") module.exports = GPA;
if (typeof document !== "undefined") (() => {
  const KEY = "tumSchedPlan";
  let GR = null, grP = null, open = sessionStorage.getItem("tumSchedPlanOpen") === "1";
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  let ST = load(); ST.ex = ST.ex || {}; ST.fix = ST.fix || {};
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(ST)); } catch {} };
  const fmtG = x => x == null ? "–" : GPA.trunc(x).toFixed(1).replace(".", ",");
  const fmt2 = x => x == null ? "–" : (Math.round(x * 100) / 100).toFixed(2).replace(".", ",");
  const codeIn = s => (String(s || "").toUpperCase().match(/\b([A-Z]{2,4}\d{3,6})(?:-\d+)?\b/) || [])[1] || "";
  const exKey = x => normC(x.course) + "|" + startOfDay(x.e.start).toISOString().slice(0, 10);

  async function fetchGrades() {
    const tok = store.get(); if (!tok) throw new Error("The grade planner needs a TUMonline token (not available for .ics uploads).");
    await Promise.all([loadEcts(), loadPlan()]);
    const doc = await api("noten", { pToken: tok }), f = (r, ...n) => { for (const k of n) { const v = r.querySelector(k)?.textContent?.trim(); if (v) return v; } return ""; };
    const progs = new Map(), prog = (id, name) => { id = id || name || "?"; if (!progs.has(id)) progs.set(id, { id, name: name || id, mods: new Map(), official: null }); const p = progs.get(id); if (name && p.name === p.id) p.name = name; return p; };
    for (const r of doc.querySelectorAll("row")) {
      const P = GPA.parse(f(r, "uninotenamekurz", "note", "grade")), title = f(r, "lv_titel", "titel");
      const p = prog(f(r, "studienidentifikator", "st_studium_nr"), [f(r, "studienbezeichnung"), f(r, "abschluss_name_kurz")].filter(Boolean).join(" · "));
      const code = codeIn(f(r, "lv_nummer")) || codeIn(title), key = code || normE(title), date = f(r, "datum");
      if (!key) continue;
      const prev = p.mods.get(key);
      if (prev && prev.passed && !P.passed) continue;                 // keep the pass, ignore earlier/later fails
      if (prev && prev.passed && P.passed && (prev.date || "") > date) continue; // keep the latest pass
      let ects = parseFloat(f(r, "lv_credits", "credits", "ects", "ects_credits").replace(",", ".")), src = "TUMonline";
      if (!(ects > 0)) { ects = ectsOf(code); src = "module handbook"; }
      if (!(ects > 0) && PLAN && PLAN.exams) { const h = PLAN.exams.find(x => normE(x.t) === normE(title)); if (h) { ects = ectsOf(h.c); src = "module handbook"; } }
      if (!(ects > 0)) { ects = null; src = ""; }
      p.mods.set(key, { key, title, code, grade: P.g, graded: P.graded, passed: P.passed, ects, src, date, tries: (prev ? prev.tries : 0) + 1 });
    }
    try { // official credit-weighted average per programme (same "Noten" permission); optional
      const a = await api("absNoten", { pToken: tok }); let rows = [...a.querySelectorAll("studium")]; if (!rows.length) rows = [...a.querySelectorAll("row")];
      for (const r of rows) { const v = parseFloat(f(r, "avg_grade_weighted_by_credits", "durchschnitt").replace(",", ".")); if (v >= 1 && v <= 5) prog(f(r, "studidf", "studienidentifikator"), f(r, "studbez", "studienbezeichnung")).official = v; }
    } catch (e) { /* not available: fine, we compute it ourselves */ }
    for (const [id, p] of progs) if (!p.mods.size && p.official == null) progs.delete(id);
    return { progs: [...progs.values()] };
  }
  function loadGrades() {
    if (grP) return grP; GR = { busy: true }; renderPlanner();
    grP = fetchGrades().then(g => { GR = g; ST.autoload = true; save(); }).catch(e => { GR = { err: /berechtigung|permission|rechte|not allowed|keine|nicht berechtigt/i.test(e.message) ? "noperm" : e.message }; grP = null; }).then(renderPlanner);
    return grP;
  }
  function base(p) { // current GPA base for a programme: graded passed modules with known ECTS (user fixes applied)
    if (!p) { const m = ST.manual || {}; const g = parseFloat(String(m.gpa || "").replace(",", ".")), e = parseFloat(String(m.ects || "").replace(",", ".")); return g >= 1 && g <= 4 && e > 0 ? { sum: g * e, ects: e, avg: g, manual: true } : { sum: 0, ects: 0, avg: null, manual: true }; }
    const items = [...p.mods.values()].filter(m => m.passed && m.graded).map(m => ({ g: m.grade, ects: ST.fix[p.id + "|" + m.key] ?? m.ects }));
    const a = GPA.avg(items); return { sum: a.sum, ects: a.ects, avg: a.avg, missing: items.filter(i => !(i.ects > 0)).length, n: items.length };
  }
  function renderPlanner() {
    const box = $("planner"), cal = $("cal"); if (!box) return;
    const X = typeof examList === "function" && events.length ? examList() : [];
    box.hidden = cal.hidden || !events.length;
    const tog = $("planBtn"); if (tog) { tog.textContent = open ? "Hide grade planner" : "Grade planner"; tog.setAttribute("aria-expanded", open); }
    if (box.hidden) return;
    if (!open) { box.innerHTML = ""; box.classList.add("closed"); return; }
    box.classList.remove("closed");
    const progs = GR && GR.progs ? GR.progs : [];
    if (progs.length && !progs.some(p => p.id === ST.prog)) ST.prog = progs[0].id;
    const P = progs.find(p => p.id === ST.prog) || null, B = base(P), multi = progs.length > 1;
    let h = `<div class="phead"><div><h3>Grade planner</h3><p class="muted">Play with grades for your upcoming exams and see your GPA move. Fails never count toward the GPA.</p></div><button id="planClose" class="ghost" aria-label="Close planner">✕</button></div>`;
    if (multi) h += `<div class="pprogs" role="tablist" aria-label="Degree programme">${progs.map(p => `<button data-prog="${esc(p.id)}" class="${p.id === ST.prog ? "on" : ""}" role="tab" aria-selected="${p.id === ST.prog}">${esc(p.name)}</button>`).join("")}</div>`;
    if (!GR || GR.err || GR.busy) {
      h += `<div class="pload">`;
      if (GR && GR.busy) h += `<p class="wait"><span class="spinner"></span>Reading your grades from TUMonline…</p>`;
      else h += `<button id="planLoad" class="primary">Load my grades from TUMonline</button> <span class="muted">needs the “Noten” permission · read once, kept in memory only</span>`;
      if (GR && GR.err === "noperm") h += `<p class="perr">Your token doesn’t have the <b>“Noten”</b> permission yet. Open the <a href="https://campus.tum.de/tumonline/ee/ui/ca2/app/desktop/#/pl/ui/$ctx/wbservicesadmin.userTokenManagement?$ctx=" target="_blank" rel="noopener noreferrer">TUMonline token settings ↗</a>, tick “Noten” for this token, then load again. Or enter your GPA by hand below.</p>`;
      else if (GR && GR.err) h += `<p class="perr">Couldn’t read grades: ${esc(GR.err)}. You can enter your GPA by hand below.</p>`;
      const m = ST.manual || {};
      h += `<div class="pman"><span class="muted">Or by hand:</span><label>Current GPA <input id="manG" inputmode="decimal" placeholder="e.g. 2,3" value="${esc(m.gpa || "")}"></label><label>Graded ECTS so far <input id="manE" inputmode="decimal" placeholder="e.g. 30" value="${esc(m.ects || "")}"></label></div></div>`;
    }
    // current
    const off = P && P.official, cur = B.avg;
    h += `<div class="pstats"><div class="pstat"><span>Current GPA</span><b>${fmtG(cur ?? off)}</b><small>${cur != null ? `${fmt2(cur)} exact · ${ectsTxt(B.ects)} graded ECTS${P ? ` · ${B.n} module${B.n === 1 ? "" : "s"}${B.missing ? ` (${B.missing} without ECTS)` : ""}` : ""}` : off != null ? "TUMonline average" : P ? "no graded modules yet" : "enter it above"}</small></div>`;
    // planned list
    const guess = x => { // default programme for an exam: the one whose graded modules share the exam's subject prefix (MW…, IN…), else the first
      if (!multi) return progs[0] ? progs[0].id : null; const pre = (String(examCode(x) || "").match(/^[A-Z]+/) || [])[0]; let best = progs[0], bn = 0;
      if (pre) for (const p of progs) { const n = [...p.mods.values()].filter(m => m.code && m.code.startsWith(pre)).length; if (n > bn) { bn = n; best = p; } } return best.id; };
    const rows = X.map(x => { const k = exKey(x), s = ST.ex[k] || {}, ec = s.ects ?? x.ects ?? ectsOf(examCode(x)); return { x, k, s, ects: ec > 0 ? ec : null, prog: s.prog && progs.some(p => p.id === s.prog) ? s.prog : guess(x) }; });
    const mine = rows.filter(r => !multi || r.prog === ST.prog);
    const plan = mine.map(r => ({ g: r.s.g ?? null, ects: r.ects || 0, fail: !!r.s.fail }));
    const pr = GPA.project(B, plan), d = pr.avg != null && B.avg != null ? GPA.trunc(pr.avg) - GPA.trunc(B.avg) : null;
    const passE = mine.filter(r => !r.s.fail && r.s.g != null && r.s.g <= 4).reduce((a, r) => a + (r.ects || 0), 0);
    const openE = mine.filter(r => !r.s.fail && r.s.g == null).reduce((a, r) => a + (r.ects || 0), 0);
    h += `<div class="pstat proj"><span>Projected GPA</span><b>${fmtG(pr.avg)}</b><small>${pr.avg != null ? `${fmt2(pr.avg)} exact${d != null && Math.abs(d) >= 0.05 ? ` · <em class="${d < 0 ? "up" : "down"}">${d < 0 ? "▲ better by " : "▼ worse by "}${ectsTxt(Math.abs(d))}</em>` : d != null ? " · no change" : ""}` : "pick grades below"}</small></div>`;
    h += `<div class="pstat"><span>ECTS from these exams</span><b>+${ectsTxt(passE)}</b><small>${ectsTxt(openE)} ECTS still without a grade</small></div></div>`;
    // target
    const need = ST.target ? GPA.needed(B, plan, openE, parseFloat(String(ST.target).replace(",", "."))) : null;
    const tv = parseFloat(String(ST.target || "").replace(",", ".")), tmsg = !ST.target ? "→ shows the average you need in the exams you haven’t picked a grade for yet"
      : !(tv >= 1 && tv <= 4) ? "enter a GPA between 1,0 and 4,0" : !mine.length ? "→ no upcoming exams in this programme" : !openE ? "→ every exam already has a grade (or is failed on purpose) — clear one to see what you need"
      : need < 1 ? "→ not reachable with the open exams (you’d need better than 1,0)" : need > 4 ? "→ safe: even 4,0 in every open exam keeps you at or better than this target"
      : `→ you need about <b>${fmt2(need)}</b> on average in the ${ectsTxt(openE)} open ECTS`;
    h += `<div class="ptarget"><label>Target GPA <input id="tgt" inputmode="decimal" placeholder="e.g. 1,9" value="${esc(ST.target || "")}"></label><span class="muted">${tmsg}</span></div>`;
    // exam rows
    h += `<div class="pbar"><span class="muted">${mine.length} upcoming exam${mine.length === 1 ? "" : "s"}${multi ? " in this programme" : ""}</span><label class="muted">Set all <select id="setAll"><option value="">…</option>${GPA.STEPS.filter(g => g <= 4).map(g => `<option>${g.toFixed(1).replace(".", ",")}</option>`).join("")}<option value="clear">clear</option></select></label></div>`;
    h += `<ul class="plist">`;
    for (const r of rows) {
      if (multi && r.prog !== ST.prog) continue;
      const g = r.s.g, fail = !!r.s.fail;
      h += `<li class="pex${fail ? " pfail" : ""}${g != null && !fail ? " picked" : ""}" data-k="${esc(r.k)}" data-h="${r.x.h}">
        <div class="pt"><b>${esc(r.x.course)}</b><small class="muted">${esc(dShort(r.x.e.start))}${r.x.planned ? " · planned, not registered" : ""}</small></div>
        <label class="pects" title="ECTS">${r.ects == null ? `<input class="ectsIn" inputmode="decimal" placeholder="?" value="${esc(r.s.ects ?? "")}" aria-label="ECTS for ${esc(r.x.course)}">` : `<span>${ectsTxt(r.ects)}</span>`}<small>ECTS</small></label>
        <select class="gsel" aria-label="Expected grade for ${esc(r.x.course)}"${fail ? " disabled" : ""}><option value="">grade…</option>${GPA.STEPS.map(s => `<option value="${s}"${g === s ? " selected" : ""}>${s.toFixed(1).replace(".", ",")}${s === 5 ? " (fail)" : ""}</option>`).join("")}</select>
        <label class="pswitch" title="I’ll sit this exam but won’t pass it on purpose"><input type="checkbox" class="failIn" role="switch"${fail ? " checked" : ""}><span class="sw2"></span><span class="stxt">Fail on purpose</span></label>
        ${multi ? `<select class="psel" aria-label="Counts for programme">${progs.map(p => `<option value="${esc(p.id)}"${p.id === r.prog ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>` : ""}
      </li>`;
    }
    if (multi) { const other = rows.filter(r => r.prog !== ST.prog); if (other.length) h += `<li class="pother muted">${other.length} more exam${other.length === 1 ? "" : "s"} assigned to the other programme${progs.length > 2 ? "s" : ""}: ${other.map(r => esc(r.x.course)).join(", ")}</li>`; }
    if (!rows.length) h += `<li class="muted pother">No upcoming exams found in your calendar.</li>`;
    h += `</ul>`;
    // past modules (only with loaded grades)
    if (P && P.mods.size) {
      const ms = [...P.mods.values()].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      h += `<details class="ppast"${B.missing ? " open" : ""}><summary>Your graded modules (${B.n})${B.missing ? ` · <b>${B.missing} without ECTS — please fill in</b>` : ""}</summary><ul>`;
      for (const m of ms) { const fx = ST.fix[P.id + "|" + m.key], e = fx ?? m.ects;
        h += `<li class="${m.passed ? "" : "nf"}" data-m="${esc(m.key)}"><span>${esc(m.title || m.key)}${m.code ? ` <small class="muted">${esc(m.code)}</small>` : ""}</span><span class="pg">${m.graded ? fmtG(m.grade) : m.passed ? "passed" : "not passed"}</span><span class="pe">${m.passed && m.graded ? `<input class="fixIn" inputmode="decimal" value="${e ?? ""}" placeholder="?" aria-label="ECTS"> ECTS` : `<small class="muted">${m.passed ? "ungraded – not in GPA" : "not in GPA"}</small>`}</span></li>`; }
      h += `</ul></details>`;
    }
    h += `<p class="pnote muted">How it’s calculated (TUM APSO §17): credit-weighted average of passed module grades (1,0–4,0); fails (5,0), “fail on purpose” and ungraded passes don’t count. The GPA keeps one decimal and cuts the rest without rounding (1,79 → 1,7). Your FPSO can weight modules differently (e.g. the Bachelor’s thesis counts double), and a fail still uses up an attempt — so treat this as an estimate; TUMonline is binding.${off != null ? ` TUMonline’s own average for this programme: <b>${fmt2(off)}</b>.` : ""} Your grades stay in memory; only your what-if choices are saved in this browser (cleared on Log out). <button id="planReset" class="link">Reset planner</button></p>`;
    box.innerHTML = h;
    wire(box, rows);
  }
  // re-render after the browser has moved focus (Tab/click), then put focus back on the same field
  function rerender() { setTimeout(() => { const box = $("planner"), a = document.activeElement; let sel = null;
    if (box && a && box.contains(a)) { if (a.id) sel = "#" + a.id; else { const li = a.closest("[data-k],[data-m]"), cls = [...a.classList][0]; if (li && cls) sel = li.dataset.k != null ? `[data-k="${CSS.escape(li.dataset.k)}"] .${cls}` : `[data-m="${CSS.escape(li.dataset.m)}"] .${cls}`; } }
    renderPlanner(); const n = sel && $("planner").querySelector(sel); if (n) { n.focus(); if (n.select && n.tagName === "INPUT") n.select(); } }, 0); }
  function wire(box, rows) {
    const renderPlanner = rerender, upd = (k, patch) => { ST.ex[k] = { ...(ST.ex[k] || {}), ...patch }; save(); rerender(); };
    box.querySelector("#planClose").onclick = () => setOpen(false);
    box.querySelector("#planLoad")?.addEventListener("click", loadGrades);
    box.querySelector("#planReset").onclick = () => { const keep = ST.prog; ST = { ex: {}, fix: {}, prog: keep }; save(); renderPlanner(); };
    box.querySelectorAll("[data-prog]").forEach(b => b.onclick = () => { ST.prog = b.dataset.prog; save(); renderPlanner(); });
    const num = v => { const n = parseFloat(String(v).replace(",", ".")); return n > 0 ? n : null; };
    const mg = box.querySelector("#manG"), me = box.querySelector("#manE");
    if (mg) { const f = () => { ST.manual = { gpa: mg.value, ects: me.value }; save(); renderPlanner(); }; mg.onchange = f; me.onchange = f; }
    const tg = box.querySelector("#tgt"); tg.onchange = () => { ST.target = tg.value.trim(); save(); renderPlanner(); };
    box.querySelector("#setAll").onchange = e => { const v = e.target.value; for (const li of box.querySelectorAll("li.pex")) { const k = li.dataset.k; if (v === "clear") ST.ex[k] = { ...(ST.ex[k] || {}), g: null }; else if (!(ST.ex[k] || {}).fail) ST.ex[k] = { ...(ST.ex[k] || {}), g: parseFloat(v.replace(",", ".")) }; } save(); renderPlanner(); };
    for (const li of box.querySelectorAll("li.pex")) {
      const k = li.dataset.k; li.style.setProperty("--h", li.dataset.h);
      li.querySelector(".gsel").onchange = e => upd(k, { g: e.target.value ? parseFloat(e.target.value) : null });
      li.querySelector(".failIn").onchange = e => upd(k, { fail: e.target.checked });
      const ei = li.querySelector(".ectsIn"); if (ei) ei.onchange = () => upd(k, { ects: num(ei.value) });
      const ps = li.querySelector(".psel"); if (ps) ps.onchange = () => upd(k, { prog: ps.value });
    }
    const P = GR && GR.progs && GR.progs.find(p => p.id === ST.prog);
    for (const li of box.querySelectorAll(".ppast li[data-m]")) { const i = li.querySelector(".fixIn"); if (i && P) i.onchange = () => { const v = num(i.value); if (v) ST.fix[P.id + "|" + li.dataset.m] = v; else delete ST.fix[P.id + "|" + li.dataset.m]; save(); renderPlanner(); }; }
  }
  function setOpen(v) { open = v; sessionStorage.setItem("tumSchedPlanOpen", v ? "1" : "0"); renderPlanner(); if (v) { $("planner").scrollIntoView({ behavior: "smooth", block: "start" }); if (!GR && store.get() && ST.autoload) loadGrades(); } }
  window.renderPlanner = renderPlanner;
  window.plannerReset = () => { GR = null; grP = null; ST = { ex: {}, fix: {} }; try { localStorage.removeItem(KEY); } catch {} sessionStorage.removeItem("tumSchedPlanOpen"); open = false; const b = $("planner"); if (b) { b.innerHTML = ""; b.hidden = true; } };
  window.togglePlanner = () => setOpen(!open);
  renderPlanner();
})();
