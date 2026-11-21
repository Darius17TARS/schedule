#!/usr/bin/env python3
"""Refresh data/exams-ws2026.json from the public TUMonline exam list.

Uses the public exExamOffer REST feed (same catalogue as
wbExamOffer.wbExamsOfOrg?pOrgNr=1). Writes only module number, title, date,
time and room — never examiner names, person ids, enrolment counts or other
personal data.
"""
from __future__ import annotations

import datetime
import json
import sys
import time
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

SOURCE = "https://campus.tum.de/tumonline/wbExamOffer.wbExamsOfOrg?pOrgNr=1"
REST = "https://campus.tum.de/tumonline/ee/rest/slc.xm.exd/exExamOffer"
OUT = Path(__file__).resolve().parents[1] / "data" / "exams-ws2026.json"
UA = "Darius17TARS-schedule-exam-bot (github.com/Darius17TARS/schedule)"
PAGE = 200
DATE_FROM = "2026-10-01"
DATE_TO = "2027-09-30"
FORBIDDEN = (
    "firstname", "lastname", "exampersons", "obfuscated", "personid",
    "businesscard", "numberofparticipants",
)


def lang_value(node):
    if node is None:
        return ""
    if isinstance(node, str):
        return node.strip()
    if isinstance(node, dict):
        v = node.get("value")
        return v.strip() if isinstance(v, str) else ""
    return ""


def hhmm(node):
    raw = lang_value(node) if not isinstance(node, dict) else (node.get("value") or "")
    raw = str(raw).strip()
    if not raw:
        return None
    # "08:00:00" or "08:00"
    parts = raw.split(":")
    if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
        return f"{int(parts[0]):02d}:{int(parts[1]):02d}"
    return None


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def fetch_page(skip: int, top: int) -> dict:
    url = f"{REST}?$skip={skip}&$top={top}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "application/json", "Referer": SOURCE},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def rooms_of(offer: dict) -> str | None:
    names = []
    for a in as_list(offer.get("appointments")):
        if not isinstance(a, dict):
            continue
        n = (a.get("displayName") or "").strip()
        if n and n not in names:
            names.append(n)
    return ", ".join(names) if names else None


def extract(offer: dict) -> dict | None:
    code = (offer.get("displayCourseNumber") or "").strip()
    title = lang_value(offer.get("courseName"))
    date_node = offer.get("examDate") or {}
    date = (date_node.get("value") if isinstance(date_node, dict) else date_node) or ""
    date = str(date).strip()
    if not code or not title or not date or date < DATE_FROM or date > DATE_TO:
        return None
    start = hhmm(offer.get("examStart")) or "00:00"
    end = hhmm(offer.get("examEnd"))
    return {"c": code, "d": date, "e": end, "r": rooms_of(offer), "s": start, "t": title}


def main() -> int:
    offers, total, skip = [], None, 0
    while True:
        data = fetch_page(skip, PAGE)
        chunk = as_list(data.get("examOffers"))
        if total is None:
            total = int(data.get("totalCount") or 0)
            print(f"totalCount={total}", flush=True)
        offers.extend(o for o in chunk if isinstance(o, dict))
        skip += len(chunk)
        print(f"fetched {skip}/{total or '?'}", flush=True)
        if not chunk or (total and skip >= total):
            break
        time.sleep(0.15)
    if total and skip < total * 0.9:
        raise SystemExit(f"incomplete fetch: got {skip} of {total}")

    exams, seen = [], set()
    for o in offers:
        x = extract(o)
        if not x:
            continue
        key = (x["c"], x["d"], x["s"], x["e"], x["r"], x["t"])
        if key in seen:
            continue
        seen.add(key)
        exams.append(x)
    exams.sort(key=lambda x: (x["d"], x["s"] or "", x["c"], x["t"]))
    if len(exams) < 100:
        raise SystemExit(f"too few dated exams ({len(exams)}) — refusing to write")

    today = datetime.datetime.now(ZoneInfo("Europe/Berlin")).date().isoformat()
    out = {
        "source": SOURCE,
        "sourceName": "TUMonline public exam list (TUM-wide)",
        "updated": today,
        "semester": "WiSe 2026/27",
        "note": "Public data only: module number, title, date, time, room. No examiner or student data.",
        "exams": exams,
    }
    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    low = text.lower()
    for needle in FORBIDDEN:
        if needle in low:
            raise SystemExit(f"refusing to write: output contains forbidden field {needle!r}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    prev = None
    if OUT.exists():
        try:
            prev = json.loads(OUT.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            prev = None
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT} ({len(exams)} dated exams, {len(offers)} offers)")
    if prev and isinstance(prev.get("exams"), list):
        old = {(x.get("c"), x.get("d"), x.get("s")) for x in prev["exams"]}
        new = {(x["c"], x["d"], x["s"]) for x in exams}
        print(f"previous={len(prev['exams'])} as of {prev.get('updated')}  added={len(new-old)} removed={len(old-new)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
