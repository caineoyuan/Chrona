# Chrona ⏱

A very simple workout interval-timer app. Build a **Set** of sequential
exercises and breaks, run animated countdown timers, schedule sets to recur,
and keep streaks.

## Features

- **Sets** with a name, made of sequential **Exercises** (`Name` + `MM:SS`) and **Breaks**.
- Break **presets** (5s / 10s / 30s) plus custom breaks.
- **Schedule** recurrence by weekday (e.g. every Monday, weekdays, Tue+Thu). No days selected = every day.
- **Streak tracking** (toggle): counts consecutive *scheduled* days completed. Missing a non-scheduled day never breaks the streak.
- A set is **completed** automatically when its timers run to the end, or manually via **Mark as completed**.
- **Streak freezes**: earn 1 freeze every 2 weeks; the freeze button sits next to the complete button.
- **Home cards** show set name (serif), total time, current streak, and the last 7 scheduled days as filled 🔥 (done), ❄️ (frozen) or faded fire (missed).
- **Run view**: a vertical column of timer circles joined by a line, starting with a Start node. Each ring fills as it counts down, color animating **red → green**, with a bright **fuse spark** at the leading edge. Timers auto-advance.
- Typography: **DM Serif Text** for titles, **DM Sans** for body text.

Data is stored locally in the browser (`localStorage`).

## Develop

```bash
npm install
npm run dev
```

## Production / Railway

```bash
npm install
npm run build   # outputs dist/
npm start       # serves dist/ on $PORT (Express)
```

On Railway: set the **Build Command** to `npm run build` and the **Start
Command** to `npm start`. Railway provides `PORT` automatically.
