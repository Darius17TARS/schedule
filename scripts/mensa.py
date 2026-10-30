#!/usr/bin/env python3
"""Scrape the public Mensa Ottobrunn menu (Studierendenwerk München Oberbayern) into data/mensa-ottobrunn.json.
Public menu data only - no personal data."""
import json, re, html, urllib.request, datetime
URL = "https://www.studierendenwerk-muenchen-oberbayern.de/mensa/speiseplan/speiseplan_433_-de.html"
req = urllib.request.Request(URL, headers={"User-Agent": "Darius17TARS-schedule-menu-bot (github.com/Darius17TARS/schedule)"})
s = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
DIET = {"0": "meat", "1": "vegetarian", "2": "vegan"}
days = []
for part in re.split(r'<div class="c-schedule__item">', s)[1:]:
    m = re.search(r'heute_(\d{4}-\d{2}-\d{2})', part)
    if not m: continue
    dishes = []
    for li in re.findall(r'<li class="c-menu-dish-list__item.*?</li>', part, re.S):
        a = lambda k: (re.search(k + r'="([^"]*)"', li) or [None, ""])[1]
        t = re.search(r'stwm-artname">(.*?)</span>', li, re.S)
        n = re.search(r'c-menu-dish__title">(.*?)</p>', li, re.S)
        if not n: continue
        clean = lambda x: html.unescape(re.sub(r"<[^>]+>|\s+", " ", x)).strip()
        dishes.append({"type": clean(t.group(1)) if t else "", "name": clean(n.group(1)),
                       "diet": DIET.get(a("data-essen-fleischlos"), ""),
                       "allergens": [x for x in a("data-essen-allergene").split(",") if x],
                       "additives": [x for x in a("data-essen-zusatz").split(",") if x]})
    days.append({"date": m.group(1), "dishes": dishes})
if not days: raise SystemExit("no days parsed - page layout changed?")
out = {"canteen": "Mensa Ottobrunn", "address": "Willy-Messerschmitt-Str. 5, Taufkirchen", "source": URL,
       "fetched": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes"), "days": days}
json.dump(out, open("data/mensa-ottobrunn.json", "w"), ensure_ascii=False, indent=1)
print(len(days), "days", sum(len(d["dishes"]) for d in days), "dishes")
