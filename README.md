# TUM Schedule

Static page that shows your TUM timetable with rooms on a daily left-to-right timeline.

- Enter your TUM ID -> a TUMonline API token is requested -> activate it in TUMonline (Token-Management, enable Kalender).
- Rooms are resolved via [NavigaTUM](https://nav.tum.de).
- Fallback: upload an `.ics` export.

Privacy: no backend, no data in this repo. The token is kept in `sessionStorage` only and cleared on tab close or Log out.

Unofficial, not affiliated with TUM.
