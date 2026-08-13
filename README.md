# Class Attendance Manager

A mobile-first, installable, offline-first attendance manager for a classroom or department, built to replace manual roll-calling with one-tap marking, live stats, and WhatsApp-ready reports.

## Latest update

- **Removed the shared default Student login** (`student` / `Student@123`) entirely — both from fresh installs and via migration on existing ones (only removes it while it's still the untouched default, never a real account).
- **Every student now gets their own individual login, generated automatically** — username = Registration Number, password = first 4 letters of first name (uppercase) + last 3 digits of Reg No. (e.g. Jane Doe / 1000000001 → `1000000001` / `JANE001`). This runs automatically in the background the moment the app loads — no button required — for every student who doesn't already have an account. The generated temporary passwords are shown to the Admin/Teacher exactly once, the next time they reach the dashboard, in a results table with a "Copy as CSV" button, since hashed passwords can never be retrieved again afterward. The manual **⚡ Auto-Generate Student Logins** button in User Management still exists too, for students added later.
- **Dashboard/report terminology**: "Total Present" → "**Total Attend Class**", "Total Absent" → "**Total Conduct Class**" — updated everywhere these represent aggregate counts (stat cards, report panel, WhatsApp/Copy/Print/PDF text, register table headers, and every CSV/Excel export). Per-student status (the Present/Absent toggle itself, "Mark All Present/Absent", roster filters, and individual P/A cells in registers) intentionally kept unchanged, since those describe an individual student's status rather than a total.

## Bug fix: Download Excel wasn't working

The Excel export library was previously loaded from a CDN (`cdn.jsdelivr.net`). If that domain was blocked, unreachable, or you opened the app fully offline before it ever loaded once, `Download Excel` would silently do nothing useful. It's now **vendored locally** at `vendor/xlsx.bundle.js` and cached by the service worker from the very first install — no network dependency, no CDN, works completely offline from the first launch. `Download CSV` was never affected by this (it has no external dependency) and remains a reliable fallback either way.

## What's new in this update

- **Real User Management & password system.** Replaced the old "pick a role, type any name" login with actual accounts: full CRUD in a new **User Management** page (Add/Edit/Delete/Activate-Deactivate, search, filter by role/status, last-login), Admin-initiated **Reset Password** (with optional "force change on next login"), and self-service **Change Password** under Profile & Security. Passwords are hashed (SHA-256 + per-user salt via the browser's Web Crypto API) — never stored or shown in plain text. See "About the password system" below for exactly what that does and doesn't guarantee in an app with no backend.
- **Exactly two roles now: Admin/Teacher and Student.** The old Admin/Co-CR split is gone — a Co-CR's job (mark attendance for the class) only ever fit the Admin/Teacher role, so existing Co-CR accounts are auto-migrated to Admin/Teacher. Students get their own restricted view: **My Attendance** (their own subject-wise record, overall stats, recent trend, and CSV/Excel export of only their own data) and **Profile & Security**. They cannot see other students' data, manage the roster, or reach any Admin-only page — enforced both by hiding the nav and by a guard in the page router itself.
- **Forced password change on first login.** New accounts and anything reset by an Admin/Teacher default to "must change password on next login" — the dashboard is inaccessible until a new password is set.
- **Session invalidation.** Changing or resetting a password bumps that account's session version; any other remembered login for that account (on this browser) is invalidated the next time the app loads, and a self-service password change signs you out immediately so you log back in with the new one.
- Existing local data — including old-format users — migrates automatically; nothing is lost when you update.

## Older updates

- **Fixed the subject dropdown properly.** It was rebuilt as a stable, always-mounted component that never triggers a full page re-render while you type, scroll, or navigate — that re-render-per-keystroke was the root cause of the flicker, refocus loss, and "needs multiple taps" issues. It now supports arrow-key navigation, Enter to select, Escape to close, auto-scroll to the current subject, and closes cleanly on outside click without timing hacks.
- **Attendance toggle is now instant.** Tapping Present/Absent patches just that button, row, and the stat cards/report panel directly in the DOM instead of re-rendering the whole page — noticeably smoother when tapping through a full class list on a low-end Android device. Added a Material-style ripple on tap.
- **New: Attendance Registers.** Every subject now has its own independent, automatically-updated register — a pivot table (S.No, Roll No, Name, one column per class date, Total Present, Total Absent, %) built live from your saved attendance, exactly like a physical college register. Includes a mini dashboard per subject (classes conducted, average/highest/lowest attendance), month filter, below-75%/50% filter, roll/name/date search, CSV export in the college-register layout, and Print.
- **Editing attendance no longer creates duplicates.** Re-saving attendance for a subject + date that was already submitted now updates that exact register cell in place and logs the change (who, when, before → after) instead of creating a second entry.
- **Deleted students keep their history.** Removing a student archives them — their past attendance still appears in every register they were part of, marked "inactive" — nothing is silently erased.
- **Student profile view.** Click any student's name (in Students or in a Register) to see their subject-wise attendance, overall totals, and a recent-classes trend strip.
- **Attendance History reorganized** into Today / Weekly / Monthly / Subject Registers / Recent Updates / Deleted / Reports tabs.
- Existing local data from earlier versions is migrated automatically — nothing is lost when you update.

## What's actually in this build (read this first)

Your original spec asked for a full Firebase-backed, multi-device, real-time-sync system with secure authentication. I can't provision a live Firebase project or credentials on your behalf, so here's the honest split:

**Fully working right now, offline, no setup:**
- Add students from the Admin Dashboard (or seed your own roster in `js/students-data.js`) — each gets S.No., Roll No., Name, and Registration No.
- Mark attendance in one tap, Mark All Present/Absent, live stats, search/filter/sort
- Add / Edit / Delete / Restore students (soft delete, nothing is ever lost silently)
- Attendance History — every finalized session is saved, searchable, printable, exportable
- WhatsApp-ready report generator — Copy, Share to WhatsApp, Save as TXT, Print/Save as PDF, Export all sessions as CSV
- Settings: light/dark/system theme, accent color, default subject, font size, report format (Simple/Detailed)
- JSON Backup & Restore (this is your cross-device sync today — export on one device, import on another)
- Real accounts with hashed passwords, Admin/Teacher vs Student roles, Reset Password, self-service Change Password, forced change on first login (see "About the password system" below)
- Activity log of every action
- Installable PWA with offline caching (service worker) — works with zero signal once installed

**Needs your own Firebase project (not something I can create for you):**
- Real-time multi-device sync
- Server-verified authentication (rate-limiting, remote revocation, real account recovery — see "About the password system")
- Enforced (not just visual) role-based permissions
- Conflict detection ("Rahul is currently editing…")
- Push notifications

Everything above is scaffolded and ready — see "Connecting Firebase" below.

## Running it

No build step. Just open `index.html`, or for full PWA install/offline behavior, serve the folder over HTTP:

```bash
cd Attendance-Manager
python3 -m http.server 8080
# visit http://localhost:8080
```

Deploy the folder as-is to Firebase Hosting, GitHub Pages, Netlify, or Vercel — it's static files only.

## First login

Two demo accounts are seeded on first run — the login screen shows them directly (username + a temporary password) so you're never locked out:
- **Admin/Teacher**: username `admin`, password `Admin@123`
- **Student**: username `student`, password `Student@123` (linked to the first roster entry, so you can see the Student view)

Both are flagged to force a password change on first login — you'll be walked straight to "Set a New Password" before you can reach the dashboard. Once changed, that account disappears from the login-screen hint automatically.

**Add real accounts** (recommended before handing this to anyone): log in as Admin/Teacher → **User Management** → **Add User**, one per Co-CR/faculty helper (role: Admin/Teacher) and, if you want students checking their own attendance, one per student (role: Student, linked to their roster entry via "Link to Student Record"). Deactivate or delete the two demo accounts once you've done that.

## About the password system

Passwords are hashed with SHA-256 plus a random per-user salt, using the browser's built-in Web Crypto API — never stored or displayed as plain text. That's a genuine improvement over a plain-text password field, and it means casually opening localStorage in dev tools won't show anyone's password.

It is **not** equivalent to real server-side authentication. This whole app runs entirely in the browser with no backend, so:
- Anyone with dev-tools access to *this specific browser* can still see the stored hashes (and could brute-force a weak one offline).
- There's no rate-limiting, no account lockout, no way to revoke access remotely, and "sessions" are just a value in localStorage — invalidating one only affects this browser.
- Two devices don't share accounts or sessions with each other; everything here is per-device.

If this is going to manage anything sensitive, or needs real multi-device accounts, connect Firebase Authentication (see "Connecting Firebase" below) — that's the point where "hashed locally" becomes "actually verified by a server."

**One more honest caveat:** the Student role's restrictions (can't see other students' attendance, can't reach admin pages) are enforced by this app's own UI and page router — a real restriction within the app, but not a hard data-isolation guarantee. Every account's data loads into the same browser page, so a technically determined Student could open dev tools and read the full dataset in memory regardless of what the UI shows them. Closing that gap for real means each Student's Firestore reads are scoped to only their own document by security rules on the server — see the sample rules in `firebase/firebase-config.js`.

## Where your data lives

Everything (students, sessions, users, settings, logs) is stored in the browser's `localStorage` under the key `esh_attendance_db_v1`. It survives closing the tab/app and reopening, but it is **per-device, per-browser** until Firebase is connected. Back up regularly:

**Settings → Backup & Restore → Export JSON**, then import that file on another device to move your data over.

## Connecting Firebase (for real cloud sync)

The sync layer itself (`firebase/firestore-sync.js`, the `mergeCloudDB`/`mergeById`
logic in `js/app.js`, and the `<script type="module">` tags in `index.html`) is
already built and wired in — this is genuinely a flag-flip once you have your
own project, not an integration task:

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → Create Project (free tier is enough for a class).
2. Enable **Firestore Database** (production mode is fine — the rules below lock it down properly).
3. Go to **Build → Authentication → Sign-in method** and enable the **Anonymous** provider.
   ⚠️ This app signs every device in *anonymously* (see `firestore-sync.js`) purely so
   Firestore's rules can require `request.auth != null` — it does **not** use
   Email/Password. If you enable Email/Password instead of Anonymous, every
   sign-in attempt fails silently before login (no toast is shown on the
   login screen by design) and the app quietly behaves as if Firebase were
   never connected at all — pure localStorage, exactly like before you set
   any of this up. This one setting is the most common way this "doesn't
   work."
4. In **Firestore Database → Rules**, paste the contents of `firestore.rules` (already in this repo) and click Publish.
5. In Project Settings → General, add a Web App and copy the config object.
6. Paste it into `firebase/firebase-config.js`, replacing the `YOUR_...` placeholders, and set `FIREBASE_ENABLED = true`.
7. Re-deploy. Test with two devices: on Device A, log in and change data; on Device B (fresh browser data), just open the site and log in — Device B should already have Device A's data with no import needed.

**If it still doesn't sync after that**, open the browser console on both
devices — `firestore-sync.js` logs every connection step and error there
(`[FirestoreSync] ...`) even when no toast is shown, so that's the fastest
way to see exactly which step is failing (auth, permissions, or network).

### Suggested Firestore data shape

To match the per-subject register model, structure Firestore roughly as:

```
attendance/
  subjects/
    SUBJECT_CODE_1/
      students/        (roster snapshot)
      sessions/         (one doc per date: present/absent/faculty/marks/editHistory)
      statistics/       (denormalized classes/avg/highest/lowest, updated on write)
    SUBJECT_CODE_2/
    SUBJECT_CODE_3/
    ... (one per subject in DB.subjects)
```

Each session document should store: subject code, subject name, faculty, date, time, per-student status, marked-by, created-at, updated-at, and an edit-history array — mirroring the shape already used in `DB.sessions` in `app.js`, so the sync layer is mostly "write this object to the right path" rather than a data-model redesign.

### A note on performance at scale

At ~50 students and a few hundred sessions, everything renders instantly with plain DOM re-rendering — there's no need for virtual scrolling or lazy loading yet, so this build doesn't include them. The Attendance screen's tap-to-toggle and the subject dropdown were specifically rebuilt to patch the DOM directly instead of re-rendering the whole page (see "What's new" above), which is what actually mattered for feel on a phone. If a future version tracks many semesters of history across a full department, virtualizing the register table's date columns (rendering only the visible window) is the next optimization to reach for — the register is already computed as a plain array of rows/columns, so slicing it for a virtual scroller is a small change, not a rewrite.

## Project structure

```
Attendance-Manager/
├── index.html            Single-page app shell
├── css/
│   ├── style.css         Design tokens, buttons, cards, toasts, modals
│   ├── dashboard.css     Sidebar, topbar, tables, report panel, login
│   └── responsive.css    Mobile breakpoints + bottom nav
├── js/
│   ├── students-data.js  Seed student data (from your PDF, loads once)
│   ├── subjects-data.js  Subject Code / Name / Faculty master list
│   └── app.js            All app logic: storage, auth, routing, every view
├── firebase/
│   └── firebase-config.js   Inert template — see "Connecting Firebase"
├── assets/icons/          PWA icons (192px, 512px)
├── manifest.json          PWA install metadata
├── service-worker.js      Offline caching of the app shell
└── README.md
```

`app.js` is intentionally a single file (organized by section comments: STORAGE, AUTH, STATE, RENDER, ACTIONS, BOOT) rather than split into `attendance.js` / `students.js` / etc., so the app has zero build step and works by just opening the HTML file — no module bundler, no CORS issues with `file://`. Split it into modules once you introduce a bundler or Firebase's ES module SDK.

## Known simplifications

- Login has no real password verification — it's a local role picker.
- "Conflict detection" / "currently editing" indicators only make sense with a live backend; not implemented locally.
- PDF export uses the browser's native Print dialog ("Save as PDF") rather than a generated PDF file, to avoid pulling in a heavy PDF library for something the browser already does well.
- Excel export is CSV (opens directly in Excel/Sheets); a native `.xlsx` can be added with the SheetJS library if you need real Excel formatting.
