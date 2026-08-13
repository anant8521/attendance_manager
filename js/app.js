/* ============================================================
   Class Attendance Manager — app.js
   Single-file application core (works fully offline via localStorage).
   Organized in sections: STORAGE · AUTH · STATE · RENDER · ACTIONS · INIT
   Cloud sync hook points are marked with  // [FIREBASE HOOK]
   ============================================================ */

const STORAGE_KEY = "esh_attendance_db_v1";
const SESSION_KEY = "esh_attendance_session_v1";
const APP_VERSION = "1.0.0";

/* ---------------------------------------------------------
   STORAGE
--------------------------------------------------------- */
function migrateDB(db){
  // Bring older locally-saved databases (pre subject-code / soft-delete history) up to date.
  // Subject Management (added after subjects were a hardcoded constant): any
  // database that doesn't have a real, editable subjects list yet gets one
  // seeded from the original hardcoded list — same codes, so every existing
  // attendance session still matches up correctly.
  if(!db.subjects || !db.subjects.length){
    db.subjects = seedSubjectsFromLegacy();
  }
  if(!db.settings.defaultSubjectCode && db.subjects[0]){
    db.settings.defaultSubjectCode = db.subjects[0].code;
    db.settings.lastSubjectCode = db.subjects[0].code;
    delete db.settings.defaultSubject;
    delete db.settings.defaultFaculty;
  }
  if(db.settings.theme !== "light" && db.settings.theme !== "dark" && db.settings.theme !== "system"){
    db.settings.theme = "light";
  }
  if(!db.settings.reportFormat) db.settings.reportFormat = "simple";
  if(!db.className) db.className = "Your Institution — Your Class";
  (db.sessions||[]).forEach(s=>{ if(typeof s.deleted === "undefined") s.deleted = false; if(!s.time) s.time = "—"; if(!s.editHistory) s.editHistory = []; });

  // The app used to ship with one shared default Student login
  // (username "student" / Student@123). Every student now gets their own
  // individual auto-generated account instead, so remove the shared one —
  // but only while it's still the untouched default, never a real account
  // an admin happened to also name "student".
  db.users = (db.users||[]).filter(u => !(u.username==="student" && u.role==="student" && u.isSeedDefault));
  if(!db.pendingCredentialReveal) db.pendingCredentialReveal = [];
  // Tombstones: multi-device cloud sync merges records rather than blindly
  // overwriting (see mergeCloudDB below), so a permanent delete needs to be
  // remembered explicitly — otherwise merging with a device that hasn't
  // seen the deletion yet would resurrect the record. IDs only ever get
  // added here, never removed, and merges take the union of both sides'
  // tombstone lists.
  if(!db.deletedUserIds) db.deletedUserIds = [];
  if(!db.deletedStudentIds) db.deletedStudentIds = [];
  if(!db.deletedSubjectIds) db.deletedSubjectIds = [];
  if(!db.deletedSessionIds) db.deletedSessionIds = [];
  // Every session needs a real, explicit `updatedAt`/`version` so cloud
  // merges (mergeById) can always tell which side's copy of a given session
  // — deleted, restored, or edited — actually happened more recently.
  // Older locally-saved sessions predate this and only have a string
  // `savedAt`/`updatedAt`; backfill a numeric updatedAt + version 1 for
  // those so they compare correctly against newer records going forward.
  (db.sessions||[]).forEach(s=>{
    if(typeof s.updatedAt !== "number"){
      const t = Date.parse(s.updatedAt || s.savedAt || 0);
      s.updatedAt = isNaN(t) ? Date.now() : t;
    }
    if(typeof s.version !== "number") s.version = 1;
    if(typeof s.deletedAt === "undefined") s.deletedAt = s.deleted ? s.updatedAt : null;
  });
  // One live attendance list per date, shared across every subject — see
  // loadOrResetMarksForSession()/saveLiveMarks() below. Older installs may
  // have the previous per-subject draft/snapshot fields lying around; they're
  // simply no longer read or written, left in place harmlessly for anyone
  // restoring an old backup.
  if(!db.liveAttendance) db.liveAttendance = {};

  // Migrate the old {id,name,role:'admin'|'cocr'} user shape to full accounts.
  // 'cocr' becomes 'admin' — this app now has exactly two roles, and a Co-CR's
  // job (mark attendance for the whole class) only fits the Admin/Teacher role.
  (db.users||[]).forEach(u=>{
    if(u.fullName) return; // already migrated
    u.fullName = u.name || "User"; delete u.name;
    u.username = u.username || u.fullName.toLowerCase().replace(/\s+/g,"");
    u.role = u.role === "cocr" ? "admin" : (u.role || "admin");
    u.userId = u.userId || ""; u.email = u.email || ""; u.mobile = u.mobile || "";
    u.branch = u.branch || ""; u.semester = u.semester || ""; u.section = u.section || ""; u.subject = u.subject || "";
    u.status = u.status || "active";
    u.studentId = u.studentId || null;
    u.lastLogin = u.lastLogin || null;
    u.createdAt = u.createdAt || new Date().toISOString();
    u.sessionVersion = u.sessionVersion || 0;
    if(!u.passwordHash){ u.needsPasswordInit = true; u.forceChangePassword = true; } // hashed on next boot, see initializeDefaultPasswords()
  });

  // User Management (Student/Admin split): Admin vs Teacher is a display
  // label only — both have always had, and keep, identical permissions in
  // this app (there's a single "admin" role under the hood). It exists so
  // the Admin/Teacher tab can show "Total Admins" vs "Total Teachers" and
  // be searched by role, per the redesigned User Management page.
  (db.users||[]).forEach(u=>{
    if(u.role === "admin" && !u.designation) u.designation = u.id === "u1" ? "Admin" : "Teacher";
  });
  return db;
}
function loadDB(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(raw){
    try{ return migrateDB(JSON.parse(raw)); }catch(e){ console.warn("Corrupt DB, reseeding", e); }
  }
  const seededSubjects = seedSubjectsFromLegacy();
  const fresh = {
    students: SEED_STUDENTS,
    className: "Your Institution — Your Class",
    sessions: [],       // attendance history records (soft-deletable)
    logs: [],           // activity log
    subjects: seededSubjects,
    users: [
      { id:"u1", fullName:"Admin", username:"admin", role:"admin", designation:"Admin", userId:"", email:"", mobile:"",
        branch:"", semester:"", section:"", subject:"", status:"active",
        studentId:null, lastLogin:null, createdAt:new Date().toISOString(), sessionVersion:0,
        needsPasswordInit:true, forceChangePassword:true, isSeedDefault:true }
    ],
    pendingCredentialReveal: [],
    // One live attendance list per date, shared across every subject — see
    // loadOrResetMarksForSession()/saveLiveMarks() below.
    liveAttendance: {},
    settings: {
      theme: "light",          // light | dark | system
      accent: "#f4a825",
      defaultSubjectCode: seededSubjects[0] ? seededSubjects[0].code : "",
      lastSubjectCode: seededSubjects[0] ? seededSubjects[0].code : "",
      autoSave: true,
      fontSize: "normal",
      reportFormat: "simple"   // simple | detailed — controls Copy/WhatsApp text by default
    }
  };
  saveDB(fresh);
  // A virgin device's very first save must never look "newer" than real
  // cloud data it hasn't even checked for yet — saveDB() just stamped
  // _localSavedAt to "now", which would otherwise let this untouched seed's
  // settings/className/liveAttendance beat another device's real ones the
  // moment a cloud merge happens (see mergeCloudDB's remoteIsNewer check).
  // Reset it to 0 so any real remote copy always wins until this device
  // makes an actual local change of its own.
  fresh._localSavedAt = 0;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  return fresh;
}
function saveDB(db, opts){
  db._localSavedAt = Date.now(); // rough freshness signal, used by mergeCloudDB for fields with no per-record timestamp (settings, className, liveAttendance)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  // Cloud sync: mirrors this same DB object to Firestore, so every other
  // signed-in device gets it via the onSnapshot listener wired in boot()
  // below. No-ops safely if Firebase isn't connected yet. Most saves are
  // debounced (~250ms) so rapid successive edits coalesce into one write;
  // pass {immediate:true} for changes that must reach other devices right
  // away and shouldn't wait out the debounce window even briefly (deletes,
  // restores, password/account changes, approvals).
  if(window.FirestoreSync) window.FirestoreSync.push(db, opts);
}

/* ---------------------------------------------------------
   CLOUD MERGE
   Two devices can each make changes (a new registration on one, a password
   change on the other) between syncs. Blindly overwriting one whole DB with
   the other would silently drop whichever side didn't happen to write last
   — that's what previously made multi-device login unreliable (a user
   created on Device A could vanish from Device B's copy, or vice versa).
   Instead, merge record-by-record for every collection that carries login/
   roster data: union everything that exists on only one side, and for a
   record present on both sides, keep the one with the newer `updatedAt`
   stamp (falling back to createdAt/lastLogin, then to just keeping the
   local copy if there's truly no signal either way). Deleted-record
   tombstones (see migrateDB) are unioned too, so a permanent delete on one
   device can't be resurrected by an older copy from another.
--------------------------------------------------------- */
function newerTimestampOf(rec){
  if(!rec) return -1;
  if(typeof rec.updatedAt === "number") return rec.updatedAt;
  const raw = rec.updatedAt || rec.savedAt || rec.lastLogin || rec.createdAt || 0;
  const t = Date.parse(raw);
  return isNaN(t) ? 0 : t;
}
function mergeById(localArr, remoteArr, tombstoneIds){
  localArr = localArr || []; remoteArr = remoteArr || [];
  const tomb = new Set(tombstoneIds || []);
  const byId = new Map();
  localArr.forEach(rec => { if(!tomb.has(rec.id)) byId.set(rec.id, rec); });
  remoteArr.forEach(remoteRec => {
    if(tomb.has(remoteRec.id)) return;
    const localRec = byId.get(remoteRec.id);
    if(!localRec){ byId.set(remoteRec.id, remoteRec); return; }
    // CRITICAL: an untouched seed default (e.g. the Admin account a brand-new
    // device seeds itself with, still on the default password) must never
    // beat a genuine, customized record for the same id — no matter what the
    // timestamps say. Without this, a device that has never been used yet
    // stamps its default Admin's `updatedAt` to "right now" the moment it
    // hashes that default password at boot (see initializeDefaultPasswords),
    // which can look newer than another device's real password change from
    // earlier — silently reviving the default password/account after a
    // merge, and then re-pushing it to Firestore on the next save, corrupting
    // the real data for every device. A real record always wins over a
    // still-default one sharing the same id, regardless of which is "newer".
    const localIsDefault = !!localRec.isSeedDefault;
    const remoteIsDefault = !!remoteRec.isSeedDefault;
    let remoteWins;
    if(localIsDefault !== remoteIsDefault){
      remoteWins = !remoteIsDefault; // the non-default side always wins
    } else {
      remoteWins = newerTimestampOf(remoteRec) > newerTimestampOf(localRec);
    }
    if(remoteWins) byId.set(remoteRec.id, remoteRec);
  });
  return Array.from(byId.values());
}
function mergeLogs(localLogs, remoteLogs){
  const seen = new Set(); const merged = [];
  (localLogs||[]).concat(remoteLogs||[]).forEach(l=>{
    const key = l.at + "|" + l.by + "|" + l.text;
    if(seen.has(key)) return;
    seen.add(key); merged.push(l);
  });
  merged.sort((a,b)=> new Date(b.at) - new Date(a.at));
  return merged.slice(0, 300);
}
function mergeCloudDB(localDB, remoteDB){
  if(!remoteDB) return localDB;
  const deletedUserIds = Array.from(new Set((localDB.deletedUserIds||[]).concat(remoteDB.deletedUserIds||[])));
  const deletedStudentIds = Array.from(new Set((localDB.deletedStudentIds||[]).concat(remoteDB.deletedStudentIds||[])));
  const deletedSubjectIds = Array.from(new Set((localDB.deletedSubjectIds||[]).concat(remoteDB.deletedSubjectIds||[])));
  const deletedSessionIds = Array.from(new Set((localDB.deletedSessionIds||[]).concat(remoteDB.deletedSessionIds||[])));
  const merged = Object.assign({}, localDB, {
    users: mergeById(localDB.users, remoteDB.users, deletedUserIds),
    students: mergeById(localDB.students, remoteDB.students, deletedStudentIds),
    subjects: mergeById(localDB.subjects, remoteDB.subjects, deletedSubjectIds),
    sessions: mergeById(localDB.sessions, remoteDB.sessions, deletedSessionIds),
    logs: mergeLogs(localDB.logs, remoteDB.logs),
    pendingCredentialReveal: (localDB.pendingCredentialReveal||[]).length
      ? localDB.pendingCredentialReveal
      : (remoteDB.pendingCredentialReveal||[]),
    deletedUserIds, deletedStudentIds, deletedSubjectIds, deletedSessionIds,
  });
  // Fields with no natural per-record id (settings/className/liveAttendance):
  // whichever side was saved more recently wins wholesale, using the
  // overall "when was this whole DB last written locally" stamp each side
  // carries. Neither side may have one yet (older data) — in that case
  // keep the local copy rather than guessing.
  const remoteIsNewer = (remoteDB._localSavedAt || remoteDB._updatedAt || 0) > (localDB._localSavedAt || 0);
  if(remoteIsNewer){
    merged.settings = remoteDB.settings || localDB.settings;
    merged.className = remoteDB.className || localDB.className;
    merged.liveAttendance = remoteDB.liveAttendance || localDB.liveAttendance;
  }
  return merged;
}

let DB = loadDB();

/* ---------------------------------------------------------
   SUBJECTS — DB.subjects is the live, editable subject list (see Subject
   Management further down: renderSubjects/openSubjectModal/etc). Everything
   that used to read the old hardcoded SUBJECTS constant now reads through
   these helpers instead, so adding/editing/archiving a subject is reflected
   everywhere (attendance picker, registers, reports, dashboards, filters)
   immediately, with no reload.
--------------------------------------------------------- */
function allSubjects(){ return DB.subjects || []; }
function activeSubjectsList(){ return allSubjects().filter(s => s.status === "Active"); }
function findSubject(code){ return allSubjects().find(s => s.code === code) || null; }
function subjectLabel(s){ return s ? `${s.code} – ${s.name}` : ""; }
function subjectHasSessions(code){ return DB.sessions.some(s => !s.deleted && s.subjectCode === code); }
// Subjects to offer in historical views (registers, reports, per-student
// breakdowns): every Active subject, plus any Archived one that still has
// real attendance history — so archiving a subject never hides past data.
function subjectsWithHistory(){
  return allSubjects().filter(s => s.status === "Active" || subjectHasSessions(s.code));
}

function addLog(text){
  DB.logs.unshift({ text, at: new Date().toISOString(), by: currentUser ? currentUser.fullName : "System" });
  DB.logs = DB.logs.slice(0, 300);
  saveDB(DB);
}

/* ---------------------------------------------------------
   PASSWORD SECURITY
   Passwords are never stored or shown in plain text — each is hashed with
   the browser's built-in Web Crypto API (SHA-256) plus a random per-user
   salt. Read that as "not stored as plain text", not as "bank-grade
   security": this whole app runs client-side with no server, so anyone
   with dev-tools access to this specific browser can still see whatever
   is in localStorage, including these hashes. Real protection against a
   determined attacker needs a real backend (see README → Connecting
   Firebase, which also covers Firebase Authentication for this reason).
--------------------------------------------------------- */
const DEFAULT_ADMIN_PASSWORD = "Admin@123";
const DEFAULT_STUDENT_PASSWORD = "Student@123";
function randomSaltHex(){
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function sha256Hex(text){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function setUserPassword(user, plainPassword, forceChange){
  user.passwordSalt = randomSaltHex();
  user.passwordHash = await sha256Hex(user.passwordSalt + ":" + plainPassword);
  user.forceChangePassword = !!forceChange;
  user.sessionVersion = (user.sessionVersion||0) + 1;
  delete user.needsPasswordInit;
  delete user.isSeedDefault;
  user.updatedAt = Date.now(); // used by mergeCloudDB to pick the newer copy of this account across devices
}
async function verifyPassword(user, plainPassword){
  if(!user.passwordHash || !user.passwordSalt) return false;
  const attempt = await sha256Hex(user.passwordSalt + ":" + plainPassword);
  return attempt === user.passwordHash;
}
// Auto-generated Student login credentials: username = Registration Number,
// password = first 4 letters of first name (uppercase, or the complete first
// name if it's under 4 letters) + last 3 digits of Registration No. —
// e.g. Jane Doe / 1000000001 -> "1000000001" / "JANE001", or a short
// name like Om / 240045 -> "OM045". This is the student's PERMANENT
// password — they are never forced to change it, and never reset/change
// it themselves; only an Admin/Teacher can, from User Management (see
// setUserPassword's forceChange arg, always false for students). Note: a
// short first name can produce a password under this app's own 8-character
// minimum for admin-set passwords — that minimum simply doesn't apply here.
function generateStudentUsername(student){
  return (student.regNo && student.regNo.trim()) || student.rollNo;
}
// Format checks used to gate the password preview and block submission —
// deliberately loose (this app has no fixed Reg No. scheme across batches)
// but enough to catch empty/junk input: a name needs actual letters, a
// Registration No. needs at least 3 digits in it (generateStudentPassword
// needs those digits to build the password's numeric half).
function isValidStudentName(name){
  return !!(name && /[A-Za-z]{2,}/.test(name));
}
function isValidRegNo(regNo){
  return !!(regNo && regNo.trim().length >= 3 && (regNo.replace(/\D/g,"").length >= 3));
}
function generateStudentPassword(student){
  const firstName = (student.name||"Std").trim().split(/\s+/)[0];
  const letters = firstName.substring(0,4).toUpperCase();
  const regDigits = (student.regNo||"").replace(/\D/g,"");
  const last3 = regDigits.slice(-3).padStart(3,"0") || "000";
  return letters + last3;
}
function passwordStrengthScore(pw){
  let score = 0;
  if(pw.length>=8) score++;
  if(/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if(/[0-9]/.test(pw)) score++;
  if(/[^A-Za-z0-9]/.test(pw)) score++;
  return score; // 0-4
}
function passwordStrengthLabel(score){
  return ["Too weak","Weak","Fair","Good","Strong"][score] || "Too weak";
}
// Any account created before this update, or freshly seeded, needs its
// starting password hashed once — done here (async) before first render.
async function initializeDefaultPasswords(){
  let changed = false;
  for(const u of DB.users){
    if(u.needsPasswordInit){
      const temp = u.role === "admin" ? DEFAULT_ADMIN_PASSWORD : DEFAULT_STUDENT_PASSWORD;
      await setUserPassword(u, temp, u.role === "admin");
      u.isSeedDefault = true; // keep the login-screen hint visible until changed
      changed = true;
    }
  }
  if(changed) saveDB(DB);
}

/* ---------------------------------------------------------
   AUTH — real per-account username/password login (see PASSWORD SECURITY
   above for what "real" does and doesn't mean in a backend-less app).
--------------------------------------------------------- */
let currentUser = null;
// Cloud sync status, surfaced as a small badge in the topbar — but ONLY once
// someone is actually logged in (see connectCloudSync/setSyncStatus below).
// Firebase itself may connect in the background before that (anonymous
// auth + the realtime listener), but no status message or toast is shown to
// an unauthenticated person on the login screen.
let syncStatus = "idle"; // idle | connecting | synced | offline | error
let cloudSyncStarted = false;
function setSyncStatus(status){
  syncStatus = status;
  if(!currentUser) return; // never surface sync state before login
  // Uses the .sync-badge class (not just the #cloudSyncBadge id) so any
  // future badge instance stays in sync automatically.
  const badges = document.querySelectorAll(".sync-badge");
  if(!badges.length) return;
  const LABELS = {
    connecting: "🔄 Syncing…",
    synced: "☁️ Synced",
    offline: "📴 Offline Mode",
    waiting: "⏳ Waiting for Internet",
    error: "⚠️ Sync Error"
  };
  badges.forEach(badge=>{
    badge.textContent = LABELS[status] || "";
    badge.style.display = LABELS[status] ? "flex" : "none";
  });
}
// Starts (once) the real-time Firestore listener — deliberately called only
// AFTER a successful login (fresh sign-in, or a remembered session found at
// boot), never on the bare login screen, so sync status/toasts can never
// leak to a signed-out person and there's no visible "reconnect flash"
// right after logging in.
function connectCloudSync(){
  if(cloudSyncStarted) return;
  if(!(window.FirestoreSync && window.FirestoreSync.enabled)) return;
  cloudSyncStarted = true;
  if(currentUser) setSyncStatus("connecting");
  window.FirestoreSync.init({
    getLocalDB: () => DB,
    mergeCloudDB,
    onRemoteChange: (remoteDB) => {
      // Always merge — even before anyone has logged in on this device —
      // so DB.users (and every other collection) reflects every other
      // device's changes as soon as they arrive. This is what lets a brand
      // new account created on Device A actually authenticate on Device B:
      // previously this callback was skipped entirely until after a local
      // login succeeded, which meant a device with no prior local session
      // could never learn about accounts created elsewhere. See also
      // attemptLogin(), which does its own one-off pull for the case where
      // this realtime listener hasn't connected yet by the time someone
      // tries to log in.
      DB = mergeCloudDB(DB, migrateDB(remoteDB));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DB));
      if(currentUser){
        loadOrResetMarksForSession();
        setSyncStatus(navigator.onLine ? "synced" : "offline");
        render();
      }
    },
    onStatus: (msg, type) => {
      if(!currentUser) return; // suppress status/toasts before login
      toast(msg, type || "info");
      setSyncStatus(type === "error" ? "error" : (navigator.onLine ? "synced" : "offline"));
    }
  });
}
window.addEventListener("online", ()=> setSyncStatus(cloudSyncStarted ? "synced" : "idle"));
window.addEventListener("offline", ()=> setSyncStatus(cloudSyncStarted ? "waiting" : "idle"));

function loadSession(){
  const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
  if(!raw) return null;
  try{
    const sess = JSON.parse(raw);
    const user = DB.users.find(u=>u.id===sess.id);
    // A password reset/change bumps sessionVersion — any older remembered
    // session on this browser is invalidated the next time the app loads.
    if(!user || user.status!=="active" || user.sessionVersion !== sess.sessionVersion) {
      localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return user;
  }catch(e){ return null; }
}
function persistSession(user, remember){
  const sess = { id:user.id, sessionVersion:user.sessionVersion };
  if(remember) localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
  else sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
}
// [FIREBASE HOOK] Always confirmed against the newest known Users collection
// before a password is checked — never against a stale local copy. On a
// device that has never logged in before (so connectCloudSync's realtime
// listener may not have connected yet), this one-off pull is what lets a
// student/teacher/admin account created on a different device log in here
// right away. Bounded by a timeout so a slow/offline connection doesn't
// block logging in with whatever's already cached locally.
async function refreshAuthDataFromCloud(){
  if(!(window.FirestoreSync && window.FirestoreSync.enabled)) return;
  try{
    const remoteDB = await Promise.race([
      window.FirestoreSync.pullLatest(),
      new Promise(resolve => setTimeout(()=>resolve(null), 4000))
    ]);
    if(remoteDB){
      DB = mergeCloudDB(DB, migrateDB(remoteDB));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DB));
    }
  }catch(e){
    // Offline or unreachable — fall back to whatever's already cached locally.
  }
}
async function attemptLogin(username, password, remember, expectedRole){
  await refreshAuthDataFromCloud();
  const user = DB.users.find(u=>u.username.toLowerCase() === username.trim().toLowerCase());
  if(!user) return { ok:false, error:"Incorrect username or password." };
  if(expectedRole && user.role !== expectedRole){
    return { ok:false, error: expectedRole==="student"
      ? "That's an Admin/Teacher account — use the Admin/Teacher Login tab."
      : "That's a Student account — use the Student Login tab." };
  }
  if(user.status === "pending") return { ok:false, error:"Your registration is still pending Admin/Teacher approval." };
  if(user.status === "rejected") return { ok:false, error:"Your registration was not approved. Contact your Admin/Teacher." };
  if(user.status !== "active") return { ok:false, error:"This account has been deactivated. Contact your Admin/Teacher." };
  const valid = await verifyPassword(user, password);
  if(!valid) return { ok:false, error:"Incorrect username or password." };
  user.lastLogin = new Date().toISOString();
  user.updatedAt = Date.now();
  saveDB(DB);
  currentUser = user;
  persistSession(user, remember);
  state.view = defaultViewFor(user.role);
  addLog(`${user.fullName} (${user.role==="admin"?"Admin/Teacher":"Student"}) logged in`);
  connectCloudSync();
  return { ok:true };
}
function defaultViewFor(role){ return role==="admin" ? "attendance" : "my-attendance"; }
function doLogout(){
  addLog(`${currentUser.fullName} logged out`);
  localStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  currentUser = null;
  render();
}
function isAdmin(){ return currentUser && currentUser.role === "admin"; }
function myStudentRecord(){
  return currentUser && currentUser.studentId ? DB.students.find(s=>s.id===currentUser.studentId) : null;
}

/* ---------------------------------------------------------
   STATE
--------------------------------------------------------- */
const state = {
  view: "attendance",
  loginPortal: "admin", // "admin" (default) | "student" — see the split login portals
  today: {
    date: new Date().toISOString().slice(0,10),
    subjectCode: DB.settings.lastSubjectCode || DB.settings.defaultSubjectCode,
    faculty: (findSubject(DB.settings.lastSubjectCode || DB.settings.defaultSubjectCode)||{}).faculty || "",
    facultyManual: false,   // true once the user hand-edits faculty for this session
    marks: {}  // studentId -> "present" | "absent"
  },
  rosterSearch: "",
  rosterFilter: "all", // all | present | absent | unmarked
  page: 1,
  pageSize: 10,
  _rosterEnterAnim: null, // "next" | "prev" | null — one-shot swipe slide-in flag, see goToRosterPage()
  studentsSearch: "",
  studentsSort: "roll",
  historySearch: "",
  showDeletedHistory: false,
  historyTab: "all",
  // Advanced search/filter state for the "🗂️ All Records" History tab —
  // lets any attendance record be found regardless of how long ago it was
  // saved (exact date, a date range, a specific month, a specific year,
  // and/or a subject), combined with the existing free-text historySearch box.
  histFilter: { date: "", from: "", to: "", month: "", year: "", subjectCode: "" },
  histAdvancedOpen: false, // collapsed by default — Search/Today/This Month/Subject stay visible, exact date/range/month/year live behind this toggle
  registerSubject: null,
  registerMonth: "all",
  registerSearch: "",
  registerBelow: "none",
  editingRecord: null, // {id, subjectCode, subject, date} set by editSessionRecord(), shown as a banner on Attendance and cleared on save/cancel/nav
  reportFormatOverride: null, // null = use Settings default; else "simple" | "detailed" for this session only
  userTab: "student", // "student" (default) | "admin" — see User Management redesign
  studentUserSearch: "",
  studentUserStatusFilter: "all",
  adminUserSearch: "",
  adminUserStatusFilter: "all",
  subjectSearch: "",
  subjectSemFilter: "all",
  subjectStatusFilter: "all",
  subjectTypeFilter: "all",
  undoStack: [],
  redoStack: []
};

function currentTimeStr(){
  return new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}
function setSubject(code){
  const subj = findSubject(code);
  if(!subj) return null;
  state.today.subjectCode = code;
  if(!state.today.facultyManual) state.today.faculty = subj.faculty;
  DB.settings.lastSubjectCode = code;
  saveDB(DB);
  // Deliberately does NOT touch state.today.marks or call
  // loadOrResetMarksForSession() — there is only one live attendance list
  // per date, and switching subjects must never reset or reload it.
  return "carried";
}

function activeStudents(){ return DB.students.filter(s => !s.deleted); }

function ensureMarksSeeded(){
  // Default everyone Absent unless already marked — the CR marks who
  // actually attended (opt-in), rather than marking who left.
  activeStudents().forEach(s=>{
    if(!(s.id in state.today.marks)) state.today.marks[s.id] = "absent";
  });
}

// There is exactly ONE live attendance list per date, shared by every
// subject — subject is just a label attached when a report is generated or
// finalized to History, it plays no part in which marks are shown. Every
// edit (toggle, mark all, quick-add, reset) immediately updates
// DB.liveAttendance[date] via saveLiveMarks(), and switching subjects never
// touches state.today.marks at all — it stays exactly as it was.
function saveLiveMarks(){
  DB.liveAttendance[state.today.date] = {
    marks: {...state.today.marks},
    updatedAt: new Date().toISOString()
  };
  saveDB(DB);
}
// Loads the live attendance list for whatever date is currently selected.
// Called on boot and whenever the DATE changes — never when the subject
// changes, since subject has no bearing on which marks are shown.
function loadOrResetMarksForSession(){
  const live = DB.liveAttendance[state.today.date];
  if(live){
    state.today.marks = {...live.marks};
    ensureMarksSeeded(); // covers any student added after this was last saved
    return "live";
  }
  state.today.marks = {};
  ensureMarksSeeded();
  return "blank";
}

function computeStats(){
  const list = activeStudents();
  const present = list.filter(s => state.today.marks[s.id] === "present").length;
  const absent = list.filter(s => state.today.marks[s.id] === "absent").length;
  const total = list.length;
  const pct = total ? parseFloat(((present/total)*100).toFixed(2)).toString() : "0";
  return { total, present, absent, pct };
}

/* ---------------------------------------------------------
   TOASTS / MODALS
--------------------------------------------------------- */
function toast(msg, type="info"){
  const stack = document.getElementById("toastStack");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const icon = type==="success" ? "✅" : type==="error" ? "⚠️" : "ℹ️";
  el.innerHTML = `<span>${icon}</span><span>${escapeHtml(msg)}</span>`;
  stack.appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .25s"; setTimeout(()=>el.remove(),250); }, 2600);
}
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
}
function confirmModal({title, message, confirmText="Confirm", danger=false}){
  return new Promise(resolve=>{
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        <p class="sub">${escapeHtml(message)}</p>
        <div class="actions">
          <button class="btn" id="mCancel">Cancel</button>
          <button class="btn ${danger?'btn-danger':'btn-primary'}" id="mOk">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector("#mCancel").onclick = ()=>{ backdrop.remove(); resolve(false); };
    backdrop.querySelector("#mOk").onclick = ()=>{ backdrop.remove(); resolve(true); };
    backdrop.addEventListener("click", e=>{ if(e.target===backdrop){ backdrop.remove(); resolve(false); } });
  });
}

/* ---------------------------------------------------------
   FOCUS PRESERVATION
   renderView() rebuilds a whole section's innerHTML on every state change,
   including on every keystroke in a search box (see the *Search oninput
   handlers below). Replacing innerHTML destroys the focused <input> and
   creates a brand new DOM node in its place, which is what was causing
   search boxes to lose focus, clear/jump their cursor, and drop the mobile
   keyboard after every character. This wrapper remembers which field (by
   id) had focus and exactly where the cursor/selection was, then restores
   both to the freshly-rendered replacement node, synchronously, before the
   browser gets a chance to notice focus ever left — so typing feels
   completely continuous and the on-screen keyboard never closes.
--------------------------------------------------------- */
function withPreservedFocus(fn){
  const active = document.activeElement;
  let saved = null;
  if(active && active.id && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")){
    saved = { id: active.id, start: null, end: null, dir: null };
    try{ saved.start = active.selectionStart; saved.end = active.selectionEnd; saved.dir = active.selectionDirection; }
    catch(e){ /* e.g. checkbox/radio/number inputs don't support text selection */ }
  }
  fn();
  if(saved){
    const el = document.getElementById(saved.id);
    if(el){
      el.focus({ preventScroll: true });
      if(typeof saved.start === "number" && typeof el.setSelectionRange === "function"){
        try{ el.setSelectionRange(saved.start, saved.end, saved.dir || "none"); }catch(e){ /* not a text-selectable input type */ }
      }
    }
  }
}

/* ---------------------------------------------------------
   RENDER — ROOT
--------------------------------------------------------- */
function render(){
  const root = document.getElementById("root");
  if(!currentUser){ root.innerHTML = renderLogin(); bindLoginEvents(); return; }
  // Only Admin/Teacher accounts ever go through the "set a new password"
  // screen. Students log straight into their Dashboard after a successful
  // login — the auto-generated registration password (see
  // generateStudentPassword) is their permanent password; they never
  // reset or change it themselves (see NAV/renderProfile: the Change
  // Password card is Admin-only; only an Admin can reset a student's
  // password, from User Management).
  if(currentUser.role==="admin" && currentUser.forceChangePassword){ root.innerHTML = renderForcedChange(); bindForcedChangeEvents(); return; }
  root.innerHTML = renderShell();
  bindShellEvents();
  setSyncStatus(syncStatus); // hydrate the freshly-created badge with the last known state
  renderView();
  if(isAdmin() && DB.pendingCredentialReveal && DB.pendingCredentialReveal.length){
    const creds = DB.pendingCredentialReveal;
    DB.pendingCredentialReveal = [];
    saveDB(DB);
    showGeneratedCredentialsModal(creds, 0);
  }
}

let loginClockTimer = null;

function renderLogin(){
  // Worked example for the Students card, generated from the real algorithm
  // (see generateStudentUsername/generateStudentPassword) so it can never
  // drift out of sync with how student credentials are actually created.
  const exampleStudent = { name:"Jane Doe", regNo:"1000000001" };
  const examplePassword = generateStudentPassword(exampleStudent);
  const portal = state.loginPortal === "student" ? "student" : "admin";
  return `
  <div class="login-wrap">
    <div class="login-shell">
      <div class="login-brand" aria-hidden="true">
        ${circuitBackgroundSvg()}
        <div class="login-brand-inner">
          <div class="login-brand-top">
            <img class="login-logo" src="./assets/icons/icon-192.png" alt="" />
            <div>
            <span class="login-brand-eyebrow">Government Polytechnic Munger</span>
              <h1>Department of<br>Electrical Engineering</h1>
            </div>
          </div>
          <div class="login-vision">
            <span class="login-vision-label">Vision</span>
            <p class="login-brand-tag">To produce competent and skilled Electrical Engineers through technical excellence, hands-on training, creative thinking, and modern technologies, capable of meeting the challenges of modern industries, renewable energy, automation, and smart technologies for industry and society.</p>
          </div>
          <div class="login-brand-badges">
            <span class="brand-badge">⚡ Technical Excellence</span>
            <span class="brand-badge">🛠 Practical Training</span>
            <span class="brand-badge">💡 Innovation</span>
            <span class="brand-badge">🌱 Renewable Energy</span>
            <span class="brand-badge">🤖 Automation</span>
            <span class="brand-badge">⚙ Smart Technologies</span>
          </div>
          <div class="login-clock" id="loginClock"></div>
        </div>
      </div>

      <div class="login-card fade-in">
        <div class="login-card-head">
          <img class="login-logo login-logo-mobile" src="./assets/icons/icon-192.png" alt="App logo" />
          <p class="login-org">Government Polytechnic Munger</p>
          <p class="login-org-sub">Department of Electrical Engineering</p>
        </div>
        <h2>Attendance Management System</h2>
        <p class="sub">Sign to Continue</p>

        <div class="role-toggle login-portal-toggle">
          <button data-portal="student" class="${portal==='student'?'active':''}">🎓 Student Login</button>
          <button data-portal="admin" class="${portal==='admin'?'active':''}">👨‍🏫 Admin Login</button>
        </div>

        <div id="loginError"></div>
        <div class="field">
          <label style="display:block;font-size:12.5px;font-weight:600;color:var(--text-dim);margin-bottom:6px;text-align:left;">${portal==='student'?'Registration Number':'Username'}${reqStar()}</label>
          <input class="field-input" id="loginName" placeholder="${portal==='student'?'Enter Registration No.':'Enter Username'}" autocomplete="username" />
        </div>
        <div class="field">
          <label style="display:block;font-size:12.5px;font-weight:600;color:var(--text-dim);margin-bottom:6px;text-align:left;">Password${reqStar()}</label>
          <div class="password-field">
            <input class="field-input" id="loginPass" type="password" placeholder="Enter Password" autocomplete="current-password" />
            <button type="button" class="pw-toggle" id="loginPassToggle" aria-label="Show password" aria-pressed="false">👁️</button>
          </div>
        </div>
        <label class="remember-row"><input type="checkbox" id="rememberMe" checked/> Keep me signed in</label>
        <button class="btn btn-primary btn-block btn-gradient" id="loginBtn">
          <span class="btn-label">Sign In</span>
        </button>
        ${portal==='admin' ? `
        <button class="btn btn-ghost btn-block" id="forgotBtn" style="margin-top:6px;font-weight:500;">Forgot your password?</button>
        <button class="btn btn-outline btn-block" id="registerAdminBtn" style="margin-top:8px;height:44px;"><i class="fa-solid fa-user-plus"></i> Register as Admin/Teacher</button>
        ` : `
        <p class="sub" style="margin-top:10px;">Forgot your password? Ask your Admin to reset it.</p>
        <button class="btn btn-outline btn-block" id="registerStudentBtn" style="margin-top:2px;height:44px;"><i class="fa-solid fa-user-graduate"></i> Register as New Student</button>
        <details class="demo-hint">
          <summary>Student login example</summary>
          <div class="demo-example">
            <div>Name: ${escapeHtml(exampleStudent.name)}</div>
            <div>Registration No.: <code>${escapeHtml(exampleStudent.regNo)}</code></div>
            <div>Password: <code>${escapeHtml(examplePassword)}</code></div>
          </div>
        </details>
        `}
      </div>
    </div>
    <div class="login-footer">
      <div class="system-status"><span class="status-dot"></span> System ready</div>
      <div class="login-footer-text">
        <span>Government Polytechnic Munger</span>
        <span>Electrical Engineering</span>
      </div>
      <span class="version-badge">v${APP_VERSION}</span>
    </div>
  </div>`;
}

// A quiet nod to the subject (Electrical Engineering) instead of a generic
// gradient blob: a faint circuit-trace pattern with a slow current pulse.
// Pure CSS-driven SVG, so it costs nothing on low-end phones and disappears
// entirely under prefers-reduced-motion (see the global rule in style.css).
function circuitBackgroundSvg(){
  return `
  <svg class="circuit-bg" viewBox="0 0 420 520" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
    <g fill="none" stroke="rgba(244,168,37,.35)" stroke-width="1.5" stroke-linecap="round">
      <path class="trace trace-1" d="M-10 80 H120 V180 H260 V70 H440" />
      <path class="trace trace-2" d="M-10 420 H90 V300 H210 V400 H440" />
      <path class="trace trace-3" d="M40 -10 V120 H200 V260 H160 V520" />
      <path class="trace trace-4" d="M380 -10 V150 H300 V330 H430" />
    </g>
    <g fill="#f4a825">
      <circle cx="120" cy="80" r="3.5" opacity=".55" />
      <circle cx="260" cy="180" r="3.5" opacity=".55" />
      <circle cx="90" cy="420" r="3.5" opacity=".55" />
      <circle cx="210" cy="300" r="3.5" opacity=".55" />
      <circle cx="200" cy="120" r="3.5" opacity=".55" />
      <circle cx="160" cy="260" r="3.5" opacity=".55" />
      <circle cx="300" cy="150" r="3.5" opacity=".55" />
      <circle cx="430" cy="330" r="3.5" opacity=".55" />
    </g>
  </svg>`;
}

// Small red-asterisk marker for a required field's label.
function reqStar(){ return ' <span class="req-star">*</span>'; }

// Checks a set of {id, label} required fields in whichever form is
// currently open: highlights every empty one (red border) and clears the
// highlight the moment the person types something. Returns the list of
// missing labels — empty array means the form is good to submit. Also wires
// a live "input" listener so the red border clears immediately, rather than
// only on the next submit attempt.
function validateRequired(fields){
  const missing = [];
  fields.forEach(f=>{
    const el = document.getElementById(f.id);
    if(!el) return;
    const val = el.value.trim();
    if(!val){ el.classList.add("field-error"); missing.push(f.label); }
    else el.classList.remove("field-error");
    if(!el._reqListenerAttached){
      el.addEventListener("input", ()=> el.classList.remove("field-error"));
      el._reqListenerAttached = true;
    }
  });
  return missing;
}

// Reusable show/hide toggle for any password field — used on every password
// field across the app. 👁️ = show, 🙈 = hide.
function wirePasswordToggle(inputId, btnId){
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if(!input || !btn) return;
  btn.onclick = ()=>{
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "👁️" : "🙈";
    btn.setAttribute("aria-pressed", String(!showing));
    btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    input.focus({ preventScroll:true });
  };
}

function bindLoginEvents(){
  const portal = state.loginPortal === "student" ? "student" : "admin";
  const doSubmit = async ()=>{
    const username = document.getElementById("loginName").value;
    const password = document.getElementById("loginPass").value;
    const remember = document.getElementById("rememberMe").checked;
    const btn = document.getElementById("loginBtn");
    const missing = validateRequired([
      {id:"loginName", label: portal==="student" ? "Registration Number" : "Username"},
      {id:"loginPass", label:"Password"}
    ]);
    if(missing.length){ showLoginError(`Please fill in: ${missing.join(", ")}.`); return; }
    btn.disabled = true; btn.classList.remove("success"); btn.classList.add("loading");
    btn.querySelector(".btn-label").textContent = "Signing in…";
    const result = await attemptLogin(username, password, remember, portal);
    if(result.ok){
      btn.classList.remove("loading"); btn.classList.add("success");
      btn.querySelector(".btn-label").textContent = "Success";
      const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setTimeout(render, reduceMotion ? 0 : 420);
      return;
    }
    btn.disabled = false; btn.classList.remove("loading");
    btn.querySelector(".btn-label").textContent = "Sign In";
    showLoginError(result.error);
  };
  document.getElementById("loginBtn").onclick = doSubmit;
  document.getElementById("loginPass").addEventListener("keydown", e=>{ if(e.key==="Enter") doSubmit(); });
  wirePasswordToggle("loginPass", "loginPassToggle");
  document.querySelectorAll("[data-portal]").forEach(b=>{
    b.onclick = ()=>{ state.loginPortal = b.dataset.portal; render(); };
  });
  if(portal==="admin"){
    document.getElementById("forgotBtn").onclick = ()=>{
      openForgotPasswordModal(document.getElementById("loginName").value.trim());
    };
    document.getElementById("registerAdminBtn").onclick = ()=> openAdminRegistrationModal();
  }else{
    document.getElementById("registerStudentBtn").onclick = ()=> openStudentRegistrationModal();
  }

  tickLoginClock();
  if(loginClockTimer) clearInterval(loginClockTimer);
  loginClockTimer = setInterval(tickLoginClock, 30000);
}
function tickLoginClock(){
  const el = document.getElementById("loginClock");
  if(!el){ clearInterval(loginClockTimer); return; }
  const now = new Date();
  const date = now.toLocaleDateString([], { weekday:"long", day:"2-digit", month:"long" });
  const time = now.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
  el.innerHTML = `<span class="login-clock-date">${date}</span><span class="login-clock-time">🕒 ${time}</span>`;
}
function showLoginError(msg){
  document.getElementById("loginError").innerHTML = `<div class="login-error">⚠️ ${escapeHtml(msg)}</div>`;
}

/* ---------------------------------------------------------
   SELF-REGISTRATION (Student & Admin/Teacher) — both submit as status
   "pending" and cannot log in until an Admin approves them (see the
   Pending Approval actions in renderStudentAccountsSection/
   renderAdminAccountsSection). Students go through Admin/Teacher approval;
   Admin/Teacher requests go through the Primary Admin only.
--------------------------------------------------------- */
function openStudentRegistrationModal(){
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:440px;max-height:90vh;overflow:auto;">
      <h3>🎓 Student Registration</h3>
      <p class="sub">Submit your details — an Admin/Teacher must approve your account before you can sign in.</p>
      <div id="srError"></div>
      <div class="field"><label>Full Name${reqStar()}</label><input class="field-input" id="srName"></div>
      <div class="field"><label>Class Roll No.${reqStar()}</label><input class="field-input" id="srRoll"></div>
      <div class="field"><label>Registration No.${reqStar()}</label><input class="field-input" id="srReg"></div>
      <div class="field"><label>Board Roll No.${reqStar()}</label><input class="field-input" id="srBoardRoll"></div>
      <div class="field">
        <label>🔑 Password Preview</label>
        <input class="field-input" id="srPasswordPreview" readonly disabled style="font-family:'JetBrains Mono',monospace;letter-spacing:.5px;color:var(--text-dim);background:var(--surface-2);cursor:not-allowed;">
        <p class="sub" style="text-align:left;margin-top:4px;font-size:12px;">This is generated automatically from your Name + Registration No. and is your permanent login password.</p>
      </div>
      <div class="actions">
        <button class="btn" id="srCancel">Cancel</button>
        <button class="btn btn-primary" id="srSubmit">Submit Registration</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  // Live-updating password preview — regenerated from the same
  // generateStudentPassword() used everywhere else, so it can never drift
  // out of sync with the password that actually gets saved on submit. Only
  // shows a real preview once Name and Registration No. both look valid
  // (see isValidStudentName/isValidRegNo below).
  const updateSrPasswordPreview = ()=>{
    const previewEl = document.getElementById("srPasswordPreview");
    if(!previewEl) return;
    const name = document.getElementById("srName").value.trim();
    const regNo = document.getElementById("srReg").value.trim();
    if(isValidStudentName(name) && isValidRegNo(regNo)){ previewEl.value = generateStudentPassword({ name, regNo }); }
    else{ previewEl.value = "Password will be generated automatically."; }
  };
  backdrop.querySelector("#srName").oninput = updateSrPasswordPreview;
  backdrop.querySelector("#srReg").oninput = updateSrPasswordPreview;
  updateSrPasswordPreview();
  backdrop.querySelector("#srCancel").onclick = ()=> backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
  backdrop.querySelector("#srSubmit").onclick = async ()=>{
    const showErr = (msg)=>{ document.getElementById("srError").innerHTML = `<div class="login-error">⚠️ ${escapeHtml(msg)}</div>`; };
    const missing = validateRequired([
      {id:"srName", label:"Full Name"}, {id:"srRoll", label:"Class Roll No."},
      {id:"srReg", label:"Registration No."}, {id:"srBoardRoll", label:"Board Roll No."}
    ]);
    if(missing.length){ showErr(`Please fill in: ${missing.join(", ")}.`); return; }
    const name = document.getElementById("srName").value.trim();
    const rollNo = document.getElementById("srRoll").value.trim();
    const regNo = document.getElementById("srReg").value.trim();
    const boardRoll = document.getElementById("srBoardRoll").value.trim();
    if(!isValidStudentName(name)){ showErr("Please enter a valid Full Name (letters only)."); return; }
    if(!isValidRegNo(regNo)){ showErr("Please enter a valid Registration No. (letters/numbers, at least 3 digits)."); return; }
    const dupeUsername = DB.users.find(u=>u.username.toLowerCase()===regNo.toLowerCase());
    if(dupeUsername){ showErr("A registration or account with this Registration No. already exists."); return; }
    const dupeRoll = DB.students.find(s=>!s.deleted && s.rollNo.toLowerCase()===rollNo.toLowerCase());
    if(dupeRoll){ showErr("A student with this Class Roll No. already exists."); return; }
    const dupeBoard = DB.students.find(s=>!s.deleted && (s.boardRoll||"").toLowerCase()===boardRoll.toLowerCase());
    if(dupeBoard){ showErr("A student with this Board Roll No. already exists."); return; }
    // Password is never entered by the student — it's auto-generated from
    // Name + Registration No. (see generateStudentPassword) and becomes
    // their permanent login password. Students never reset or change it
    // themselves; only an Admin/Teacher can, from User Management.
    const generatedPw = generateStudentPassword({ name, regNo });
    const user = {
      id:"u"+Date.now(), fullName:name, username:regNo, role:"student", status:"pending",
      userId:regNo, email:"", mobile:"", branch:"", semester:"", section:"", subject:"",
      studentId:null, pendingProfile:{ name, rollNo, regNo, boardRoll },
      lastLogin:null, createdAt:new Date().toISOString(), sessionVersion:0
    };
    await setUserPassword(user, generatedPw, false);
    DB.users.push(user);
    saveDB(DB);
    addLog(`Student registration submitted: ${name} (${regNo}) — pending approval`);
    toast("Registration submitted! Waiting for Admin approval.","success");
    backdrop.remove();
  };
}

function openAdminRegistrationModal(){
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:440px;max-height:90vh;overflow:auto;">
      <h3>👨‍🏫 Admin Registration</h3>
      <p class="sub">Submit your details — only the Primary Admin can approve your account before you can sign in.</p>
      <div id="arError"></div>
      <div class="field"><label>Full Name${reqStar()}</label><input class="field-input" id="arName"></div>
      <div class="field"><label>Username${reqStar()}</label><input class="field-input" id="arUsername" autocomplete="off"></div>
      <div class="field"><label>Email${reqStar()}</label><input class="field-input" id="arEmail" type="email"></div>
      <div class="field"><label>Mobile Number${reqStar()}</label><input class="field-input" id="arMobile"></div>
      <div class="field"><label>Password${reqStar()}</label><div class="password-field"><input class="field-input" id="arPassword" type="password" autocomplete="new-password"><button type="button" class="pw-toggle" id="arPasswordToggle" aria-label="Show password">👁️</button></div></div>
      <div class="field"><label>Confirm Password${reqStar()}</label><div class="password-field"><input class="field-input" id="arConfirm" type="password" autocomplete="new-password"><button type="button" class="pw-toggle" id="arConfirmToggle" aria-label="Show password">👁️</button></div></div>
      <div id="arStrength" class="strength-meter"></div>
      <div class="actions">
        <button class="btn" id="arCancel">Cancel</button>
        <button class="btn btn-primary" id="arSubmit">Submit Registration</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#arPassword").oninput = e=> renderStrengthMeter("arStrength", e.target.value);
  wirePasswordToggle("arPassword", "arPasswordToggle");
  wirePasswordToggle("arConfirm", "arConfirmToggle");
  backdrop.querySelector("#arCancel").onclick = ()=> backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
  backdrop.querySelector("#arSubmit").onclick = async ()=>{
    const showErr = (msg)=>{ document.getElementById("arError").innerHTML = `<div class="login-error">⚠️ ${escapeHtml(msg)}</div>`; };
    const missing = validateRequired([
      {id:"arName", label:"Full Name"}, {id:"arUsername", label:"Username"},
      {id:"arEmail", label:"Email"}, {id:"arMobile", label:"Mobile Number"},
      {id:"arPassword", label:"Password"}, {id:"arConfirm", label:"Confirm Password"}
    ]);
    if(missing.length){ showErr(`Please fill in: ${missing.join(", ")}.`); return; }
    const name = document.getElementById("arName").value.trim();
    const username = document.getElementById("arUsername").value.trim();
    const email = document.getElementById("arEmail").value.trim();
    const mobile = document.getElementById("arMobile").value.trim();
    const pw = document.getElementById("arPassword").value, confirm = document.getElementById("arConfirm").value;
    const dupeUser = DB.users.find(u=>u.username.toLowerCase()===username.toLowerCase());
    if(dupeUser){ showErr("That username is already taken."); return; }
    const dupeEmail = DB.users.find(u=>u.email && u.email.toLowerCase()===email.toLowerCase());
    if(dupeEmail){ showErr("That email is already registered."); return; }
    const dupeMobile = DB.users.find(u=>u.mobile && u.mobile===mobile);
    if(dupeMobile){ showErr("That mobile number is already registered."); return; }
    const pwErr = validateNewPassword(pw, confirm);
    if(pwErr){ showErr(pwErr); return; }
    const user = {
      id:"u"+Date.now(), fullName:name, username, role:"admin", designation:"Teacher", status:"pending",
      userId:"", email, mobile, branch:"", semester:"", section:"", subject:"", studentId:null,
      lastLogin:null, createdAt:new Date().toISOString(), sessionVersion:0
    };
    await setUserPassword(user, pw, false);
    DB.users.push(user);
    saveDB(DB);
    addLog(`Admin registration submitted: ${name} (${username}) — pending Primary Admin approval`);
    toast("Registration submitted! Waiting for Primary Admin approval.","success");
    backdrop.remove();
  };
}

/* ---------------------------------------------------------
   ADMIN FORGOT PASSWORD — OTP-based recovery, Admin/Teacher accounts only.
   Students and any other role are turned away at the identify step and
   pointed to their Admin/Teacher instead (see stepStudentBlocked below).

   The OTP is generated here, only its SHA-256 hash is ever kept in memory
   (ctx.otpHash), and the plaintext is handed off to a real delivery channel
   in js/otp-delivery.js (EmailJS for email; a Cloud Function hook for SMS —
   see that file for why SMS specifically needs a small backend). It is
   never rendered anywhere in this app's UI. If neither channel is
   configured for a given account, the reset flow says so plainly and
   points to another Admin/Teacher instead of falling back to showing the
   code — see the "no delivery channel configured" branch in stepMethod.
--------------------------------------------------------- */
function generateOtp(){ return String(Math.floor(100000 + Math.random()*900000)); }
function maskEmail(email){
  const at = email.indexOf("@");
  if(at < 1) return email;
  const user = email.slice(0, at), domain = email.slice(at);
  return `${user.slice(0,2)}${"*".repeat(Math.max(1,user.length-2))}${domain}`;
}
function maskMobile(mobile){
  const digits = mobile.replace(/\D/g,"");
  if(digits.length < 4) return mobile;
  return `${"*".repeat(Math.max(1,digits.length-4))}${digits.slice(-4)}`;
}

function openForgotPasswordModal(prefillUsername){
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal" style="max-width:440px;max-height:90vh;overflow:auto;"></div>`;
  document.body.appendChild(backdrop);
  const modal = backdrop.querySelector(".modal");
  const ctx = { user:null, method:null, target:null, otpHash:null, expiresAt:0, attempts:0 };
  let otpTimer = null;

  function close(){ if(otpTimer) clearInterval(otpTimer); backdrop.remove(); }
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) close(); });
  const err = (msg)=>{ const el = document.getElementById("fpError"); if(el) el.innerHTML = `<div class="login-error">⚠️ ${escapeHtml(msg)}</div>`; };

  function stepIdentify(){
    if(otpTimer) clearInterval(otpTimer);
    modal.innerHTML = `
      <h3>🔑 Forgot Password</h3>
      <p class="sub" style="text-align:left;">Password reset by OTP is available for Admin/Teacher accounts. Enter the username to continue.</p>
      <div id="fpError"></div>
      <div class="field"><label>Admin Username</label><input class="field-input" id="fpUsername" autocomplete="username" value="${escapeHtml(prefillUsername||"")}"></div>
      <div class="actions"><button class="btn" id="fpCancel">Cancel</button><button class="btn btn-primary" id="fpNext">Continue</button></div>`;
    modal.querySelector("#fpCancel").onclick = close;
    const goNext = ()=>{
      const uname = document.getElementById("fpUsername").value.trim();
      if(!uname){ err("Enter a username."); return; }
      const user = DB.users.find(u=>u.username.toLowerCase()===uname.toLowerCase());
      if(!user){ err("No account found with that username."); return; }
      if(user.status !== "active"){ err("This account has been deactivated. Contact another Admin/Teacher."); return; }
      if(user.role !== "admin"){ stepStudentBlocked(); return; }
      ctx.user = user;
      stepMethod();
    };
    modal.querySelector("#fpNext").onclick = goNext;
    modal.querySelector("#fpUsername").addEventListener("keydown", e=>{ if(e.key==="Enter") goNext(); });
  }

  function stepStudentBlocked(){
    modal.innerHTML = `
      <h3>🔑 Forgot Password</h3>
      <p class="sub" style="text-align:left;">Password reset by OTP is only available for Admin/Teacher accounts. Students: ask your Admin/Teacher to reset your password from User Management.</p>
      <div class="actions"><button class="btn" id="fpBack">Back</button><button class="btn btn-primary" id="fpClose">Close</button></div>`;
    modal.querySelector("#fpBack").onclick = stepIdentify;
    modal.querySelector("#fpClose").onclick = close;
  }

  function stepMethod(){
    const u = ctx.user;
    const hasEmail = !!(u.email && u.email.trim());
    const hasMobile = !!(u.mobile && u.mobile.trim());
    const emailDeliverable = hasEmail && window.OtpDelivery && window.OtpDelivery.emailEnabled;
    const mobileDeliverable = hasMobile && window.OtpDelivery && window.OtpDelivery.smsEnabled;
    if(!hasEmail && !hasMobile){
      modal.innerHTML = `
        <h3>🔑 Forgot Password</h3>
        <p class="sub" style="text-align:left;">No recovery email or mobile number is on file for <b>${escapeHtml(u.fullName)}</b>. Ask another Admin/Teacher to reset the password from User Management, or add a recovery email/mobile there yourself (User Management → Edit) once you're signed in.</p>
        <div class="actions"><button class="btn" id="fpBack">Back</button><button class="btn btn-primary" id="fpClose">Close</button></div>`;
      modal.querySelector("#fpBack").onclick = stepIdentify;
      modal.querySelector("#fpClose").onclick = close;
      return;
    }
    if(!emailDeliverable && !mobileDeliverable){
      // A recovery contact is on file, but no real delivery channel is
      // configured yet — being upfront about that (see js/otp-delivery.js)
      // rather than ever falling back to showing the code on screen.
      modal.innerHTML = `
        <h3>🔑 Forgot Password</h3>
        <p class="sub" style="text-align:left;">A recovery contact is on file for <b>${escapeHtml(u.fullName)}</b>, but no email/SMS delivery service is connected yet on this deployment (see <code>js/otp-delivery.js</code>). Ask another Admin/Teacher to reset the password from User Management instead.</p>
        <div class="actions"><button class="btn" id="fpBack">Back</button><button class="btn btn-primary" id="fpClose">Close</button></div>`;
      modal.querySelector("#fpBack").onclick = stepIdentify;
      modal.querySelector("#fpClose").onclick = close;
      return;
    }
    modal.innerHTML = `
      <h3>🔑 Reset Password</h3>
      <p class="sub" style="text-align:left;">Choose how to receive the one-time code, ${escapeHtml(u.fullName)}.</p>
      <div id="fpError"></div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
        ${emailDeliverable ? `<label class="remember-row" style="margin:0;"><input type="radio" name="fpMethod" value="email" checked> Registered Email <span style="color:var(--text-faint);">(${escapeHtml(maskEmail(u.email))})</span></label>` : ""}
        ${mobileDeliverable ? `<label class="remember-row" style="margin:0;"><input type="radio" name="fpMethod" value="mobile" ${!emailDeliverable?'checked':''}> Registered Mobile Number <span style="color:var(--text-faint);">(${escapeHtml(maskMobile(u.mobile))})</span></label>` : ""}
      </div>
      <div class="actions"><button class="btn" id="fpBack">Back</button><button class="btn btn-primary" id="fpSend">Send OTP</button></div>`;
    modal.querySelector("#fpBack").onclick = stepIdentify;
    modal.querySelector("#fpSend").onclick = async ()=>{
      const sel = modal.querySelector('input[name="fpMethod"]:checked');
      if(!sel){ err("Choose a recovery method."); return; }
      ctx.method = sel.value;
      ctx.target = ctx.method==="email" ? u.email : u.mobile;
      const btn = modal.querySelector("#fpSend");
      btn.disabled = true; btn.textContent = "Sending…";
      const result = await sendOtp();
      if(!result.ok){
        btn.disabled = false; btn.textContent = "Send OTP";
        err(result.reason==="not_configured"
          ? "This delivery channel isn't connected yet. Try the other method, or ask another Admin/Teacher for help."
          : "Couldn't send the code right now. Please try again in a moment.");
        return;
      }
      stepVerify();
    };
  }

  // Generates a fresh 6-digit code, stores only its hash (never the
  // plaintext) on ctx, and hands the plaintext to a real delivery channel —
  // it is never rendered anywhere in the UI. Each call invalidates any
  // previously-sent code (a fresh hash replaces the old one), which also
  // means a used or resent code can never be verified again.
  async function sendOtp(){
    const otp = generateOtp();
    const result = ctx.method==="email"
      ? await window.OtpDelivery.sendEmailOtp(ctx.target, otp, ctx.user.fullName)
      : await window.OtpDelivery.sendSmsOtp(ctx.target, otp, ctx.user.fullName);
    if(!result.ok) return result;
    ctx.otpHash = await sha256Hex(otp);
    ctx.expiresAt = Date.now() + 5*60*1000;
    ctx.attempts = 0;
    return result;
  }

  function stepVerify(){
    if(otpTimer) clearInterval(otpTimer);
    modal.innerHTML = `
      <h3>🔑 Enter Code</h3>
      <p class="sub" style="text-align:left;">A 6-digit code was sent to your ${ctx.method==="email"?"registered email":"registered mobile number"} (${escapeHtml(ctx.method==="email"?maskEmail(ctx.target):maskMobile(ctx.target))}). It never appears in this app — check your ${ctx.method==="email"?"inbox":"messages"}.</p>
      <div id="fpError"></div>
      <div class="field"><label>6-digit code</label><input class="field-input otp-input" id="fpOtp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
      <div class="otp-meta"><span id="fpCountdown"></span><span id="fpAttemptsLeft">${5-ctx.attempts} attempts left</span></div>
      <div class="actions"><button class="btn" id="fpResend">Resend Code</button><button class="btn btn-primary" id="fpVerify">Verify</button></div>`;
    tickCountdown();
    otpTimer = setInterval(tickCountdown, 1000);
    modal.querySelector("#fpResend").onclick = async ()=>{
      const rb = modal.querySelector("#fpResend");
      rb.disabled = true; rb.textContent = "Sending…";
      const result = await sendOtp();
      rb.disabled = false; rb.textContent = "Resend Code";
      if(!result.ok){ err("Couldn't resend the code right now. Please try again in a moment."); return; }
      stepVerify();
      toast("A new code was sent","info");
    };
    const doVerify = async ()=>{
      const val = document.getElementById("fpOtp").value.trim();
      if(!val){ err("Enter the 6-digit code."); return; }
      if(!ctx.otpHash){ err("This code is no longer valid. Request a new one."); return; }
      if(Date.now() > ctx.expiresAt){ err("This code has expired. Request a new one."); return; }
      const hash = await sha256Hex(val);
      if(hash !== ctx.otpHash){
        ctx.attempts++;
        const left = 5 - ctx.attempts;
        if(left <= 0){
          err("Too many incorrect attempts. Request a new code.");
          modal.querySelector("#fpVerify").disabled = true;
          ctx.otpHash = null; // burn this code so it can't be brute-forced further
          if(otpTimer) clearInterval(otpTimer);
          return;
        }
        document.getElementById("fpAttemptsLeft").textContent = `${left} attempt${left===1?"":"s"} left`;
        err(`Incorrect code. ${left} attempt${left===1?"":"s"} left.`);
        return;
      }
      ctx.otpHash = null; // one-time use — this code can never be verified again
      if(otpTimer) clearInterval(otpTimer);
      stepNewPassword();
    };
    modal.querySelector("#fpVerify").onclick = doVerify;
    document.getElementById("fpOtp").addEventListener("keydown", e=>{ if(e.key==="Enter") doVerify(); });
  }
  function tickCountdown(){
    const el = document.getElementById("fpCountdown");
    if(!el){ if(otpTimer) clearInterval(otpTimer); return; }
    const msLeft = Math.max(0, ctx.expiresAt - Date.now());
    const mm = Math.floor(msLeft/60000), ss = Math.floor((msLeft%60000)/1000);
    el.textContent = msLeft>0 ? `Expires in ${mm}:${String(ss).padStart(2,"0")}` : "Code expired";
    if(msLeft<=0 && otpTimer) clearInterval(otpTimer);
  }

  function stepNewPassword(){
    modal.innerHTML = `
      <h3>✅ Set a New Password</h3>
      <p class="sub" style="text-align:left;">Code verified. Choose a new password for <b>${escapeHtml(ctx.user.fullName)}</b>.</p>
      <div id="fpError"></div>
      <div class="field"><label>New Password</label><div class="password-field"><input class="field-input" id="fpNewPw" type="password" autocomplete="new-password"><button type="button" class="pw-toggle" id="fpNewPwToggle" aria-label="Show password">👁️</button></div></div>
      <div class="field"><label>Confirm Password</label><div class="password-field"><input class="field-input" id="fpConfirmPw" type="password" autocomplete="new-password"><button type="button" class="pw-toggle" id="fpConfirmPwToggle" aria-label="Show password">👁️</button></div></div>
      <div id="fpStrength" class="strength-meter"></div>
      <div class="actions"><button class="btn" id="fpCancel2">Cancel</button><button class="btn btn-primary" id="fpFinish">Reset Password</button></div>`;
    modal.querySelector("#fpCancel2").onclick = close;
    document.getElementById("fpNewPw").oninput = e=> renderStrengthMeter("fpStrength", e.target.value);
    wirePasswordToggle("fpNewPw", "fpNewPwToggle");
    wirePasswordToggle("fpConfirmPw", "fpConfirmPwToggle");
    modal.querySelector("#fpFinish").onclick = async ()=>{
      const pw = document.getElementById("fpNewPw").value, confirm = document.getElementById("fpConfirmPw").value;
      const pwErr = validateNewPassword(pw, confirm);
      if(pwErr){ err(pwErr); return; }
      await setUserPassword(ctx.user, pw, false);
      saveDB(DB); addLog(`${ctx.user.fullName} reset their password via Forgot Password (OTP)`);
      close();
      toast("Password reset — you can sign in now","success");
      const nameField = document.getElementById("loginName");
      if(nameField) nameField.value = ctx.user.username;
    };
  }

  stepIdentify();
}

function renderForcedChange(){
  return `
  <div class="login-wrap">
    <div class="login-card">
      <div class="brand-icon">🔒</div>
      <h2>Set a New Password</h2>
      <p class="sub">${currentUser.isSeedDefault ? "You're using a default password." : "Your password was reset by an Admin/Teacher."} For security, please set a new one before continuing.</p>
      <div id="fcError"></div>
      <div class="field">
        <label style="display:block;font-size:12.5px;font-weight:600;color:var(--text-dim);margin-bottom:6px;text-align:left;">New Password</label>
        <div class="password-field">
          <input class="field-input" id="fcNew" type="password" autocomplete="new-password" />
          <button type="button" class="pw-toggle" id="fcNewToggle" aria-label="Show password" aria-pressed="false">👁️</button>
        </div>
      </div>
      <div class="field">
        <label style="display:block;font-size:12.5px;font-weight:600;color:var(--text-dim);margin-bottom:6px;text-align:left;">Confirm New Password</label>
        <div class="password-field">
          <input class="field-input" id="fcConfirm" type="password" autocomplete="new-password" />
          <button type="button" class="pw-toggle" id="fcConfirmToggle" aria-label="Show password" aria-pressed="false">👁️</button>
        </div>
      </div>
      <div id="fcStrength" class="strength-meter"></div>
      <button class="btn btn-primary btn-block" id="fcSaveBtn" style="margin-top:10px;">✅ Set Password & Continue</button>
      <button class="btn btn-ghost btn-block" id="fcLogoutBtn" style="margin-top:6px;">Log out instead</button>
    </div>
  </div>`;
}
function bindForcedChangeEvents(){
  document.getElementById("fcNew").oninput = e=> renderStrengthMeter("fcStrength", e.target.value);
  wirePasswordToggle("fcNew", "fcNewToggle");
  wirePasswordToggle("fcConfirm", "fcConfirmToggle");
  document.getElementById("fcLogoutBtn").onclick = doLogout;
  document.getElementById("fcSaveBtn").onclick = async ()=>{
    const pw = document.getElementById("fcNew").value, confirm = document.getElementById("fcConfirm").value;
    const err = validateNewPassword(pw, confirm);
    if(err){ document.getElementById("fcError").innerHTML = `<div class="login-error">⚠️ ${escapeHtml(err)}</div>`; return; }
    await setUserPassword(currentUser, pw, false);
    persistSession(currentUser, true);
    saveDB(DB);
    addLog(`${currentUser.fullName} set a new password`);
    toast("Password set — welcome in!","success");
    render();
  };
}
function validateNewPassword(pw, confirm){
  if(pw.length < 8) return "Password must be at least 8 characters.";
  if(pw !== confirm) return "Passwords do not match.";
  return null;
}
function renderStrengthMeter(elId, pw){
  const el = document.getElementById(elId);
  if(!el) return;
  const score = passwordStrengthScore(pw);
  const colors = ["#e5484d","#e5484d","#e0932f","#e0932f","#1fa971"];
  el.innerHTML = pw ? `
    <div class="strength-bars">${[0,1,2,3].map(i=>`<span style="background:${i<score?colors[score]:'var(--border)'}"></span>`).join("")}</div>
    <span class="strength-label" style="color:${colors[score]}">${passwordStrengthLabel(score)}</span>` : "";
}

const NAV = [
  { id:"attendance", ic:"📋", label:"Mark Attendance", roles:["admin"] },
  { id:"students", ic:"👥", label:"Students List", roles:["admin"] },
  { id:"subjects", ic:"📚", label:"Subjects", roles:["admin"] },
  { id:"registers", ic:"📗", label:"Attendance Registers", roles:["admin"] },
  { id:"history", ic:"🕘", label:"Attendance History", roles:["admin"] },
  { id:"reports", ic:"📊", label:"Reports", roles:["admin"] },
  { id:"my-attendance", ic:"📗", label:"My Attendance", roles:["student"] },
  { id:"settings", ic:"⚙️", label:"Settings", roles:["admin"] },
  { id:"profile", ic:"🔐", label:"Profile & Security", roles:["admin","student"] },
  { id:"users", ic:"🔑", label:"User Management", roles:["admin"] },
  { id:"logs", ic:"📝", label:"Activity Log", roles:["admin"] },
  { id:"backup", ic:"💾", label:"Backup & Restore", roles:["admin"] },
  { id:"about", ic:"ℹ️", label:"About", roles:["admin","student"] }
];
function navFor(role){ return NAV.filter(n=>n.roles.includes(role)); }
const BOTTOM_NAV_ADMIN = ["attendance","students","history","reports","settings"];
const BOTTOM_NAV_STUDENT = ["my-attendance","profile","about"];

function renderShell(){
  const stats = computeStats();
  const role = currentUser.role;
  const myRec = myStudentRecord();
  const bottomNav = role==="admin" ? BOTTOM_NAV_ADMIN : BOTTOM_NAV_STUDENT;
  return `
  <div class="app-shell">
    <div class="sidebar-scrim" id="scrim"></div>
    <aside class="sidebar" id="sidebar">
      <div class="brand">
        <div class="brand-icon">👥</div>
        <div>
          <div class="brand-title">G P Munger<br><span class="brand-sub">Electrical Engineering</span></div>
          <div class="brand-sub">Attendance Manager</div>
        </div>
      </div>
      <nav class="nav-group">
        ${navFor(role).map(n=>`
          <button class="nav-item ${state.view===n.id?'active':''}" data-nav="${n.id}">
            <span class="ic">${n.ic}</span> ${n.label}
          </button>`).join("")}
      </nav>
      ${role==="admin" ? `
      <div class="sidebar-card">
        <div class="big">${stats.total}</div>
        <div class="lbl">Total Students</div>
        <div class="sub">(${escapeHtml(DB.className)})</div>
      </div>
      <div class="sidebar-tips">
        <div class="t-title">💡 How to Use</div>
        <ol>
          <li>Select subject</li>
          <li>Mark Present / Absent</li>
          <li>Review & generate report</li>
          <li>Send to group</li>
        </ol>
      </div>` : `
      <div class="sidebar-card">
        <div class="big">${myRec ? overallPctFor(currentUser.studentId) : "—"}${myRec?"%":""}</div>
        <div class="lbl">Your Overall Attendance</div>
        <div class="sub">${myRec ? escapeHtml(myRec.rollNo) : "No student record linked"}</div>
      </div>
      <div class="sidebar-tips">
        <div class="t-title">💡 Your Access</div>
        <ol>
          <li>View your own attendance</li>
          <li>Export your own reports</li>
          <li>Change your password anytime</li>
        </ol>
      </div>`}
      <div class="sidebar-footer">
        Signed in as <b>${escapeHtml(currentUser.fullName)}</b> (${isAdmin()?"Admin/Teacher":"Student"})<br/>
        <button class="btn btn-sm btn-ghost" id="logoutBtn" style="margin-top:8px;color:#ff9a9a;">🚪 Logout</button>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <button class="menu-btn" id="menuBtn">☰</button>
          <div class="topbar-left">
            <h1>${headerTitle()}</h1>
            <p>${headerSub()}</p>
          </div>
        </div>
        <div class="topbar-right">
          <div class="topbar-status-pills">
            <span class="role-badge">📅 ${new Date().toLocaleDateString([], {day:'2-digit',month:'short',year:'numeric'})}</span>
            <span class="role-badge" id="liveClock">🕒 ${currentTimeStr()}</span>
            ${(window.FirestoreSync && window.FirestoreSync.enabled) ? `<span class="role-badge sync-badge" id="cloudSyncBadge" style="display:none;"></span>` : ""}
          </div>
          <div class="topbar-user-row">
            <span class="role-badge">👤 ${escapeHtml(currentUser.fullName)} · ${isAdmin()?"Admin":"Student"}</span>
            <button class="btn btn-sm" id="themeBtn">${themeBtnLabel()}</button>
          </div>
        </div>
      </header>
      <div class="content" id="viewRoot"></div>
    </div>

    <nav class="bottom-nav">
      ${bottomNav.map(id=>{
        const n = NAV.find(x=>x.id===id);
        return `<button class="bn-item ${state.view===id?'active':''}" data-nav="${id}"><span class="ic">${n.ic}</span>${n.label.split(" ")[0]}</button>`;
      }).join("")}
    </nav>
  </div>`;
}

function headerTitle(){
  const map = {
    attendance:"📋 Mark Attendance", students:"👥 Students List", registers:"📗 Attendance Registers", history:"🕘 Attendance History",
    reports:"📊 Attendance Reports", "my-attendance":"📗 My Attendance", settings:"⚙️ Settings", profile:"🔐 Profile & Security", users:"🔑 User Management",
    logs:"📝 Activity Log", backup:"💾 Backup & Restore", about:"ℹ️ About"
  };
  return map[state.view] || "📚 Subject List";
}
function headerSub(){
  const map = {
    attendance:"Mark, manage and share attendance easily", students:"Add, edit, search and manage the class roster",
    registers:"One independent register per subject, updated automatically", history:"Every past session, searchable and exportable", reports:"WhatsApp-ready attendance summaries",
    "my-attendance":"Your own subject-wise attendance and exports", settings:"Theme, defaults and app preferences", profile:"Account details and password",
    users:"Add, edit, deactivate and reset passwords for Admin/Teacher and Student accounts",
    logs:"Full record of who did what, and when", backup:"Export, import and reset your data",
    about:"Class Attendance Manager — built for everyday classroom use"
  };
  return map[state.view] || "";
}

function themeBtnLabel(){
  return DB.settings.theme==="dark" ? "🌙 Dark" : DB.settings.theme==="system" ? "🖥️ System" : "☀️ Light";
}
let clockTimer = null;
function bindShellEvents(){
  document.querySelectorAll("[data-nav]").forEach(b=>{
    b.onclick = ()=> navigateTo(b.dataset.nav);
  });
  document.getElementById("logoutBtn").onclick = doLogout;
  document.getElementById("themeBtn").onclick = ()=>{
    const order = ["light","dark","system"];
    DB.settings.theme = order[(order.indexOf(DB.settings.theme)+1) % order.length];
    saveDB(DB); applyTheme(); render();
  };
  const menuBtn = document.getElementById("menuBtn");
  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("scrim");
  if(menuBtn){
    menuBtn.onclick = ()=>{ sidebar.classList.add("open"); scrim.classList.add("show"); };
    scrim.onclick = ()=>{ sidebar.classList.remove("open"); scrim.classList.remove("show"); };
  }
  if(clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(()=>{
    const el = document.getElementById("liveClock");
    if(el) el.textContent = "🕒 " + currentTimeStr();
    else clearInterval(clockTimer);
  }, 1000);
}

// Switches page WITHOUT tearing down and rebuilding the whole app shell
// (sidebar, topbar, bottom nav, clock timer) — only the header text, the
// active nav highlighting, and the actual page content (#viewRoot) update.
// Previously every nav click called the full render(), which rebuilt the
// entire DOM tree on every single page switch; this makes navigation feel
// instant and avoids the unnecessary re-render/reflow cost of doing that.
// Falls back to a full render() for the rare cases that genuinely need one
// (role/permission changes, sidebar stat card refresh) — those still call
// render() directly elsewhere (login, logout, theme change, etc.).
function navigateTo(view){
  if(view!=="attendance") state.editingRecord = null;
  state.view = view; state.page = 1;
  if(view==="registers") state.registerSubject = null;
  document.querySelectorAll("[data-nav]").forEach(b=>{
    b.classList.toggle("active", b.dataset.nav===view);
  });
  const h1 = document.querySelector(".topbar h1");
  const psub = document.querySelector(".topbar-left p");
  if(h1) h1.textContent = headerTitle();
  if(psub) psub.textContent = headerSub();
  const sidebar = document.getElementById("sidebar");
  const scrim = document.getElementById("scrim");
  if(sidebar) sidebar.classList.remove("open");
  if(scrim) scrim.classList.remove("show");
  renderView();
}

function applyTheme(){
  let mode = DB.settings.theme;
  if(mode === "system"){
    mode = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", mode === "dark" ? "dark" : "light");
  document.documentElement.style.setProperty("--gold", DB.settings.accent || "#f4a825");
}

/* ---------------------------------------------------------
   RENDER — VIEW ROUTER
--------------------------------------------------------- */
function renderView(){
  withPreservedFocus(()=>{
    const el = document.getElementById("viewRoot");
    const navEntry = NAV.find(n=>n.id===state.view);
    if(navEntry && !navEntry.roles.includes(currentUser.role)){ el.innerHTML = accessDenied(); return; }
    ensureMarksSeeded();
    switch(state.view){
      case "attendance": el.innerHTML = renderAttendance(); bindAttendanceEvents(); break;
      case "students": el.innerHTML = renderStudents(); bindStudentsEvents(); break;
      case "subjects": el.innerHTML = renderSubjects(); bindSubjectsEvents(); break;
      case "registers": el.innerHTML = renderRegisters(); bindRegistersEvents(); break;
      case "history": el.innerHTML = renderHistory(); bindHistoryEvents(); break;
      case "reports": el.innerHTML = renderReportsPage(); bindReportsPageEvents(); break;
      case "my-attendance": el.innerHTML = renderMyAttendance(); bindMyAttendanceEvents(); break;
      case "settings": el.innerHTML = renderSettings(); bindSettingsEvents(); break;
      case "profile": el.innerHTML = renderProfile(); bindProfileEvents(); break;
      case "users": el.innerHTML = renderUserManagement(); bindUserManagementEvents(); break;
      case "logs": el.innerHTML = renderLogs(); bindLogsEvents(); break;
      case "backup": el.innerHTML = renderBackup(); bindBackupEvents(); break;
      case "about": el.innerHTML = renderAbout(); break;
      default: el.innerHTML = "";
    }
  });
}
function accessDenied(){
  return `<div class="empty-state card" style="padding:60px 20px;"><div class="emoji">🔒</div><h3>Access restricted</h3><p>This page is only available to Admin/Teacher accounts.</p></div>`;
}

/* ---------------------------------------------------------
   ATTENDANCE VIEW
--------------------------------------------------------- */
function renderAttendance(){
  const stats = computeStats();
  const list = filteredRoster();
  const start = (state.page-1)*state.pageSize;
  const pageItems = list.slice(start, start+state.pageSize);
  const totalPages = Math.max(1, Math.ceil(list.length/state.pageSize));
  const subj = findSubject(state.today.subjectCode);
  // One-shot slide-in animation for a swipe-triggered page change (see
  // bindRosterSwipe/goToRosterPage) — consumed immediately so a later,
  // unrelated re-render (typing in search, toggling a student, etc.)
  // never replays it.
  const rosterEnterClass = state._rosterEnterAnim === "next" ? "roster-enter-from-right"
    : state._rosterEnterAnim === "prev" ? "roster-enter-from-left" : "";
  state._rosterEnterAnim = null;

  return `
  ${state.editingRecord ? `
  <div class="note-strip" style="background:var(--gold-bg,rgba(244,168,37,.14));border-color:var(--gold);">
    ✏️ <span><b>Editing saved attendance</b> — ${escapeHtml(state.editingRecord.subjectCode||"")} ${escapeHtml(state.editingRecord.subject||"")} · ${formatDate(state.editingRecord.date)}. Adjust Present/Absent below, then click <b>Finalize & Save to History</b> to update this exact record.
    <button class="btn btn-sm" id="cancelEditRecord" style="margin-left:8px;">✕ Cancel Edit</button></span>
  </div>` : ""}
  <div class="filters-bar">
    <div class="field"><label>Date</label><input class="field-input" type="date" id="fDate" value="${state.today.date}"></div>
    <div class="field subject-field">
      <label>Subject</label>
      <button type="button" class="field-input subject-select-btn" id="subjectPickerBtn"
        aria-haspopup="dialog" aria-expanded="false" title="${escapeHtml(subjectLabel(subj))}">
        <span class="subject-select-text">${escapeHtml(subjectLabel(subj))}</span>
        <span class="subject-select-caret" aria-hidden="true">▾</span>
      </button>
    </div>
    <div class="field"><label>Faculty</label><input class="field-input" id="fFaculty" value="${escapeHtml(state.today.faculty)}" placeholder="Faculty"></div>
    <button class="btn btn-purple" id="todayBtn">📅 Today</button>
  </div>

  <div class="quick-actions-strip card">
    <button class="btn btn-outline-success" id="markAllPresent">✔ Mark All Present</button>
    <button class="btn btn-outline-danger" id="markAllAbsent">✘ Mark All Absent</button>
    <button class="btn" id="resetAttendanceBtn">↺ Reset Attendance</button>
    <button class="btn btn-gold" id="generateReportBtn">📊 Generate Report</button>
  </div>

  <div class="workspace">
    <div class="panel">
      <div class="panel-toolbar">
        <div class="search-input"><span class="ic">🔍</span><input id="rosterSearch" placeholder="Search by name or roll no..." value="${escapeHtml(state.rosterSearch)}"></div>
        <select class="field-input" id="rosterFilter" style="max-width:150px;">
          <option value="all" ${state.rosterFilter==='all'?'selected':''}>All (${stats.total})</option>
          <option value="present" ${state.rosterFilter==='present'?'selected':''}>Present (${stats.present})</option>
          <option value="absent" ${state.rosterFilter==='absent'?'selected':''}>Absent (${stats.absent})</option>
        </select>
      </div>
      <div class="roster-table-wrap ${rosterEnterClass}" id="rosterTableWrap">
        <table class="roster">
          <thead><tr><th class="td-sno">S.No.</th><th>Name</th><th>Roll No.</th><th>Attendance</th></tr></thead>
          <tbody>
            ${pageItems.map(s=>{
              const present = state.today.marks[s.id] !== "absent";
              return `
              <tr class="${present?'':'row-absent'}">
                <td class="td-sno">${s.sNo}</td>
                <td class="td-name">${escapeHtml(s.name)}</td>
                <td class="td-roll roll-mono">${escapeHtml(s.rollNo)}</td>
                <td class="td-status">
                  <button class="toggle-pill ${present?'is-present':'is-absent'}" data-toggle="${s.id}">
                    ${present ? "✔ Present" : "❌ Absent"}
                  </button>
                </td>
              </tr>`;}).join("") || `<tr><td colspan="4"><div class="empty-state"><div class="emoji">🔎</div>No students match.</div></td></tr>`}
          </tbody>
        </table>
      </div>
      <div class="pager">
        ${Array.from({length: totalPages}, (_,i)=>i+1).slice(0,7).map(p=>`<button class="${p===state.page?'active':''}" data-page="${p}">${p}</button>`).join("")}
        ${totalPages>7? `<button data-page="${state.page+1}">›</button><button data-page="${totalPages}">»</button>`:""}
        <span class="info">Showing ${Math.min(start+1,list.length)}–${Math.min(start+state.pageSize,list.length)} of ${list.length} students</span>
      </div>
    </div>

    ${renderReportPanel(stats)}
  </div>

  <div class="quick-add card">
    <div class="qa-icon">➕</div>
    <div style="flex:1;">
      <b>Quick Add Student</b>
      <div style="font-size:12.5px;color:var(--text-dim);">Add a new student to today's roster</div>
    </div>
    <div class="qa-fields">
      <input class="field-input" id="qaName" placeholder="Name *">
      <input class="field-input" id="qaRoll" placeholder="Class Roll No. *">
      <input class="field-input" id="qaReg" placeholder="Registration No. *">
      <input class="field-input" id="qaBoardRoll" placeholder="Board Roll No. *">
    </div>
    <button class="btn btn-success" id="qaAddBtn">➕ Add</button>
  </div>

  <div class="note-strip">📝 <span><b>Note:</b> All data is saved in your browser (offline-first)${(window.FirestoreSync && window.FirestoreSync.enabled) ? ", and syncs automatically to Firebase in real time across your other signed-in devices." : ". Use Backup → Export JSON regularly, or connect Firebase for automatic cloud sync (see Settings → Cloud Sync)."}</span></div>
  `;
}

/* Subject selector — opens as a proper popup (same interaction shape as
   tapping the native Date field: tap once, a focused picker surface appears,
   choose a value, it closes), instead of the old inline search-combobox.
   Subject names are shown in full inside the popup (wrapping onto a second
   line if needed) rather than being cut off. */
function openSubjectPickerModal(){
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop subject-modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal subject-picker-modal" role="dialog" aria-modal="true" aria-label="Select subject">
      <h3>📘 Select Subject</h3>
      <div class="search-input subject-picker-search">
        <span class="ic">🔍</span>
        <input id="subjectPickerSearch" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search subject code or name...">
      </div>
      <div class="subject-picker-list" id="subjectPickerList" role="listbox">
        ${activeSubjectsList().map(s=>`
          <button type="button" class="subject-picker-row ${s.code===state.today.subjectCode?'selected':''}"
            role="option" aria-selected="${s.code===state.today.subjectCode}" data-subject="${s.code}"
            data-search="${escapeHtml((s.code+' '+s.name).toLowerCase())}">
            <span class="spr-code">${escapeHtml(s.code)}</span>
            <span class="spr-main">
              <span class="spr-name">${escapeHtml(s.name)}</span>
              <span class="spr-faculty">${escapeHtml(s.faculty)}</span>
            </span>
            ${s.code===state.today.subjectCode?'<span class="spr-check">✔</span>':''}
          </button>`).join("")}
        <div class="so-empty" id="subjectPickerEmpty" style="display:none;">No subject matches</div>
      </div>
      <div class="actions"><button class="btn" id="subjectPickerCancel">Cancel</button></div>
    </div>`;
  document.body.appendChild(backdrop);

  const searchInput = backdrop.querySelector("#subjectPickerSearch");
  const rows = Array.from(backdrop.querySelectorAll(".subject-picker-row"));
  const emptyMsg = backdrop.querySelector("#subjectPickerEmpty");
  const btn = document.getElementById("subjectPickerBtn");
  if(btn) btn.setAttribute("aria-expanded","true");

  function close(){
    backdrop.remove();
    if(btn){ btn.setAttribute("aria-expanded","false"); btn.focus({preventScroll:true}); }
  }
  function choose(code){
    // Explicitly picking a subject should always resync faculty from the
    // subject record — set this *before* setSubject() so the auto-fill
    // inside it actually takes effect this time, even if a previous
    // session's faculty had been hand-edited.
    state.today.facultyManual = false;
    setSubject(code);
    close();
    // Subject/Faculty are just a label attached to whatever the live
    // attendance list currently is — setSubject() never touches
    // state.today.marks, so there's nothing to reload here. Still do a full
    // renderView() (same pattern used for Date changes) so the stat cards,
    // roster, and report panel all pick up the new subject/faculty label
    // together, in one go, with no partial/stale DOM patches.
    state.page = 1;
    renderView();
    toast("Subject selected — attendance carried forward","success");
  }

  rows.forEach(r=> r.addEventListener("click", ()=> choose(r.dataset.subject)));
  backdrop.querySelector("#subjectPickerCancel").onclick = close;
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) close(); });
  document.addEventListener("keydown", function escHandler(e){
    if(e.key==="Escape"){ document.removeEventListener("keydown", escHandler); if(document.body.contains(backdrop)) close(); }
  });

  searchInput.addEventListener("input", ()=>{
    const q = searchInput.value.trim().toLowerCase();
    let visible = 0;
    rows.forEach(r=>{
      const match = !q || r.dataset.search.includes(q);
      r.style.display = match ? "" : "none";
      if(match) visible++;
    });
    emptyMsg.style.display = visible ? "none" : "block";
  });

  // Do NOT auto-focus the search input here. Focusing it programmatically
  // on open is exactly what was forcing the mobile keyboard to pop up the
  // instant the popup appeared. The search box just sits there, visible,
  // until the user deliberately taps it — a plain tap on a plain <input>
  // opens the keyboard on its own, no extra code needed for that part.
  const selectedRow = rows.find(r=>r.dataset.subject===state.today.subjectCode);
  if(selectedRow) selectedRow.scrollIntoView({block:"nearest"});
}

function refreshReportPanel(){
  const stats = computeStats();
  const panel = document.querySelector(".report-panel");
  if(!panel) return;
  panel.outerHTML = renderReportPanel(stats);
  bindReportPanelEvents();
}

/* Single-tap attendance toggle — patches only the affected button, row,
   roster-filter counts, and report panel so tapping through a class list
   of 49 students stays smooth even on low-end Android devices (no full
   page re-render). */
function toggleAttendance(btn, evt){
  const id = btn.dataset.toggle;
  const wasPresent = state.today.marks[id] !== "absent";
  state.today.marks[id] = wasPresent ? "absent" : "present";
  const nowPresent = !wasPresent;
  saveLiveMarks();

  btn.classList.toggle("is-present", nowPresent);
  btn.classList.toggle("is-absent", !nowPresent);
  btn.textContent = nowPresent ? "✔ Present" : "❌ Absent";
  btn.closest("tr")?.classList.toggle("row-absent", !nowPresent);
  spawnRipple(btn, evt);

  const stats = computeStats();
  const filterSel = document.getElementById("rosterFilter");
  if(filterSel){
    filterSel.querySelector('option[value="present"]').textContent = `Present (${stats.present})`;
    filterSel.querySelector('option[value="absent"]').textContent = `Absent (${stats.absent})`;
  }
  // If the roster is currently filtered to present/absent only, the toggled
  // row needs a full re-render so it can drop out of the filtered list.
  if(state.rosterFilter !== "all"){ renderView(); return; }
  refreshReportPanel();
}
function spawnRipple(btn, evt){
  const circle = document.createElement("span");
  circle.className = "ripple";
  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const x = (evt && evt.clientX ? evt.clientX - rect.left : rect.width/2) - size/2;
  const y = (evt && evt.clientY ? evt.clientY - rect.top : rect.height/2) - size/2;
  circle.style.width = circle.style.height = size + "px";
  circle.style.left = x + "px";
  circle.style.top = y + "px";
  btn.appendChild(circle);
  circle.addEventListener("animationend", ()=> circle.remove());
}

function filteredRoster(){
  let list = activeStudents();
  const q = state.rosterSearch.trim().toLowerCase();
  if(q) list = list.filter(s => s.name.toLowerCase().includes(q) || s.rollNo.toLowerCase().includes(q));
  if(state.rosterFilter !== "all") list = list.filter(s => state.today.marks[s.id] === state.rosterFilter);
  return list;
}

function renderReportPanel(stats){
  const presentStudents = sortForRollDisplay(activeStudents().filter(s => state.today.marks[s.id] === "present"));
  const fmt = activeReportFormat();
  const subjLabel = escapeHtml(subjectLabel(findSubject(state.today.subjectCode)))||"—";
  return `
  <div class="panel report-panel">
    <h3>📄 Attendance Report</h3>
    <div class="report-body">
      <div class="report-info-list">
        <div class="report-info-row"><span class="rii-ic">📅</span><span class="rii-text"><span class="rii-lbl">Date:</span> <span class="rii-val">${formatDate(state.today.date)}</span></span></div>
        <div class="report-info-row"><span class="rii-ic">🕒</span><span class="rii-text"><span class="rii-lbl">Time:</span> <span class="rii-val">${currentTimeStr()}</span></span></div>
        <div class="report-info-row"><span class="rii-ic">📘</span><span class="rii-text"><span class="rii-lbl">Subject:</span> <span class="rii-val ellipsis-2" title="${subjLabel}">${subjLabel}</span></span></div>
        <div class="report-info-row"><span class="rii-ic">👨‍🏫</span><span class="rii-text"><span class="rii-lbl">Faculty:</span> <span class="rii-val">${escapeHtml(state.today.faculty)||"—"}</span></span></div>
      </div>
      <div class="report-divider"></div>
      <div class="report-info-list report-info-list-stats">
        <div class="report-info-row"><span class="rii-ic">👥</span><span class="rii-text"><span class="rii-lbl">Total Students:</span> <span class="rii-val">${stats.total}</span></span></div>
        <div class="report-info-row"><span class="rii-ic">✅</span><span class="rii-text"><span class="rii-lbl">Present:</span> <span class="rii-val" style="color:var(--green)">${stats.present}</span></span></div>
        <div class="report-info-row"><span class="rii-ic">❌</span><span class="rii-text"><span class="rii-lbl">Absent:</span> <span class="rii-val" style="color:var(--red)">${stats.total-stats.present}</span></span></div>
        <div class="report-info-row"><span class="rii-ic">📊</span><span class="rii-text"><span class="rii-lbl">Attendance:</span> <span class="rii-val" style="color:${stats.pct==100?'var(--green)':'var(--blue)'}">${stats.pct}%</span></span></div>
      </div>

      <div class="present-students-box">
        <div class="psb-head">✅ Present Students <span class="psb-count">(${presentStudents.length})</span></div>
        <ul class="absent-list">
          ${presentStudents.length ? presentStudents.map(s=>`<li style="color:var(--green);">${escapeHtml(s.name)} – ${escapeHtml(s.rollNo)}</li>`).join("") : `<li style="color:var(--text-faint)">None yet</li>`}
        </ul>
      </div>
      <div class="report-sign">Generated by ${escapeHtml(currentUser.fullName)}, Class Representative</div>

      <hr class="report-hr">
      <div class="share-toggle-row">
        <span class="share-toggle-label">📤 Share Preview</span>
        <div class="segmented-toggle">
          <button data-fmt="simple" class="${fmt==='simple'?'active':''}">Simple</button>
          <button data-fmt="detailed" class="${fmt==='detailed'?'active':''}">Detailed</button>
        </div>
      </div>
      <pre class="share-preview">${escapeHtml(buildReportText())}</pre>
    </div>
    <div class="report-actions">
      <button class="btn btn-primary" id="rpCopy"><i class="fa-regular fa-copy"></i> Copy Report</button>
      <button class="btn" style="background:#25D366;border-color:#25D366;color:#fff;" id="rpWa"><i class="fa-brands fa-whatsapp"></i> Share on WhatsApp</button>
      <button class="btn btn-purple" id="rpPdf"><i class="fa-regular fa-file-pdf"></i> Download PDF</button>
      <button class="btn btn-success" id="rpExcel"><i class="fa-regular fa-file-excel"></i> Download Excel</button>
      <button class="btn btn-success report-actions-full" id="rpSaveSession"><i class="fa-solid fa-circle-check"></i> Finalize & Save to History</button>
    </div>
  </div>`;
}

function shortRoll(rollNo){
  // 01/EE/24 -> 01 · 302/EE/24 -> 302 · 602/LE/EE/2025 -> 602 · 21/EE/23 stays as-is
  let m = rollNo.match(/^(\d+)\/EE\/24$/);
  if(m) return m[1];
  m = rollNo.match(/^(\d+)\/LE\/EE\/\d+$/);
  if(m) return m[1];
  return rollNo;
}
function rollGroupRank(rollNo){
  if(/^\d+\/EE\/24$/.test(rollNo)) return 0;      // regular batch — sorted numerically first
  if(/^\d+\/LE\/EE\/\d+$/.test(rollNo)) return 1; // Lateral Entry — numerically, after regular batch
  return 2;                                        // anything else (e.g. 21/EE/23) — always last
}
function rollNumericKey(rollNo){
  const m = rollNo.match(/^(\d+)/);
  return m ? parseInt(m[1],10) : Number.MAX_SAFE_INTEGER;
}
function sortForRollDisplay(students){
  return [...students].sort((a,b)=>{
    const ra = rollGroupRank(a.rollNo), rb = rollGroupRank(b.rollNo);
    if(ra!==rb) return ra-rb;
    const na = rollNumericKey(a.rollNo), nb = rollNumericKey(b.rollNo);
    if(na!==nb) return na-nb;
    return a.rollNo.localeCompare(b.rollNo);
  });
}
function rollListText(students){
  return sortForRollDisplay(students).map(s=>shortRoll(s.rollNo)).join(", ");
}
function activeReportFormat(){ return state.reportFormatOverride || DB.settings.reportFormat || "simple"; }

function buildReportText(){
  return activeReportFormat() === "detailed" ? buildDetailedReportText() : buildSimpleReportText();
}
function buildSimpleReportText(){
  const subj = findSubject(state.today.subjectCode);
  const present = activeStudents().filter(s => state.today.marks[s.id] !== "absent");
  let txt = `📌 Subject: ${subjectLabel(subj) || ""}\n`;
  txt += `📅 Date: ${formatDate(state.today.date)}\n\n`;
  txt += `✅ Present Roll Nos:\n${rollListText(present) || "None"}`;
  return txt;
}
function buildDetailedReportText(){
  const stats = computeStats();
  const subj = findSubject(state.today.subjectCode);
  const present = activeStudents().filter(s => state.today.marks[s.id] !== "absent");
  const absent = activeStudents().filter(s => state.today.marks[s.id] === "absent");
  let txt = `📌 Subject: ${subjectLabel(subj) || ""}\n👨‍🏫 Faculty: ${state.today.faculty}\n`;
  txt += `📅 Date: ${formatDate(state.today.date)}\n🕒 Time: ${currentTimeStr()}\n\n`;
  txt += `👥 Total Students: ${stats.total}\n✅ Total Present: ${stats.present}\n❌ Total Absent: ${stats.total - stats.present}\n📊 Attendance: ${stats.pct}%\n\n`;
  txt += `✅ Present Roll Nos:\n${rollListText(present) || "None"}\n\n`;
  txt += `❌ Absent Roll Nos:\n${rollListText(absent) || "None"}`;
  return txt;
}
function formatDate(iso){
  const [y,m,d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function bindAttendanceEvents(){
  document.getElementById("fDate").onchange = e => { state.today.date = e.target.value; loadOrResetMarksForSession(); renderView(); };
  document.getElementById("todayBtn").onclick = ()=>{ state.today.date = new Date().toISOString().slice(0,10); loadOrResetMarksForSession(); renderView(); };

  document.getElementById("subjectPickerBtn").onclick = openSubjectPickerModal;
  document.getElementById("fFaculty").oninput = e => { state.today.faculty = e.target.value; state.today.facultyManual = true; };
  const cancelEditBtn = document.getElementById("cancelEditRecord");
  if(cancelEditBtn) cancelEditBtn.onclick = ()=>{ state.editingRecord = null; renderView(); };

  document.getElementById("rosterSearch").oninput = e => { state.rosterSearch = e.target.value; state.page=1; renderView(); };
  document.getElementById("rosterFilter").onchange = e => { state.rosterFilter = e.target.value; state.page=1; renderView(); };

  document.getElementById("markAllPresent").onclick = ()=>{ activeStudents().forEach(s=>state.today.marks[s.id]="present"); saveLiveMarks(); toast("All students marked Present","success"); renderView(); };
  document.getElementById("markAllAbsent").onclick = ()=>{ activeStudents().forEach(s=>state.today.marks[s.id]="absent"); saveLiveMarks(); toast("All students marked Absent","success"); renderView(); };
  document.getElementById("resetAttendanceBtn").onclick = async ()=>{
    const ok = await confirmModal({title:"Reset attendance?", message:"Every student in today's session will be set back to Absent.", confirmText:"Reset"});
    if(ok){ state.today.marks = {}; ensureMarksSeeded(); saveLiveMarks(); toast("Attendance reset","info"); renderView(); }
  };
  document.getElementById("generateReportBtn").onclick = ()=>{
    toast("Report generated","success"); addLog("Attendance report generated");
    document.querySelector(".report-panel")?.scrollIntoView({behavior:"smooth", block:"start"});
  };

  document.querySelectorAll("[data-toggle]").forEach(b=>{
    b.onclick = (e)=> toggleAttendance(b, e);
  });
  document.querySelectorAll("[data-page]").forEach(b=>{
    b.onclick = ()=>{ state.page = parseInt(b.dataset.page); renderView(); };
  });
  bindRosterSwipe();

  document.getElementById("qaAddBtn").onclick = ()=>{
    const missing = validateRequired([
      {id:"qaName", label:"Name"}, {id:"qaRoll", label:"Class Roll No."},
      {id:"qaReg", label:"Registration No."}, {id:"qaBoardRoll", label:"Board Roll No."}
    ]);
    if(missing.length){ toast(`Please fill in: ${missing.join(", ")}.`,"error"); return; }
    const name = document.getElementById("qaName").value.trim();
    const roll = document.getElementById("qaRoll").value.trim();
    const reg = document.getElementById("qaReg").value.trim();
    const boardRoll = document.getElementById("qaBoardRoll").value.trim();
    const dupeRoll = activeStudents().find(s=>s.rollNo.toLowerCase()===roll.toLowerCase());
    if(dupeRoll){ toast("A student with this Class Roll No. already exists","error"); return; }
    const dupeReg = activeStudents().find(s=>(s.regNo||"").toLowerCase()===reg.toLowerCase());
    if(dupeReg){ toast("A student with this Registration No. already exists","error"); return; }
    const dupeBoard = activeStudents().find(s=>(s.boardRoll||"").toLowerCase()===boardRoll.toLowerCase());
    if(dupeBoard){ toast("A student with this Board Roll No. already exists","error"); return; }
    addStudent({ name, rollNo: roll, regNo: reg, boardRoll });
    ensureMarksSeeded();
    saveLiveMarks();
    toast(`${name} added`, "success");
    renderView();
  };

  bindReportPanelEvents();
}

/* ---------------------------------------------------------
   ROSTER SWIPE NAVIGATION — horizontal swipe over the student list changes
   pages like a gallery/slideshow (swipe left = next page, swipe right =
   previous page). Scoped entirely to #rosterTableWrap, so it never touches
   scrolling, taps on the Present/Absent toggle, or anything outside the
   student list. Pointer Events cover touch, mouse, and pen in one code path.
--------------------------------------------------------- */
function bindRosterSwipe(){
  const wrap = document.getElementById("rosterTableWrap");
  if(!wrap) return;
  const SWIPE_THRESHOLD = 50; // min horizontal distance (px) to count as a page-change swipe
  const DIRECTION_RATIO = 1.4; // how much more horizontal than vertical movement is required
  let tracking = false, horizontal = false, pointerId = null, startX = 0, startY = 0;

  wrap.addEventListener("pointerdown", e=>{
    if(e.pointerType === "mouse" && e.button !== 0) return;
    tracking = true; horizontal = false; pointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY;
  });
  wrap.addEventListener("pointermove", e=>{
    if(!tracking || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if(!horizontal && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * DIRECTION_RATIO){
      horizontal = true; // a clear horizontal drag — take over from vertical scroll/text-selection
    }
    if(horizontal) e.preventDefault(); // only once it's unambiguously a swipe, never during normal scrolling
  }, { passive:false });
  const endSwipe = (e)=>{
    if(!tracking || e.pointerId !== pointerId) return;
    tracking = false;
    if(!horizontal) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if(Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * DIRECTION_RATIO) return;
    const totalPages = Math.max(1, Math.ceil(filteredRoster().length / state.pageSize));
    if(dx < 0 && state.page < totalPages) goToRosterPage(state.page + 1, "next");
    else if(dx > 0 && state.page > 1) goToRosterPage(state.page - 1, "prev");
  };
  wrap.addEventListener("pointerup", endSwipe);
  wrap.addEventListener("pointercancel", ()=>{ tracking = false; });
}

// Changes state.page with a brief slide-out/slide-in animation, exactly like
// clicking a page number (same state.page + renderView(), so search, filter,
// and every attendance mark are left completely untouched) — just with a
// transition instead of an instant swap.
function goToRosterPage(page, direction){
  const wrap = document.getElementById("rosterTableWrap");
  if(!wrap){ state.page = page; renderView(); return; }
  wrap.classList.add(direction === "next" ? "roster-exit-to-left" : "roster-exit-to-right");
  state._rosterEnterAnim = direction; // read once by renderAttendance(), see above
  window.setTimeout(()=>{ state.page = page; renderView(); }, 140);
}

function bindReportPanelEvents(){
  document.getElementById("rpCopy").onclick = async ()=>{
    await navigator.clipboard.writeText(buildReportText());
    toast("Report copied to clipboard","success");
  };
  document.getElementById("rpWa").onclick = ()=>{
    window.open(`https://wa.me/?text=${encodeURIComponent(buildReportText())}`, "_blank");
  };
  document.querySelectorAll("[data-fmt]").forEach(b=>{
    b.onclick = ()=>{ state.reportFormatOverride = b.dataset.fmt; refreshReportPanel(); };
  });
  document.getElementById("rpPdf").onclick = ()=>{
    toast("Choose \"Save as PDF\" as the destination in the print dialog","info");
    printReport();
  };
  document.getElementById("rpExcel").onclick = ()=>{
    const stats = computeStats();
    const subj = findSubject(state.today.subjectCode);
    const present = sortForRollDisplay(activeStudents().filter(s => state.today.marks[s.id] !== "absent"));
    const absent = sortForRollDisplay(activeStudents().filter(s => state.today.marks[s.id] === "absent"));
    const ok = exportReportXlsx({
      subject: subj || {code:"",name:""}, date: formatDate(state.today.date), time: currentTimeStr(),
      faculty: state.today.faculty, total: stats.total, present: stats.present, absent: stats.absent, pct: stats.pct,
      presentRolls: rollListText(present), absentRolls: rollListText(absent),
      presentList: present, absentList: absent
    });
    if(ok) toast("Excel downloaded","success");
  };
  document.getElementById("rpSaveSession").onclick = ()=> saveSessionToHistory();
}
// Complete, professional Attendance Report for PDF/print — always the FULL
// report (institution/department header, subject+faculty+date+time,
// summary counts, present & absent student tables with roll numbers,
// generated timestamp), independent of the Simple/Detailed Share Preview
// toggle. Copy Report / Share on WhatsApp use buildReportText() (the
// toggle-driven Share Preview) — this is a deliberately different, richer
// document, built fresh from the same live attendance state.
const REPORT_PRINT_CSS = `
  @page { size: A4 portrait; margin: 16mm 14mm; }
  *{ box-sizing:border-box; }
  body{ font-family: Arial, Helvetica, sans-serif; color:#1a1a2e; margin:0; padding:0; }
  .rp-header{ text-align:center; margin-bottom:14px; }
  .rp-header h1{ margin:0; font-size:20px; font-weight:800; }
  .rp-header h2{ margin:2px 0 0; font-size:13px; font-weight:600; color:#333; }
  .rp-header h3{ margin:10px 0 0; font-size:16px; font-weight:700; text-decoration:underline; text-underline-offset:3px; }
  table.rp-meta, table.rp-summary{ width:100%; border-collapse:collapse; margin-bottom:12px; font-size:12px; }
  table.rp-meta td, table.rp-summary td{ border:1px solid #999; padding:6px 8px; }
  table.rp-meta td:nth-child(odd), table.rp-summary td:nth-child(odd){ font-weight:700; background:#f2f2f2; width:15%; }
  h4{ margin:16px 0 6px; font-size:13.5px; }
  table.rp-table{ width:100%; border-collapse:collapse; font-size:11.5px; margin-bottom:6px; }
  table.rp-table th, table.rp-table td{ border:1px solid #999; padding:4px 6px; text-align:center; }
  table.rp-table th{ background:#1F3864; color:#fff; }
  table.rp-table td.pt-left{ text-align:left; }
  td.pt-empty{ text-align:center; color:#888; font-style:italic; }
  .rp-rolls{ font-size:11px; margin:0 0 10px; }
  .rp-generated{ margin-top:20px; font-size:10.5px; color:#666; text-align:right; }
  @media print{ body{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
`;
function buildFullReportHtml(){
  const stats = computeStats();
  const subj = findSubject(state.today.subjectCode);
  const present = sortForRollDisplay(activeStudents().filter(s => state.today.marks[s.id] !== "absent"));
  const absent = sortForRollDisplay(activeStudents().filter(s => state.today.marks[s.id] === "absent"));
  const now = new Date();
  const generatedStr = `${now.toLocaleDateString()} ${now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
  const studentRows = list => list.map((s,i)=>`<tr><td>${i+1}</td><td class="pt-left">${escapeHtml(s.name)}</td><td>${escapeHtml(s.rollNo)}</td></tr>`).join("")
    || `<tr><td colspan="3" class="pt-empty">None</td></tr>`;
  return `
  <div class="rp-header">
    <h1>Your Institution</h1>
    <h2>Your Department</h2>
    <h3>Attendance Report</h3>
  </div>
  <table class="rp-meta">
    <tr><td>Subject</td><td>${escapeHtml(subjectLabel(subj))}</td><td>Faculty</td><td>${escapeHtml(state.today.faculty)||"—"}</td></tr>
    <tr><td>Date</td><td>${formatDate(state.today.date)}</td><td>Time</td><td>${currentTimeStr()}</td></tr>
  </table>
  <table class="rp-summary">
    <tr><td>Total Students</td><td>${stats.total}</td><td>Total Present</td><td>${stats.present}</td><td>Total Absent</td><td>${stats.absent}</td><td>Attendance %</td><td>${stats.pct}%</td></tr>
  </table>
  <h4>✅ Present Students (${present.length})</h4>
  <table class="rp-table"><thead><tr><th>S.No</th><th>Name</th><th>Roll No</th></tr></thead><tbody>${studentRows(present)}</tbody></table>
  <p class="rp-rolls"><b>Present Roll Numbers:</b> ${escapeHtml(rollListText(present)||"—")}</p>
  <h4>❌ Absent Students (${absent.length})</h4>
  ${absent.length
    ? `<table class="rp-table"><thead><tr><th>S.No</th><th>Name</th><th>Roll No</th></tr></thead><tbody>${studentRows(absent)}</tbody></table>
       <p class="rp-rolls"><b>Absent Roll Numbers:</b> ${escapeHtml(rollListText(absent)||"—")}</p>`
    : `<p class="rp-rolls">No absentees — full attendance.</p>`}
  <p class="rp-generated">Generated: ${generatedStr}</p>
  `;
}
function printReport(){
  const w = window.open("", "_blank");
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Attendance Report — ${escapeHtml(state.today.date)}</title>
    <style>${REPORT_PRINT_CSS}</style></head><body>${buildFullReportHtml()}</body></html>`);
  w.document.close();
  w.print();
}

// Student "My Attendance" → Export → PDF. Same window.open + print()
// pattern as printReport() above ("Save as PDF" in the browser's print
// dialog) — built from the exact same buildMyAttendanceExportData() the
// Excel export uses, so the two documents always show the same numbers.
// A4 LANDSCAPE, with a running header/footer that repeats on every
// printed page (via the <thead>/<tfoot> "table-header/footer-group"
// technique, since @page margin-box content isn't reliably supported
// across browsers) and the full subject-wise attendance log grouped by
// subject, mirroring the two-sheet Excel export's structure.
const MY_ATTENDANCE_PRINT_CSS = `
  @page { size: A4 landscape; margin: 14mm 12mm 16mm; }
  *{ box-sizing:border-box; }
  body{ font-family: Arial, Helvetica, sans-serif; color:#1a1a2e; margin:0; padding:0; font-size:11.5px; }
  .print-shell{ width:100%; border-collapse:collapse; }
  .print-shell > thead{ display:table-header-group; }
  .print-shell > tfoot{ display:table-footer-group; }
  .run-header{ display:flex; justify-content:space-between; align-items:baseline; border-bottom:2px solid #1F3864; padding-bottom:6px; margin-bottom:10px; }
  .run-header .rh-title{ font-size:15px; font-weight:800; color:#1F3864; }
  .run-header .rh-sub{ font-size:10.5px; color:#555; }
  .run-footer{ border-top:1px solid #ccc; padding-top:4px; margin-top:6px; font-size:9.5px; color:#777; display:flex; justify-content:space-between; }
  .rp-header{ text-align:center; margin-bottom:12px; }
  .rp-header h1{ margin:0; font-size:18px; font-weight:800; color:#17365D; }
  .rp-header h2{ margin:2px 0 0; font-size:14px; font-weight:700; color:#17365D; }
  .rp-header h3{ margin:6px 0 0; font-size:12px; font-weight:600; color:#555; letter-spacing:.03em; }
  table.rp-meta, table.rp-summary{ width:100%; border-collapse:collapse; margin-bottom:10px; font-size:11.5px; }
  table.rp-meta td, table.rp-summary td{ border:1px solid #999; padding:5px 8px; }
  table.rp-meta td:nth-child(odd), table.rp-summary td:nth-child(odd){ font-weight:700; background:#f2f2f2; width:16%; }
  h4.rp-section{ margin:14px 0 6px; font-size:13px; background:#EDF1F8; padding:5px 8px; border-left:4px solid #1F3864; }
  table.rp-table{ width:100%; border-collapse:collapse; font-size:11px; margin-bottom:6px; }
  table.rp-table th, table.rp-table td{ border:1px solid #999; padding:4px 6px; text-align:center; }
  table.rp-table th{ background:#1F3864; color:#fff; }
  table.rp-table td.pt-left{ text-align:left; }
  .rp-status-good{ color:#1fa971; font-weight:700; }
  .rp-status-attention{ color:#e0932f; font-weight:700; }
  .rp-status-shortage{ color:#e5484d; font-weight:700; }
  .rp-status-present{ color:#1fa971; font-weight:700; }
  .rp-status-absent{ color:#e5484d; font-weight:700; }
  .rp-generated{ margin-top:14px; font-size:10px; color:#666; text-align:right; }
  .print-page-break{ break-before:page; }
  .subject-block{ margin-bottom:14px; }
  .subject-block-head{ break-after:avoid; break-inside:avoid; }
  .subject-code{ font-size:12.5px; font-weight:800; color:#1F3864; font-family:'Courier New',monospace; }
  .subject-name{ font-size:13.5px; font-weight:700; margin-top:1px; }
  .subject-faculty{ font-size:10.5px; color:#555; margin-top:1px; margin-bottom:5px; }
  table.rp-log-table{ width:100%; border-collapse:collapse; font-size:10.5px; }
  table.rp-log-table thead{ display:table-header-group; }
  table.rp-log-table th, table.rp-log-table td{ border:1px solid #bbb; padding:3px 6px; text-align:center; }
  table.rp-log-table th{ background:#2E4C82; color:#fff; }
  .subject-total{ break-before:avoid; background:#F2F4F8; border:1px solid #ccc; border-top:none; padding:5px 8px; font-size:11px; font-weight:700; }
  .subject-sep{ border-top:2px dashed #ccc; margin:12px 0; }
  @media print{ body{ -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
`;
function statusRowClass(status){
  return status==="Good" ? "rp-status-good" : status==="Attention" ? "rp-status-attention" : "rp-status-shortage";
}
function buildMyAttendanceReportBody(data){
  return `
  <div class="rp-header">
    <h1>${escapeHtml(INSTITUTION_LINE1)}</h1>
    <h2>${escapeHtml(INSTITUTION_LINE2)}</h2>
    <h3>My Attendance Report</h3>
  </div>
  <table class="rp-meta">
    <tr><td>Student Name</td><td>${escapeHtml(data.studentName)}</td><td>Roll Number</td><td>${escapeHtml(data.rollNo)}</td></tr>
    <tr><td>Generated</td><td colspan="3">${escapeHtml(data.generated)}</td></tr>
  </table>
  <table class="rp-summary">
    <tr><td>Classes Conducted</td><td>${data.overall.conducted}</td><td>Present</td><td>${data.overall.present}</td></tr>
    <tr><td>Absent</td><td>${data.overall.absent}</td><td>Overall Attendance</td><td>${data.overall.conducted ? data.overall.pct.toFixed(2)+"%" : "—"}</td></tr>
  </table>
  <h4 class="rp-section">Subject-wise Attendance</h4>
  <table class="rp-table">
    <thead><tr><th>Subject Code</th><th>Subject</th><th>Faculty</th><th>Present</th><th>Conducted</th><th>Absent</th><th>Attendance %</th><th>Status</th></tr></thead>
    <tbody>
      ${data.subjects.map(s=>`<tr><td>${escapeHtml(s.code)}</td><td class="pt-left">${escapeHtml(s.name)}</td><td class="pt-left">${escapeHtml(s.faculty)}</td><td>${s.present}</td><td>${s.conducted}</td><td>${s.absent}</td><td>${s.pct.toFixed(2)}%</td><td class="${statusRowClass(s.status)}">${escapeHtml(s.status)}</td></tr>`).join("") || `<tr><td colspan="8">No attendance recorded yet.</td></tr>`}
    </tbody>
  </table>

  <div class="print-page-break"></div>
  <h4 class="rp-section">Attendance Log — Subject-wise</h4>
  <p style="font-size:11px;margin:0 0 10px;"><b>Student:</b> ${escapeHtml(data.studentName)} (${escapeHtml(data.rollNo)})</p>
  ${data.log.map((sub,i)=>`
    <div class="subject-block">
      <div class="subject-block-head">
        <div class="subject-code">${escapeHtml(sub.code)}</div>
        <div class="subject-name">${escapeHtml(sub.name)}</div>
        <div class="subject-faculty">Faculty: ${escapeHtml(sub.faculty)}</div>
      </div>
      <table class="rp-log-table">
        <thead><tr><th style="width:22%;">Date</th><th style="width:28%;">Day</th><th>Status</th></tr></thead>
        <tbody>
          ${sub.sessions.map(s=>`<tr><td>${isoToDDMMMYYYYDisplay(s.date)}</td><td>${isoToDayNameDisplay(s.date)}</td><td class="${s.status==='Present'?'rp-status-present':'rp-status-absent'}">${escapeHtml(s.status)}</td></tr>`).join("") || `<tr><td colspan="3">No sessions recorded</td></tr>`}
        </tbody>
      </table>
      <div class="subject-total">Subject Total — Conducted: ${sub.conducted} &nbsp; Present: ${sub.present} &nbsp; Absent: ${sub.absent} &nbsp; Attendance: ${sub.pct.toFixed(2)}%</div>
    </div>
    ${i < data.log.length-1 ? `<div class="subject-sep"></div>` : ""}
  `).join("") || `<p style="font-size:11px;">No attendance recorded yet.</p>`}
  <div class="rp-generated">Generated: ${escapeHtml(data.generated)}</div>`;
}
function isoToDDMMMYYYYDisplay(iso){
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [y,m,d] = iso.split("-");
  return `${d}-${MONTHS[parseInt(m,10)-1]}-${y}`;
}
function isoToDayNameDisplay(iso){
  const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  return DAYS[new Date(iso+"T00:00:00").getDay()];
}
function printMyAttendanceReport(data){
  const w = window.open("", "_blank");
  // Content is wrapped in one long <table> with a repeating <thead>/
  // <tfoot> (run-header/run-footer) — the only technique that reliably
  // repeats custom header/footer content on every printed page across
  // browsers. A live "Page X of Y" count is NOT included here: browsers
  // don't expose total page count to page content (only their own
  // print-preview UI can show it) — if you need page numbers on the
  // PDF itself, enable "Headers and footers" in the browser's print
  // dialog, which adds them independently of this layout.
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>My Attendance Report — ${escapeHtml(data.studentName)}</title>
    <style>${MY_ATTENDANCE_PRINT_CSS}</style></head><body>
    <table class="print-shell">
      <thead><tr><td>
        <div class="run-header">
          <span class="rh-title">My Attendance Report</span>
          <span class="rh-sub">${escapeHtml(data.studentName)} (${escapeHtml(data.rollNo)})</span>
        </div>
      </td></tr></thead>
      <tfoot><tr><td>
        <div class="run-footer"><span>My Attendance Report</span><span>${escapeHtml(data.studentName)}</span></div>
      </td></tr></tfoot>
      <tbody><tr><td>${buildMyAttendanceReportBody(data)}</td></tr></tbody>
    </table>
  </body></html>`;
  w.document.write(html);
  w.document.close();
  w.print();
}

async function saveSessionToHistory(){
  const stats = computeStats();
  const subj = findSubject(state.today.subjectCode);
  const absentees = sortForRollDisplay(activeStudents().filter(s => state.today.marks[s.id] === "absent")).map(s=>({rollNo:s.rollNo,name:s.name}));
  const newSubjectCode = subj?.code || "";
  const newDate = state.today.date;
  const newTime = currentTimeStr();

  // Are we correcting a previously-saved record via Edit Attendance, and did
  // the Subject and/or Date get changed away from what it was originally
  // saved under? If so the ORIGINAL record must be moved/merged rather than
  // left behind — otherwise fixing a "wrong subject" mistake would just
  // create a second, correct record while the wrong one still lingers.
  const editingRecord = state.editingRecord ? DB.sessions.find(s => s.id === state.editingRecord.id && !s.deleted) : null;
  const movedAway = !!(editingRecord && (editingRecord.subjectCode !== newSubjectCode || editingRecord.date !== newDate));
  const movedFromLabel = movedAway ? `${editingRecord.subjectCode||""} ${editingRecord.subject||""} · ${formatDate(editingRecord.date)}` : null;

  if(editingRecord && !movedAway){
    // Plain correction: same Subject + Date, just fixing marks. Always
    // update THIS exact record by id — never re-match by Subject+Date,
    // because there can legitimately be several OTHER sessions for this
    // same subject/date now (different periods/lectures), and matching by
    // Subject+Date alone would risk silently overwriting the wrong one.
    editingRecord.editHistory = editingRecord.editHistory || [];
    editingRecord.editHistory.unshift({
      at: new Date().toISOString(), by: currentUser.fullName,
      prev: { present: editingRecord.present, absent: editingRecord.absent, total: editingRecord.total, pct: editingRecord.pct },
      next: { present: stats.present, absent: stats.absent, total: stats.total, pct: stats.pct }
    });
    editingRecord.time = newTime; editingRecord.faculty = state.today.faculty;
    editingRecord.total = stats.total; editingRecord.present = stats.present; editingRecord.absent = stats.absent; editingRecord.pct = stats.pct;
    editingRecord.absentees = absentees; editingRecord.marks = {...state.today.marks};
    editingRecord.updatedBy = currentUser.fullName; editingRecord.updatedAt = Date.now();
    editingRecord.version = (editingRecord.version||1) + 1;
    saveDB(DB, {immediate:true});
    addLog(`Attendance updated (${newSubjectCode} ${subj?.name||""}, ${formatDate(newDate)}) — ${stats.present}/${stats.total} present`);
    toast("Attendance updated","success");
  } else if(editingRecord && movedAway){
    // Correcting a mistaken Subject/Date on a deliberate Edit — this is
    // never ambiguous (the person explicitly changed subject/date and hit
    // Save), so it merges/retags without a duplicate warning. Only merges
    // into another record if one already exists at the exact corrected
    // Subject+Date+Time; otherwise it just retags this record in place.
    const existingAtTarget = DB.sessions.find(s => !s.deleted && s.id !== editingRecord.id && s.subjectCode===newSubjectCode && s.date===newDate && s.time===newTime);
    if(existingAtTarget){
      existingAtTarget.editHistory = existingAtTarget.editHistory || [];
      existingAtTarget.editHistory.unshift({
        at: new Date().toISOString(), by: currentUser.fullName,
        prev: { present: existingAtTarget.present, absent: existingAtTarget.absent, total: existingAtTarget.total, pct: existingAtTarget.pct },
        next: { present: stats.present, absent: stats.absent, total: stats.total, pct: stats.pct },
        movedFrom: movedFromLabel
      });
      existingAtTarget.faculty = state.today.faculty;
      existingAtTarget.total = stats.total; existingAtTarget.present = stats.present; existingAtTarget.absent = stats.absent; existingAtTarget.pct = stats.pct;
      existingAtTarget.absentees = absentees; existingAtTarget.marks = {...state.today.marks};
      existingAtTarget.updatedBy = currentUser.fullName; existingAtTarget.updatedAt = Date.now();
      existingAtTarget.version = (existingAtTarget.version||1) + 1;
      editingRecord.deleted = true; editingRecord.updatedAt = Date.now(); editingRecord.deletedAt = Date.now();
      editingRecord.version = (editingRecord.version||1) + 1;
      editingRecord.editHistory = editingRecord.editHistory || [];
      editingRecord.editHistory.unshift({
        at: new Date().toISOString(), by: currentUser.fullName,
        prev: { present: editingRecord.present, absent: editingRecord.absent, total: editingRecord.total, pct: editingRecord.pct },
        next: { present: editingRecord.present, absent: editingRecord.absent, total: editingRecord.total, pct: editingRecord.pct },
        movedTo: `${newSubjectCode} ${subj?.name||""} · ${formatDate(newDate)}`
      });
      addLog(`Attendance corrected: ${movedFromLabel} merged into ${newSubjectCode} ${subj?.name||""} ${formatDate(newDate)}`);
      toast("Attendance corrected — merged into the existing record for that subject/date/time","success");
    }else{
      editingRecord.editHistory = editingRecord.editHistory || [];
      editingRecord.editHistory.unshift({
        at: new Date().toISOString(), by: currentUser.fullName,
        prev: { present: editingRecord.present, absent: editingRecord.absent, total: editingRecord.total, pct: editingRecord.pct },
        next: { present: stats.present, absent: stats.absent, total: stats.total, pct: stats.pct },
        movedFrom: movedFromLabel
      });
      editingRecord.subjectCode = newSubjectCode; editingRecord.subject = subj?.name || "";
      editingRecord.date = newDate; editingRecord.time = newTime; editingRecord.faculty = state.today.faculty;
      editingRecord.total = stats.total; editingRecord.present = stats.present; editingRecord.absent = stats.absent; editingRecord.pct = stats.pct;
      editingRecord.absentees = absentees; editingRecord.marks = {...state.today.marks};
      editingRecord.updatedBy = currentUser.fullName; editingRecord.updatedAt = Date.now();
      editingRecord.version = (editingRecord.version||1) + 1;
      addLog(`Attendance corrected: moved from ${movedFromLabel} to ${newSubjectCode} ${subj?.name||""} ${formatDate(newDate)}`);
      toast("Attendance corrected — moved to the right subject/date","success");
    }
    saveDB(DB, {immediate:true});
  } else {
    // Not editing — a brand-new attendance session. Multiple sessions for
    // the same Subject+Date are expected (different periods/lectures) and
    // must never silently merge into one another. Only an EXACT repeat —
    // same Subject, Date, AND time-of-day — looks like an accidental
    // double-save, so that (and only that) gets a warning; anything else
    // always saves as its own new session.
    const exactDuplicate = DB.sessions.find(s => !s.deleted && s.subjectCode===newSubjectCode && s.date===newDate && s.time===newTime);
    if(exactDuplicate){
      const proceed = await confirmDuplicateSessionModal(subj, newDate, newTime);
      if(!proceed){ toast("Save cancelled","info"); return; }
      exactDuplicate.editHistory = exactDuplicate.editHistory || [];
      exactDuplicate.editHistory.unshift({
        at: new Date().toISOString(), by: currentUser.fullName,
        prev: { present: exactDuplicate.present, absent: exactDuplicate.absent, total: exactDuplicate.total, pct: exactDuplicate.pct },
        next: { present: stats.present, absent: stats.absent, total: stats.total, pct: stats.pct }
      });
      exactDuplicate.faculty = state.today.faculty;
      exactDuplicate.total = stats.total; exactDuplicate.present = stats.present; exactDuplicate.absent = stats.absent; exactDuplicate.pct = stats.pct;
      exactDuplicate.absentees = absentees; exactDuplicate.marks = {...state.today.marks};
      exactDuplicate.updatedBy = currentUser.fullName; exactDuplicate.updatedAt = Date.now();
      exactDuplicate.version = (exactDuplicate.version||1) + 1;
      saveDB(DB, {immediate:true});
      addLog(`Attendance updated (${newSubjectCode} ${subj?.name||""}, ${formatDate(newDate)}) — ${stats.present}/${stats.total} present`);
      toast("Attendance updated","success");
    }else{
      const record = {
        id: "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2,8),
        date: newDate, time: newTime,
        subjectCode: newSubjectCode, subject: subj?.name || "", faculty: state.today.faculty,
        total: stats.total, present: stats.present, absent: stats.absent, pct: stats.pct,
        absentees, marks: {...state.today.marks}, savedBy: currentUser.fullName, savedAt: new Date().toISOString(),
        updatedAt: Date.now(), version: 1, deletedAt: null,
        deleted: false, editHistory: []
      };
      DB.sessions.unshift(record);
      saveDB(DB, {immediate:true});
      addLog(`Attendance marked (${newSubjectCode} ${subj?.name||""}, ${formatDate(newDate)}) — ${stats.present}/${stats.total} present`);
      toast("Attendance saved successfully","success");
    }
  }
  state.editingRecord = null;
}

function confirmDuplicateSessionModal(subj, date, time){
  return new Promise(resolve=>{
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>⚠️ This attendance session already exists</h3>
        <div class="sub" style="line-height:1.8;">
          <div>A session for <b>${escapeHtml(subjectLabel(subj))}</b> on <b>${formatDate(date)}</b> at <b>${escapeHtml(time)}</b> is already saved.</div>
          <div style="margin-top:8px;">If this is a different period/lecture, go back and adjust the time before saving so it's kept separate. If it's the same class, Overwrite updates that existing record instead of creating a duplicate.</div>
        </div>
        <div class="actions">
          <button class="btn" id="mCancel">Cancel</button>
          <button class="btn btn-primary" id="mOk">Overwrite Existing</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector("#mCancel").onclick = ()=>{ backdrop.remove(); resolve(false); };
    backdrop.querySelector("#mOk").onclick = ()=>{ backdrop.remove(); resolve(true); };
    backdrop.addEventListener("click", e=>{ if(e.target===backdrop){ backdrop.remove(); resolve(false); } });
  });
}

/* ---------------------------------------------------------
   ATTENDANCE CORRECTION — EDIT & DELETE A SAVED RECORD
   A saved record is uniquely identified by its own id — NOT by Subject +
   Date, since multiple sessions (different periods/lectures) can share the
   same Subject + Date (see saveSessionToHistory). Editing jumps to the Mark
   Attendance page with that exact subject and date preloaded (and that
   record's own marks, not whatever the live list currently holds); Finalize
   & Save then updates THIS record by id, so it can never bleed into or
   overwrite another session for the same subject/date.
   Deleting removes only that specific record (soft-delete: it moves to the
   Deleted tab in History and can be restored from there). Both actions are
   Admin/Teacher-only; students only ever see a read-only view.
--------------------------------------------------------- */
function editSessionRecord(id){
  if(!isAdmin()){ toast("Only Admin/Teacher can edit attendance records","error"); return; }
  const r = DB.sessions.find(x=>x.id===id && !x.deleted);
  if(!r){ toast("Attendance record not found","error"); return; }
  state.today.date = r.date;
  setSubject(r.subjectCode);
  state.today.faculty = r.faculty || state.today.faculty;
  state.today.facultyManual = true;
  state.today.marks = {...(r.marks||{})};
  ensureMarksSeeded();
  saveLiveMarks();
  state.editingRecord = { id: r.id, subjectCode: r.subjectCode, subject: r.subject, date: r.date };
  state.view = "attendance";
  state.page = 1;
  render();
  toast(`Editing ${r.subjectCode?r.subjectCode+" – ":""}${r.subject} · ${formatDate(r.date)}. Adjust Present/Absent, then Finalize & Save.`,"info");
}

function confirmDeleteAttendanceModal(r){
  return new Promise(resolve=>{
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>Delete this attendance record?</h3>
        <div class="sub" style="line-height:1.8;">
          <div><b>Subject:</b><br>${escapeHtml(r.subjectCode?r.subjectCode+" – ":"")}${escapeHtml(r.subject)}</div>
          <div style="margin-top:8px;"><b>Date:</b><br>${formatDate(r.date)}</div>
          <div style="margin-top:10px;color:var(--amber);font-weight:600;">It moves to Deleted Attendance and can be restored by an Admin/Teacher anytime.</div>
        </div>
        <div class="actions">
          <button class="btn" id="mCancel">Cancel</button>
          <button class="btn btn-danger" id="mOk">Delete</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector("#mCancel").onclick = ()=>{ backdrop.remove(); resolve(false); };
    backdrop.querySelector("#mOk").onclick = ()=>{ backdrop.remove(); resolve(true); };
    backdrop.addEventListener("click", e=>{ if(e.target===backdrop){ backdrop.remove(); resolve(false); } });
  });
}

async function deleteSessionRecord(id){
  if(!isAdmin()){ toast("Only Admin/Teacher can delete attendance records","error"); return; }
  const r = DB.sessions.find(x=>x.id===id && !x.deleted);
  if(!r){ toast("Attendance record not found","error"); return; }
  const ok = await confirmDeleteAttendanceModal(r);
  if(!ok) return;
  r.deleted = true;
  r.updatedAt = Date.now();
  r.deletedAt = Date.now();
  r.version = (r.version||1) + 1;
  if(state.editingRecord && state.editingRecord.id === r.id) state.editingRecord = null;
  saveDB(DB, {immediate:true});
  addLog(`Attendance record moved to Trash (${r.subjectCode||""} ${r.subject||""}, ${formatDate(r.date)})`);
  toast("Attendance record deleted — Subject Register, History, Reports and Dashboard updated","success");
  renderView();
}

function restoreSessionRecord(id){
  if(!isAdmin()){ toast("Only Admin/Teacher can restore attendance records","error"); return; }
  const r = DB.sessions.find(x=>x.id===id && x.deleted);
  if(!r){ toast("Attendance record not found","error"); return; }
  r.deleted = false;
  r.updatedAt = Date.now();
  r.deletedAt = null;
  r.version = (r.version||1) + 1;
  saveDB(DB, {immediate:true});
  addLog(`Attendance record restored (${r.subjectCode||""} ${r.subject||""}, ${formatDate(r.date)})`);
  toast(`Restored to ${r.subjectCode?r.subjectCode+" – ":""}${r.subject} · ${formatDate(r.date)} — Registers, History, Reports and Dashboard updated`,"success");
  renderView();
}

function confirmPermanentDeleteModal(r){
  return new Promise(resolve=>{
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>⚠️ Permanently Delete Attendance</h3>
        <div class="sub" style="line-height:1.8;">
          <div><b>Subject:</b><br>${escapeHtml(r.subjectCode?r.subjectCode+" – ":"")}${escapeHtml(r.subject)}</div>
          <div style="margin-top:8px;"><b>Date:</b><br>${formatDate(r.date)}</div>
          <div style="margin-top:10px;color:var(--red);font-weight:700;">This action is irreversible.<br>This attendance record cannot be recovered.</div>
        </div>
        <div class="actions">
          <button class="btn" id="mCancel">Cancel</button>
          <button class="btn btn-danger" id="mOk">Permanently Delete</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector("#mCancel").onclick = ()=>{ backdrop.remove(); resolve(false); };
    backdrop.querySelector("#mOk").onclick = ()=>{ backdrop.remove(); resolve(true); };
    backdrop.addEventListener("click", e=>{ if(e.target===backdrop){ backdrop.remove(); resolve(false); } });
  });
}

async function permanentlyDeleteSessionRecord(id){
  if(!isAdmin()){ toast("Only Admin/Teacher can permanently delete attendance records","error"); return; }
  const r = DB.sessions.find(x=>x.id===id && x.deleted);
  if(!r){ toast("Attendance record not found","error"); return; }
  const ok = await confirmPermanentDeleteModal(r);
  if(!ok) return;
  const label = `${r.subjectCode||""} ${r.subject||""}, ${formatDate(r.date)}`;
  DB.sessions = DB.sessions.filter(x=>x.id!==r.id);
  if(!DB.deletedSessionIds.includes(r.id)) DB.deletedSessionIds.push(r.id);
  if(state.editingRecord && state.editingRecord.id === r.id) state.editingRecord = null;
  saveDB(DB, {immediate:true});
  addLog(`Attendance record permanently deleted (${label})`);
  toast("Attendance record permanently deleted — it cannot be restored","success");
  renderView();
}

/* ---------------------------------------------------------
   STUDENTS VIEW
--------------------------------------------------------- */
function renderStudents(){
  let list = activeStudents();
  const q = state.studentsSearch.trim().toLowerCase();
  if(q) list = list.filter(s=>s.name.toLowerCase().includes(q)||s.rollNo.toLowerCase().includes(q));
  list = [...list].sort((a,b)=> state.studentsSort==="name" ? a.name.localeCompare(b.name) : a.sNo-b.sNo);
  const deletedCount = DB.students.filter(s=>s.deleted).length;

  return `
  <div class="section-title">
    <h2>👥 Students List <span style="font-weight:400;color:var(--text-dim);font-size:14px;">(${list.length})</span></h2>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-sm" id="sortRoll">Sort: Roll No.</button>
      <button class="btn btn-sm" id="sortName">Sort: Name</button>
      ${isAdmin() && deletedCount ? `<button class="btn btn-sm" id="viewDeleted">🗑️ Deleted (${deletedCount})</button>`:""}
      <button class="btn btn-sm" style="background:var(--green);border-color:var(--green);color:#fff;" id="exportStudentsXlsx">📗 Export Excel</button>
      <button class="btn btn-primary btn-sm" id="addStudentBtn">➕ Add Student</button>
    </div>
  </div>
  <div class="panel">
    <div class="panel-toolbar">
      <div class="search-input"><span class="ic">🔍</span><input id="stSearch" placeholder="Search by name or roll no..." value="${escapeHtml(state.studentsSearch)}"></div>
    </div>
    <table class="roster">
      <thead><tr><th class="td-sno">S.No.</th><th>Name</th><th>Roll No.</th><th>Registration No.</th><th>Actions</th></tr></thead>
      <tbody>
        ${list.map(s=>`
          <tr>
            <td class="td-sno">${s.sNo}</td>
            <td class="td-name"><button class="link-btn" data-profile="${s.id}">${escapeHtml(s.name)}</button></td>
            <td class="td-roll roll-mono">${escapeHtml(s.rollNo)}</td>
            <td class="td-status roll-mono" style="font-size:12.5px;color:var(--text-dim);">${escapeHtml(s.regNo||"—")}</td>
            <td class="td-status">
              <div class="status-btns">
                <button class="btn btn-sm" data-edit="${s.id}">✏️ Edit</button>
                ${isAdmin() ? `<button class="btn btn-sm btn-outline-danger" data-del="${s.id}">🗑️ Delete</button>` : ""}
              </div>
            </td>
          </tr>`).join("") || `<tr><td colspan="5"><div class="empty-state"><div class="emoji">🔎</div>No students found.</div></td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function bindStudentsEvents(){
  document.getElementById("stSearch").oninput = e=>{ state.studentsSearch = e.target.value; renderView(); };
  document.getElementById("sortRoll").onclick = ()=>{ state.studentsSort="roll"; renderView(); };
  document.getElementById("sortName").onclick = ()=>{ state.studentsSort="name"; renderView(); };
  document.getElementById("addStudentBtn").onclick = ()=> openStudentModal();
  const vd = document.getElementById("viewDeleted");
  if(vd) vd.onclick = ()=> openDeletedModal();
  document.getElementById("exportStudentsXlsx").onclick = ()=>{
    const ok = exportStudentListXlsx(activeStudents());
    if(ok) toast("Student list Excel exported","success");
  };
  document.querySelectorAll("[data-edit]").forEach(b=> b.onclick = ()=> openStudentModal(b.dataset.edit));
  document.querySelectorAll("[data-profile]").forEach(b=> b.onclick = ()=> openStudentProfileModal(b.dataset.profile));
  document.querySelectorAll("[data-del]").forEach(b=> b.onclick = async ()=>{
    const s = DB.students.find(x=>x.id===b.dataset.del);
    const ok = await confirmModal({title:"Delete student?", message:`${s.name} (${s.rollNo}) will be moved to Deleted. You can restore anytime.`, confirmText:"Delete", danger:true});
    if(ok){ s.deleted = true; s.updatedAt = Date.now(); saveDB(DB); addLog(`Student deleted: ${s.name} (${s.rollNo})`); toast("Student deleted — can be restored","success"); renderView(); }
  });
}

function addStudent({name, rollNo, regNo="", boardRoll=""}){
  const nextSNo = Math.max(0, ...DB.students.map(s=>s.sNo)) + 1;
  const id = "s" + Date.now();
  const record = { id, sNo: nextSNo, name, rollNo, regNo, boardRoll, deleted:false, updatedAt: Date.now() };
  DB.students.push(record);
  saveDB(DB);
  addLog(`Student added: ${name} (${rollNo})`);
  return record;
}

function openStudentModal(editId){
  const editing = editId ? DB.students.find(s=>s.id===editId) : null;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <h3>${editing?"✏️ Edit Student":"➕ Add Student"}</h3>
      <p class="sub">${editing?"Update student details.":"Enter details for the new student."}</p>
      <div id="mError"></div>
      <div class="field"><label>Name${reqStar()}</label><input class="field-input" id="mName" value="${editing?escapeHtml(editing.name):""}"></div>
      <div class="field"><label>Class Roll No.${reqStar()}</label><input class="field-input" id="mRoll" value="${editing?escapeHtml(editing.rollNo):""}"></div>
      <div class="field"><label>Registration No.${reqStar()}</label><input class="field-input" id="mReg" value="${editing?escapeHtml(editing.regNo||""):""}"></div>
      <div class="field"><label>Board Roll No.${reqStar()}</label><input class="field-input" id="mBoardRoll" value="${editing?escapeHtml(editing.boardRoll||""):""}"></div>
      <div class="actions">
        <button class="btn" id="mCancel2">Cancel</button>
        <button class="btn btn-primary" id="mSave">${editing?"Save Changes":"Add Student"}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#mCancel2").onclick = ()=> backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
  backdrop.querySelector("#mSave").onclick = ()=>{
    const showErr = (msg)=>{ document.getElementById("mError").innerHTML = `<div class="login-error">⚠️ ${escapeHtml(msg)}</div>`; };
    const missing = validateRequired([
      {id:"mName", label:"Name"}, {id:"mRoll", label:"Class Roll No."},
      {id:"mReg", label:"Registration No."}, {id:"mBoardRoll", label:"Board Roll No."}
    ]);
    if(missing.length){ showErr(`Please fill in: ${missing.join(", ")}.`); return; }
    const name = document.getElementById("mName").value.trim();
    const rollNo = document.getElementById("mRoll").value.trim();
    const regNo = document.getElementById("mReg").value.trim();
    const boardRoll = document.getElementById("mBoardRoll").value.trim();
    const dupeRoll = DB.students.find(s=>!s.deleted && s.rollNo.toLowerCase()===rollNo.toLowerCase() && s.id!==editId);
    if(dupeRoll){ showErr("A student with this Class Roll No. already exists."); return; }
    const dupeReg = DB.students.find(s=>!s.deleted && (s.regNo||"").toLowerCase()===regNo.toLowerCase() && s.id!==editId);
    if(dupeReg){ showErr("A student with this Registration No. already exists."); return; }
    const dupeBoard = DB.students.find(s=>!s.deleted && (s.boardRoll||"").toLowerCase()===boardRoll.toLowerCase() && s.id!==editId);
    if(dupeBoard){ showErr("A student with this Board Roll No. already exists."); return; }
    if(editing){
      editing.name=name; editing.rollNo=rollNo; editing.regNo=regNo; editing.boardRoll=boardRoll;
      addLog(`Student edited: ${name} (${rollNo})`);
      toast("Student updated","success");
    }else{
      addStudent({name, rollNo, regNo, boardRoll});
      toast("Student added","success");
    }
    saveDB(DB);
    backdrop.remove();
    renderView();
  };
}

function openDeletedModal(){
  const deleted = DB.students.filter(s=>s.deleted);
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:480px;">
      <h3>🗑️ Deleted Students</h3>
      <p class="sub">Restore any student back to the active roster, or delete permanently.</p>
      <div style="max-height:320px;overflow:auto;">
        ${deleted.map(s=>`
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);">
            <span>${escapeHtml(s.name)} <span class="roll-mono" style="color:var(--text-faint);">(${escapeHtml(s.rollNo)})</span></span>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button class="btn btn-sm btn-outline-success" data-restore="${s.id}">♻️ Restore</button>
              <button class="btn btn-sm btn-outline-danger" data-perm-del="${s.id}">🗑️ Delete Permanently</button>
            </div>
          </div>`).join("") || `<div class="empty-state"><div class="emoji">🎉</div>Nothing deleted.</div>`}
      </div>
      <div class="actions"><button class="btn btn-block" id="closeDel">Close</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#closeDel").onclick = ()=>{ backdrop.remove(); renderView(); };
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop){ backdrop.remove(); renderView(); } });
  backdrop.querySelectorAll("[data-restore]").forEach(b=>{
    b.onclick = ()=>{
      const s = DB.students.find(x=>x.id===b.dataset.restore);
      s.deleted = false; s.updatedAt = Date.now(); saveDB(DB); addLog(`Student restored: ${s.name}`); toast("Student restored","success");
      backdrop.remove(); renderView();
    };
  });
  backdrop.querySelectorAll("[data-perm-del]").forEach(b=>{
    b.onclick = async ()=>{
      const s = DB.students.find(x=>x.id===b.dataset.permDel);
      const ok = await confirmModal({title:"Delete this student permanently?", message:"This action cannot be undone.", confirmText:"Delete Permanently", danger:true});
      if(!ok) return;
      permanentlyDeleteStudent(s.id);
      toast("Student permanently deleted","success");
      backdrop.remove(); renderView();
    };
  });
}

// Fully and irreversibly removes a student: the roster record itself, their
// mark from every saved attendance session (history/registers/reports) and
// every date's live/in-progress attendance, and any login account linked to
// them — so nothing dangling is left behind in any screen. Only ever called
// after an explicit "Delete Permanently" confirmation from openDeletedModal.
function permanentlyDeleteStudent(studentId){
  const s = DB.students.find(x=>x.id===studentId);
  if(!s) return;
  DB.sessions.forEach(sess=>{ if(sess.marks && studentId in sess.marks) delete sess.marks[studentId]; });
  Object.values(DB.liveAttendance||{}).forEach(live=>{ if(live && live.marks && studentId in live.marks) delete live.marks[studentId]; });
  if(state.today && state.today.marks) delete state.today.marks[studentId];
  const linkedUserIds = DB.users.filter(u => u.studentId === studentId).map(u => u.id);
  DB.users = DB.users.filter(u => u.studentId !== studentId);
  DB.students = DB.students.filter(x=>x.id!==studentId);
  DB.deletedStudentIds = (DB.deletedStudentIds||[]).concat(studentId);
  DB.deletedUserIds = (DB.deletedUserIds||[]).concat(linkedUserIds);
  saveDB(DB);
  addLog(`Student permanently deleted: ${s.name} (${s.rollNo}) — attendance history and any linked login removed`);
}

/* ---------------------------------------------------------
   ATTENDANCE REGISTERS — one independent register per subject,
   computed live from DB.sessions (single source of truth, so a
   register updates automatically the moment attendance is saved
   and never goes out of sync with History/Reports).
--------------------------------------------------------- */
function subjectSessions(code){
  return DB.sessions.filter(s => !s.deleted && s.subjectCode === code).sort((a,b)=> a.date.localeCompare(b.date));
}
function subjectStats(code){
  const sessions = subjectSessions(code);
  const pcts = sessions.map(s=>parseFloat(s.pct));
  const trim = n => parseFloat(n.toFixed(2)).toString();
  return {
    classes: sessions.length,
    avg: pcts.length ? trim(pcts.reduce((a,b)=>a+b,0)/pcts.length) : "0",
    highest: pcts.length ? trim(Math.max(...pcts)) : "0",
    lowest: pcts.length ? trim(Math.min(...pcts)) : "0"
  };
}
function registerStudentIds(code){
  // Everyone currently active, PLUS anyone historically marked in this subject
  // (so a deleted student's past attendance is never lost from the register).
  const ids = new Set(activeStudents().map(s=>s.id));
  subjectSessions(code).forEach(s => Object.keys(s.marks||{}).forEach(id=>ids.add(id)));
  return Array.from(ids);
}
function studentById(id){ return DB.students.find(s=>s.id===id); }

/* ---------------------------------------------------------
   PRESENT/ABSENT DERIVATION FOR A SAVED SESSION RECORD
   Every saved session stores the exact per-student marks at save time
   (record.marks: studentId -> "present"|"absent"), which is the single
   source of truth. Deriving BOTH lists from that same map (rather than one
   list being "everyone else") guarantees Present and Absent can never be
   swapped or double-counted, and stays correct even if a student is later
   renamed, re-rolled, or removed from the active roster.
--------------------------------------------------------- */
function sessionPresentStudents(r){
  if(r && r.marks){
    const ids = Object.keys(r.marks).filter(id => r.marks[id] === "present");
    const students = ids.map(studentById).filter(Boolean);
    return sortForRollDisplay(students);
  }
  return []; // very old records saved before `marks` existed
}
function sessionAbsentStudents(r){
  if(r && r.marks){
    const ids = Object.keys(r.marks).filter(id => r.marks[id] === "absent");
    const students = ids.map(studentById).filter(Boolean);
    return sortForRollDisplay(students);
  }
  // Fallback for legacy records saved before `marks` existed, which only
  // stored the absentee roll numbers directly.
  return sortForRollDisplay(r && r.absentees ? r.absentees : []);
}
/* ---------------------------------------------------------
   COMMON ATTENDANCE CALCULATION UTILITY (single source of truth)
   Every page — Dashboard, Mark Attendance, Students, History, Registers,
   Student Profile, Reports, Excel/PDF/WhatsApp — must go through these
   two functions. Nothing else is allowed to compute a percentage or an
   attend/conduct count independently.

   Definitions (fixed everywhere in the app):
     - "Attend Class"   = number of sessions a student was marked Present.
     - "Conduct Class"  = number of sessions held for that student at all
                           (Present + Absent) — i.e. the denominator. This
                           is NOT the absent count. A student who was never
                           absent still has Conduct Class = total sessions,
                           never 0, as long as attendance was ever marked.
     - Percentage        = (Attend Class ÷ Conduct Class) × 100, formatted
                           with formatAttendancePercentage() below.
--------------------------------------------------------- */
function formatAttendancePercentage(attended, conducted){
  if(!conducted) return "0%";
  const percentage = (attended/conducted) * 100;
  return `${parseFloat(percentage.toFixed(2))}%`;
}
// Canonical calculator: given a raw attended/conducted pair, returns the
// standard {attended, conducted, percentage} shape used everywhere.
function calcAttendanceStats(attended, conducted){
  return { attended: attended||0, conducted: conducted||0, percentage: formatAttendancePercentage(attended, conducted) };
}
// Canonical per-student calculator across an arbitrary list of sessions
// (a subject's sessions, a date-filtered slice, all sessions, etc). This is
// the ONLY place that inspects session.marks to derive present/absent —
// every register, report, and export must call this rather than
// recomputing from raw session data itself.
function studentPctInSessions(id, sessions){
  const relevant = sessions.filter(s => id in (s.marks||{}));
  const conducted = relevant.length;
  const present = relevant.filter(s => s.marks[id] === "present").length;
  const absent = conducted - present;
  const stats = calcAttendanceStats(present, conducted);
  // `pct` kept as a plain number string (no "%") for legacy call sites that
  // append "%" themselves; `percentage` is the ready-to-display "83.33%" form.
  return {
    present, absent, considered: conducted, conducted,
    pct: conducted ? parseFloat(((present/conducted)*100).toFixed(2)).toString() : "—",
    percentage: conducted ? stats.percentage : "—"
  };
}
// Shared ≥75 / 60–74.99 / <60 classification used by the mobile student
// UI (hero card, attention banner, subject cards) AND the Excel export's
// Status column/conditional colors, so the two never disagree.
function attendanceStatusInfo(pctNum){
  if(pctNum == null || isNaN(pctNum)) return { key:"none", label:"—" };
  if(pctNum >= 75) return { key:"good", label:"Good" };
  if(pctNum >= 60) return { key:"attention", label:"Attention" };
  return { key:"shortage", label:"Shortage" };
}
function overallPctFor(studentId){
  if(!studentId) return "—";
  const p = studentPctInSessions(studentId, DB.sessions.filter(s=>!s.deleted));
  return p.pct;
}

function renderRegisters(){
  return state.registerSubject ? renderRegisterDetail(state.registerSubject) : renderRegisterList();
}
function renderRegisterList(){
  const subs = subjectsWithHistory();
  return `
  <div class="section-title"><h2>📗 Attendance Registers <span style="font-weight:400;color:var(--text-dim);font-size:14px;">(${subs.length} subject${subs.length===1?"":"s"})</span></h2></div>
  <div class="register-grid">
    ${subs.map(sub=>{
      const st = subjectStats(sub.code);
      return `
      <div class="card register-card" data-open-register="${sub.code}">
        <div class="rc-code">${escapeHtml(sub.code)} ${sub.status==="Archived"?'<span class="pill absent" style="padding:2px 8px;font-size:10.5px;">Archived</span>':""}</div>
        <div class="rc-name">${escapeHtml(sub.name)}</div>
        <div class="rc-faculty">👨‍🏫 ${escapeHtml(sub.faculty||"Not Assigned")}</div>
        <div class="rc-stats">
          <div><b>${st.classes}</b><span>Classes</span></div>
          <div><b>${st.avg}%</b><span>Avg</span></div>
          <div><b>${st.highest}%</b><span>Highest</span></div>
          <div><b>${st.lowest}%</b><span>Lowest</span></div>
        </div>
      </div>`;
    }).join("") || `<div class="empty-state card"><div class="emoji">📗</div>No subjects yet — add one from the Subjects page.</div>`}
  </div>`;
}
function bindRegistersEvents(){
  if(state.registerSubject){ bindRegisterDetailEvents(); return; }
  document.querySelectorAll("[data-open-register]").forEach(c=>{
    c.onclick = ()=>{ state.registerSubject = c.dataset.openRegister; state.registerMonth="all"; state.registerSearch=""; state.registerBelow="none"; renderView(); };
  });
}

function renderRegisterDetail(code){
  const subj = findSubject(code);
  const st = subjectStats(code);
  let sessions = subjectSessions(code);
  if(state.registerMonth !== "all") sessions = sessions.filter(s => s.date.startsWith(state.registerMonth));
  const dates = sessions.map(s=>s.date);
  const months = Array.from(new Set(subjectSessions(code).map(s=>s.date.slice(0,7)))).sort();

  let ids = registerStudentIds(code);
  let rows = ids.map(id=>{
    const s = studentById(id);
    if(!s) return null;
    const p = studentPctInSessions(id, sessions);
    return { s, p };
  }).filter(Boolean);

  const q = state.registerSearch.trim().toLowerCase();
  if(q) rows = rows.filter(r => r.s.name.toLowerCase().includes(q) || r.s.rollNo.toLowerCase().includes(q) || dates.some(d=>d.includes(q)));
  if(state.registerBelow === "75") rows = rows.filter(r => r.p.pct !== "—" && parseFloat(r.p.pct) < 75);
  if(state.registerBelow === "50") rows = rows.filter(r => r.p.pct !== "—" && parseFloat(r.p.pct) < 50);
  rows.sort((a,b)=> (a.s.sNo||9999) - (b.s.sNo||9999));

  return `
  <div class="section-title">
    <h2><button class="btn btn-sm btn-ghost" id="backToRegisters">← Back</button> ${escapeHtml(subj.code)} — ${escapeHtml(subj.name)}</h2>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-sm" style="background:var(--green);border-color:var(--green);color:#fff;" id="regExportXlsx">📗 Export Excel</button>
      <button class="btn btn-sm btn-purple" id="regPrint">🖨️ Print</button>
    </div>
  </div>

  <div class="stat-grid stat-grid-5">
    <div class="stat-card stat-total"><div class="ic">📚</div><div class="lbl">Classes Conducted</div><div class="val">${st.classes}</div></div>
    <div class="stat-card stat-total"><div class="ic">👥</div><div class="lbl">Students</div><div class="val">${rows.length}</div></div>
    <div class="stat-card stat-pct"><div class="ic">%</div><div class="lbl">Average Attendance</div><div class="val">${st.avg}%</div></div>
    <div class="stat-card stat-present"><div class="ic">⬆</div><div class="lbl">Highest</div><div class="val">${st.highest}%</div></div>
    <div class="stat-card stat-absent"><div class="ic">⬇</div><div class="lbl">Lowest</div><div class="val">${st.lowest}%</div></div>
  </div>

  <div class="filters-bar" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));">
    <div class="field"><label>Month</label>
      <select class="field-input" id="regMonth">
        <option value="all" ${state.registerMonth==='all'?'selected':''}>All months</option>
        ${months.map(m=>`<option value="${m}" ${state.registerMonth===m?'selected':''}>${m}</option>`).join("")}
      </select>
    </div>
    <div class="field"><label>Attendance filter</label>
      <select class="field-input" id="regBelow">
        <option value="none" ${state.registerBelow==='none'?'selected':''}>All students</option>
        <option value="75" ${state.registerBelow==='75'?'selected':''}>Below 75%</option>
        <option value="50" ${state.registerBelow==='50'?'selected':''}>Below 50%</option>
      </select>
    </div>
    <div class="field"><label>Search</label><input class="field-input" id="regSearch" placeholder="Roll, name or date..." value="${escapeHtml(state.registerSearch)}"></div>
  </div>

  <div class="register-cards">
    ${rows.map(({s,p})=>{
      const latestDate = dates[dates.length-1];
      const latestSess = latestDate ? sessions.find(x=>x.date===latestDate) : null;
      const latestMark = latestSess && latestSess.marks ? latestSess.marks[s.id] : undefined;
      const statusLabel = latestMark==="present" ? "Present ✅" : latestMark==="absent" ? "Absent ❌" : "No record";
      return `
      <div class="card reg-card ${p.pct!=="—" && parseFloat(p.pct)<75 ? 'reg-card-low':''}">
        <div class="reg-card-head">
          <button class="link-btn reg-card-name" data-profile="${s.id}">${escapeHtml(s.name)}${s.deleted?' <span class="pill unmarked" style="padding:2px 8px;">inactive</span>':''}</button>
          <span class="reg-card-roll"> ${escapeHtml(s.rollNo)}</span>
        </div>
        ${dates.length ? `
        <div class="reg-card-status">Latest (${latestDate.slice(8,10)} ${MONTH_SHORT[parseInt(latestDate.slice(5,7))-1]}): <b>${statusLabel}</b></div>
        <div class="reg-card-strip">
          ${dates.map(d=>{
            const sess = sessions.find(x=>x.date===d);
            const mark = sess && sess.marks ? sess.marks[s.id] : undefined;
            const cls = mark==="present" ? "cell-p" : mark==="absent" ? "cell-a" : "cell-blank";
            const label = mark==="present" ? "P" : mark==="absent" ? "A" : "–";
            return `<span class="reg-cell ${cls}" title="${d.slice(8,10)} ${MONTH_SHORT[parseInt(d.slice(5,7))-1]}">${label}</span>`;
          }).join("")}
        </div>` : `<div class="reg-card-status" style="color:var(--text-faint);">No classes recorded yet</div>`}
        <div class="reg-card-stats">
          <div><b style="color:var(--green);">${p.present}</b><span>Attended Classes</span></div>
          <div><b style="color:var(--blue);">${p.considered}</b><span>Conducted Classes</span></div>
          <div><b>${p.pct==="—"?"—":p.pct+"%"}</b><span>Attendance</span></div>
        </div>
      </div>`;
    }).join("") || `<div class="card empty-state"><div class="emoji">📗</div>No attendance recorded for this subject yet.</div>`}
  </div>

  <div class="panel register-table-wrap">
    <table class="roster register-table">
      <thead>
        <tr>
          <th>S.No</th><th>Name</th><th>Roll No</th>
          ${dates.map(d=>`<th>${d.slice(8,10)} ${MONTH_SHORT[parseInt(d.slice(5,7))-1]}</th>`).join("")}
          <th>Total Attend Class</th><th>Total Conduct Class</th><th>%</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(({s,p})=>`
          <tr class="${p.pct!=="—" && parseFloat(p.pct)<75 ? 'row-absent':''}">
            <td>${s.sNo||"—"}</td>
            <td><button class="link-btn" data-profile="${s.id}">${escapeHtml(s.name)}${s.deleted?' <span class="pill unmarked" style="padding:2px 8px;">inactive</span>':''}</button></td>
            <td class="roll-mono">${escapeHtml(s.rollNo)}</td>
            ${dates.map(d=>{
              const sess = sessions.find(x=>x.date===d);
              const mark = sess && sess.marks ? sess.marks[s.id] : undefined;
              const cell = mark==="present" ? '<span class="reg-cell cell-p">P</span>' : mark==="absent" ? '<span class="reg-cell cell-a">A</span>' : '<span class="reg-cell cell-blank">–</span>';
              return `<td>${cell}</td>`;
            }).join("")}
            <td style="color:var(--green);font-weight:700;">${p.present}</td>
            <td style="color:var(--blue);font-weight:700;">${p.considered}</td>
            <td style="font-weight:700;">${p.pct==="—"?"—":p.pct+"%"}</td>
          </tr>`).join("") || `<tr><td colspan="${dates.length+6}"><div class="empty-state"><div class="emoji">📗</div>No attendance recorded for this subject yet.</div></td></tr>`}
      </tbody>
    </table>
  </div>
  <div class="section-title" style="margin-top:24px;">
    <h2 style="font-size:16px;">📋 Session Records <span style="font-weight:400;color:var(--text-dim);font-size:13px;">(${sessions.length})</span></h2>
  </div>
  <div class="simple-grid">
    ${sessions.map(sess=>`
      <div class="card hist-card">
        <div class="meta">
          📅 ${formatDate(sess.date)}<br/>
          📚 ${escapeHtml(sess.subjectCode||"")} – ${escapeHtml(sess.subject)}${sess.editHistory && sess.editHistory.length ? ` · <span style="color:var(--amber);">edited ${sess.editHistory.length}×</span>` : ""}
        </div>
        <div class="stats">
          <span style="color:var(--green)">Attended<b>${sess.present}</b></span>
          <span style="color:var(--blue)">Conducted<b>${sess.total}</b></span>
          <span style="color:var(--amber)">%<b>${sess.pct}</b></span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-sm" data-view-sess="${sess.id}">👁️ View</button>
          <button class="btn btn-sm" data-copy-sess="${sess.id}">📋 Copy</button>
          <button class="btn btn-sm" data-wa-sess="${sess.id}">📱 WhatsApp</button>
          ${isAdmin() ? `
          <button class="btn btn-sm" data-edit-sess="${sess.id}">✏️ Edit Attendance</button>
          <button class="btn btn-sm btn-outline-danger" data-del-sess-reg="${sess.id}">🗑️ Delete Attendance</button>` : ""}
        </div>
      </div>`).join("") || `<div class="card empty-state"><div class="emoji">📋</div>No session records for this filter yet.</div>`}
  </div>

  <div class="note-strip">📝 <span>Use ✏️ Edit Attendance on any record above to correct the wrong subject/date, or 🗑️ Delete Attendance to remove just that one record — every other subject and date stays untouched.</span></div>

  ${renderRegisterPrintBlock(subj, rows, dates, sessions, st)}
  `;
}
const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Print-only Attendance Register: hidden on screen (display:none — see
// .print-only in dashboard.css), rendered only inside @media print, and
// deliberately built as its own compact table rather than reusing the
// interactive one — this keeps Registration No. (added here) and the
// clean/minimal print styling fully independent of the on-screen table's
// interactive markup (link buttons, filters, etc.) with zero risk of
// accidentally changing what's shown on screen.
function renderRegisterPrintBlock(subj, rows, dates, sessions, st){
  const anyRegNo = rows.some(({s}) => s.regNo);
  const periodLabel = state.registerMonth === "all" ? "All Recorded Sessions" : state.registerMonth;
  const printedOn = new Date().toLocaleDateString([], {day:"2-digit", month:"short", year:"numeric"});
  return `
  <div class="print-only register-print-block">
    <div class="print-header">
      <h1>Your Institution</h1>
      <h2>Your Department</h2>
      <h3>Attendance Register — ${escapeHtml(subj.code)} – ${escapeHtml(subj.name)}</h3>
      <p>Faculty: ${escapeHtml(subj.faculty||"—")} &nbsp;|&nbsp; Period: ${escapeHtml(periodLabel)} &nbsp;|&nbsp; Printed on: ${printedOn}</p>
    </div>
    <table class="print-register-table">
      <thead>
        <tr>
          <th>S.No</th><th>Name</th><th>Roll No</th>${anyRegNo?"<th>Reg No</th>":""}
          ${dates.map(d=>`<th>${d.slice(8,10)}/${d.slice(5,7)}</th>`).join("")}
          <th>Total Attend Class</th><th>Total Conduct Class</th><th>%</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(({s,p})=>`
          <tr>
            <td>${s.sNo||"—"}</td>
            <td class="pt-left">${escapeHtml(s.name)}</td>
            <td>${escapeHtml(s.rollNo)}</td>
            ${anyRegNo?`<td>${escapeHtml(s.regNo||"—")}</td>`:""}
            ${dates.map(d=>{
              const sess = sessions.find(x=>x.date===d);
              const mark = sess && sess.marks ? sess.marks[s.id] : undefined;
              return `<td>${mark==="present"?"P":mark==="absent"?"A":"–"}</td>`;
            }).join("")}
            <td>${p.present}</td><td>${p.considered}</td><td>${p.pct==="—"?"—":p.pct+"%"}</td>
          </tr>`).join("")}
      </tbody>
    </table>
    <div class="print-summary">
      <span>Total Students: <b>${rows.length}</b></span>
      <span>Classes Conducted: <b>${st.classes}</b></span>
      <span>Average Attendance: <b>${st.avg}%</b></span>
    </div>
  </div>`;
}

function bindRegisterDetailEvents(){
  document.getElementById("backToRegisters").onclick = ()=>{ state.registerSubject = null; renderView(); };
  document.getElementById("regMonth").onchange = e=>{ state.registerMonth = e.target.value; renderView(); };
  document.getElementById("regBelow").onchange = e=>{ state.registerBelow = e.target.value; renderView(); };
  document.getElementById("regSearch").oninput = e=>{ state.registerSearch = e.target.value; renderView(); };
  document.getElementById("regExportXlsx").onclick = ()=> exportRegisterXlsxHandler(state.registerSubject);
  document.getElementById("regPrint").onclick = ()=> window.print();
  document.querySelectorAll("[data-profile]").forEach(b=>{
    b.onclick = ()=> openStudentProfileModal(b.dataset.profile);
  });
  document.querySelectorAll("[data-edit-sess]").forEach(b=>{
    b.onclick = ()=> editSessionRecord(b.dataset.editSess);
  });
  document.querySelectorAll("[data-del-sess-reg]").forEach(b=>{
    b.onclick = ()=> deleteSessionRecord(b.dataset.delSessReg);
  });
  document.querySelectorAll("[data-view-sess]").forEach(b=>{
    b.onclick = ()=>{
      const r = DB.sessions.find(x=>x.id===b.dataset.viewSess);
      alertText(sessionReportText(r));
    };
  });
  document.querySelectorAll("[data-copy-sess]").forEach(b=>{
    b.onclick = async ()=>{
      const r = DB.sessions.find(x=>x.id===b.dataset.copySess);
      await navigator.clipboard.writeText(sessionReportText(r));
      toast("Session report copied to clipboard","success");
    };
  });
  document.querySelectorAll("[data-wa-sess]").forEach(b=>{
    b.onclick = ()=>{
      const r = DB.sessions.find(x=>x.id===b.dataset.waSess);
      window.open(`https://wa.me/?text=${encodeURIComponent(sessionReportText(r))}`, "_blank");
    };
  });
}
function exportRegisterXlsxHandler(code){
  const subj = findSubject(code);
  let sessions = subjectSessions(code);
  if(state.registerMonth !== "all") sessions = sessions.filter(s => s.date.startsWith(state.registerMonth));
  const dateLabels = sessions.map(s=> `${s.date.slice(8,10)} ${MONTH_SHORT[parseInt(s.date.slice(5,7))-1]}`);
  const ids = registerStudentIds(code);
  const rows = ids.map(id=>studentById(id)).filter(Boolean).sort((a,b)=>(a.sNo||9999)-(b.sNo||9999)).map(s=>{
    const p = studentPctInSessions(s.id, sessions);
    const cells = sessions.map(sess => sess.marks?.[s.id] || null);
    return { sNo:s.sNo||"", name:s.name, rollNo:s.rollNo, cells, present:p.present, absent:p.considered, pctNum: p.pct==="—"?0:parseFloat(p.pct) };
  });
  const ok = exportRegisterXlsx({ subject: subj, dateLabels, rows });
  if(ok) toast("Register Excel exported","success");
}

function openStudentProfileModal(studentId){
  const s = studentById(studentId);
  if(!s) return;
  const perSubject = subjectsWithHistory().map(sub=>{
    const sessions = subjectSessions(sub.code);
    const p = studentPctInSessions(studentId, sessions);
    return { sub, p };
  }).filter(r => r.p.considered > 0);
  const allSessions = DB.sessions.filter(x=>!x.deleted && studentId in (x.marks||{})).sort((a,b)=>a.date.localeCompare(b.date));
  const overall = studentPctInSessions(studentId, allSessions);
  const recent = allSessions.slice(-16);
  const maxBar = 16;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:560px;">
      <h3>👤 ${escapeHtml(s.name)} <span class="roll-mono" style="font-size:13px;color:var(--text-faint);">(${escapeHtml(s.rollNo)})</span></h3>
      <p class="sub">Overall attendance: <b style="color:var(--text)">${overall.present}</b> present, <b style="color:var(--text)">${overall.absent}</b> absent across ${overall.considered} classes — <b>${overall.pct}${overall.pct!=="—"?"%":""}</b></p>

      <div style="font-weight:700;font-size:13px;margin:14px 0 6px;">Subject-wise</div>
      <div style="max-height:180px;overflow:auto;">
        ${perSubject.map(r=>`
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
            <span>${escapeHtml(r.sub.code)} — ${escapeHtml(r.sub.name)}</span>
            <span style="font-weight:700;color:${parseFloat(r.p.pct)<75?'var(--red)':'var(--green)'}">${r.p.pct}%</span>
          </div>`).join("") || `<div class="empty-state" style="padding:16px;"><div class="emoji">📗</div>No records yet.</div>`}
      </div>

      <div style="font-weight:700;font-size:13px;margin:14px 0 6px;">Recent trend (last ${recent.length} classes)</div>
      <div class="trend-chart">
        ${recent.map(sess=>`<div class="trend-bar ${sess.marks[studentId]==='present'?'tb-present':'tb-absent'}" title="${formatDate(sess.date)} — ${sess.subjectCode}"></div>`).join("") || `<span style="color:var(--text-faint);font-size:12.5px;">No data yet</span>`}
      </div>
      <div class="actions"><button class="btn btn-block" id="closeProfile">Close</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#closeProfile").onclick = ()=>backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
}

/* ---------------------------------------------------------
   HISTORY VIEW
--------------------------------------------------------- */
function renderHistory(){
  const tab = state.historyTab;
  const todayIso = new Date().toISOString().slice(0,10);
  const weekAgo = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
  const monthPrefix = todayIso.slice(0,7);
  const isListTab = ["all","today","weekly","monthly","updates"].includes(tab);

  let list = DB.sessions.filter(r=>!r.deleted);
  if(tab === "today") list = list.filter(r=>r.date===todayIso);
  else if(tab === "weekly") list = list.filter(r=>r.date>=weekAgo);
  else if(tab === "monthly") list = list.filter(r=>r.date.startsWith(monthPrefix));
  else if(tab === "updates") list = list.filter(r=>r.editHistory && r.editHistory.length>0);

  // Quick Subject filter + Advanced Filters (exact date/range/month/year) apply
  // on top of whichever tab is active, in every list-based tab — not just
  // "All Records" — so e.g. Subject can narrow down Today's cards too.
  if(isListTab) list = applyHistFilters(list, state.histFilter);

  const q = state.historySearch.trim().toLowerCase();
  if(q && isListTab){
    // Build one searchable blob per record (ISO date + DD/MM/YYYY date +
    // subject + code + faculty), then require every whitespace-separated
    // term in the query to appear somewhere in it — so a combined query
    // like "29/05/2026 Switchgear and Protection" (date + subject together)
    // still finds the exact record.
    const terms = q.split(/\s+/).filter(Boolean);
    list = list.filter(r=>{
      const blob = [r.date, formatDate(r.date), r.subject, r.subjectCode||"", r.faculty||""].join(" ").toLowerCase();
      return terms.every(t => blob.includes(t));
    });
  }
  const deletedCount = DB.sessions.filter(r=>r.deleted).length;

  const TABS = [
    {id:"all", label:"🗂️ All"},
    {id:"today", label:"📅 Today"}, {id:"weekly", label:"🗓️ Weekly"}, {id:"monthly", label:"📆 This Month"},
    {id:"registers", label:"📗 Registers"}, {id:"updates", label:"✏️ Updates"},
    ...(isAdmin() ? [{id:"deleted", label:`🗑️ Deleted (${deletedCount})`}] : []),
    {id:"reports", label:"📊 Reports"}
  ];

  // Sort newest-first so a long attendance history (spanning any number of
  // months/years) is still easy to scan — this is purely a display order
  // and never limits which records can be found, edited, or deleted.
  list = [...list].sort((a,b)=> b.date === a.date ? 0 : (b.date > a.date ? 1 : -1));

  return `
  <div class="history-compact">
  <div class="section-title">
    <h2>🕘 Attendance History</h2>
    <button class="btn btn-sm" style="background:var(--green);border-color:var(--green);color:#fff;" id="exportHistXlsx">📗 Export Excel</button>
  </div>

  <div class="hist-tabs">
    ${TABS.map(t=>`<button class="hist-tab ${tab===t.id?'active':''}" data-htab="${t.id}">${t.label}</button>`).join("")}
  </div>

  ${isListTab ? renderHistFilterBar() : ""}

  ${tab === "registers" ? renderRegisterList() :
    tab === "deleted" ? renderDeletedHistoryTab() :
    tab === "reports" ? renderHistoryReportsTab() :
    tab === "updates" ? renderUpdatesTab(list) :
    renderSessionCards(list)}
  </div>
  `;
}

// Applies the quick Subject filter + Advanced Filters (exact date, date
// range, month, year) on top of a base session list. Every filter is
// optional and independent of "today"/current month — any combination of
// past months or years can be searched at once, from any tab.
function applyHistFilters(list, f){
  if(!f) return list;
  if(f.subjectCode) list = list.filter(r => r.subjectCode === f.subjectCode);
  if(f.date) list = list.filter(r => r.date === f.date);
  if(f.from) list = list.filter(r => r.date >= f.from);
  if(f.to) list = list.filter(r => r.date <= f.to);
  if(f.month) list = list.filter(r => r.date.slice(0,7) === f.month);        // "YYYY-MM"
  if(f.year) list = list.filter(r => r.date.slice(0,4) === String(f.year));  // "YYYY"
  return list;
}
function histHasAdvancedFilters(f){
  return !!(f.date || f.from || f.to || f.month || f.year);
}

// Frequently-used filters (Search box lives in the header area already via
// #histSearch below; Subject here) stay one tap away at all times. Exact
// Date / From / To / Month / Year are rarer "I know it was sometime around…"
// lookups, so they're tucked behind a collapsible "Advanced Filters" toggle
// instead of always taking up screen space — keeps the page compact while
// still making every record findable.
function renderHistFilterBar(){
  const f = state.histFilter;
  const subs = allSubjects();
  const years = Array.from(new Set(DB.sessions.filter(r=>!r.deleted).map(r=>r.date.slice(0,4)))).sort((a,b)=>b-a);
  const open = state.histAdvancedOpen;
  const advActive = histHasAdvancedFilters(f);
  return `
  <div class="hist-quick-row">
    <div class="search-input hist-quick-search"><span class="ic">🔍</span><input id="histSearch" placeholder="Search subject, date, faculty..." value="${escapeHtml(state.historySearch)}"></div>
    <select class="field-input hist-quick-subject" id="hfSubject">
      <option value="">📚 All Subjects</option>
      ${subs.map(s=>`<option value="${s.code}" ${f.subjectCode===s.code?'selected':''}>${escapeHtml(s.code)} – ${escapeHtml(s.name)}</option>`).join("")}
    </select>
    <button class="btn btn-sm" id="hfAdvToggle">${open?'▾':'▸'} Advanced Filters${advActive?' •':''}</button>
    ${(advActive || f.subjectCode) ? `<button class="btn btn-sm" id="hfClear">✖ Clear</button>` : ""}
  </div>
  ${open ? `
  <div class="filters-bar hist-advanced-filters" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
    <div class="field"><label>📅 Exact Date</label><input type="date" class="field-input" id="hfDate" value="${f.date}"></div>
    <div class="field"><label>📅 From</label><input type="date" class="field-input" id="hfFrom" value="${f.from}"></div>
    <div class="field"><label>📅 To</label><input type="date" class="field-input" id="hfTo" value="${f.to}"></div>
    <div class="field"><label>📆 Month</label><input type="month" class="field-input" id="hfMonth" value="${f.month}"></div>
    <div class="field"><label>📆 Year</label>
      <select class="field-input" id="hfYear">
        <option value="">All years</option>
        ${years.map(y=>`<option value="${y}" ${f.year===y?'selected':''}>${y}</option>`).join("")}
      </select>
    </div>
  </div>` : ""}`;
}

function renderSessionCards(list){
  return `<div class="simple-grid">
    ${list.map(r=>`
      <div class="card hist-card">
        <div class="meta">
          <b>${escapeHtml(r.subjectCode||"")} – ${escapeHtml(r.subject)}</b> · ${formatDate(r.date)}${r.time?` · ${escapeHtml(r.time)}`:""}<br/>
          👨‍🏫 ${escapeHtml(r.faculty)} · saved by ${escapeHtml(r.savedBy)}${r.editHistory && r.editHistory.length ? ` · <span style="color:var(--amber);">edited ${r.editHistory.length}×</span>` : ""}
        </div>
        <div class="stats">
          <span>Total<b>${r.total}</b></span>
          <span style="color:var(--green)">Total Attend Class<b>${r.present}</b></span>
          <span style="color:var(--blue)">Total Conduct Class<b>${r.total}</b></span>
          <span style="color:var(--amber)">%<b>${r.pct}</b></span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-sm" data-view-sess="${r.id}">👁️ View</button>
          <button class="btn btn-sm" data-copy-sess="${r.id}">📋 Copy</button>
          <button class="btn btn-sm" data-wa-sess="${r.id}">📱 WhatsApp</button>
          ${isAdmin() ? `
          <button class="btn btn-sm" data-edit-sess="${r.id}">✏️ Edit Attendance</button>
          <button class="btn btn-sm btn-outline-danger" data-del-sess="${r.id}">🗑️ Delete Attendance</button>` : ""}
        </div>
      </div>`).join("") || `<div class="card empty-state"><div class="emoji">🗂️</div>No sessions here yet.</div>`}
  </div>`;
}
function renderUpdatesTab(list){
  return `<div class="simple-grid">
    ${list.map(r=>`
      <div class="card hist-card" style="flex-direction:column;align-items:stretch;">
        <div class="meta"><b>${escapeHtml(r.subjectCode||"")} – ${escapeHtml(r.subject)}</b> · ${formatDate(r.date)}</div>
        ${r.editHistory.slice(0,3).map(e=>`
          <div style="font-size:12.5px;color:var(--text-dim);padding:4px 0;border-top:1px dashed var(--border);">
            ${new Date(e.at).toLocaleString()} by <b>${escapeHtml(e.by)}</b> — Total Attend Class ${e.prev.present}→${e.next.present}, Total Conduct Class ${e.prev.total}→${e.next.total}, ${e.prev.pct}%→${e.next.pct}%
            ${e.movedFrom ? `<br/><span style="color:var(--amber);">↪ corrected from ${escapeHtml(e.movedFrom)}</span>` : ""}
            ${e.movedTo ? `<br/><span style="color:var(--amber);">↪ merged into ${escapeHtml(e.movedTo)}</span>` : ""}
          </div>`).join("")}
      </div>`).join("") || `<div class="card empty-state"><div class="emoji">✏️</div>No edited sessions yet — editing a saved register cell will show up here.</div>`}
  </div>`;
}
function renderDeletedHistoryTab(){
  const deleted = DB.sessions.filter(r=>r.deleted);
  return `<div class="simple-grid">
    ${deleted.map(r=>`
      <div class="card hist-card">
        <div class="meta">
          <b>${escapeHtml(r.subjectCode||"")} – ${escapeHtml(r.subject)}</b> · ${formatDate(r.date)}<br/>
          👥 ${r.present}/${r.total} present · ${r.pct}%
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-outline-success" data-restore-hist="${r.id}">♻️ Restore</button>
          <button class="btn btn-sm btn-danger" data-perm-del-sess="${r.id}">❌ Permanently Delete</button>
        </div>
      </div>`).join("") || `<div class="card empty-state"><div class="emoji">🎉</div>Nothing deleted.</div>`}
  </div>`;
}
function renderHistoryReportsTab(){
  const sessions = DB.sessions.filter(r=>!r.deleted);
  return `<div class="card" style="padding:20px;max-width:520px;">
    ${sessions.length ? `
    <div class="report-row">Sessions recorded: <b>${sessions.length}</b></div>
    <div class="report-row">Average attendance: <b>${parseFloat((sessions.reduce((a,r)=>a+parseFloat(r.pct),0)/sessions.length).toFixed(2))}%</b></div>
    <div class="report-row">Last session: <b>${formatDate(sessions[0].date)} — ${escapeHtml(sessions[0].subject)}</b></div>
    ` : `<div class="empty-state"><div class="emoji">📊</div>No sessions recorded yet.</div>`}
    <button class="btn btn-primary" id="gotoReportsBtn" style="margin-top:10px;">📊 Open full Reports page</button>
  </div>`;
}

function bindHistoryEvents(){
  const histSearch = document.getElementById("histSearch");
  if(histSearch) histSearch.oninput = e=>{ state.historySearch = e.target.value; renderView(); };
  document.getElementById("exportHistXlsx").onclick = ()=>{
    const ok = exportHistoryXlsx(DB.sessions.filter(r=>!r.deleted));
    if(ok) toast("History Excel exported","success");
  };
  document.querySelectorAll("[data-htab]").forEach(b=>{
    b.onclick = ()=>{ state.historyTab = b.dataset.htab; state.registerSubject = null; renderView(); };
  });

  const hfSubject = document.getElementById("hfSubject");
  const hfAdvToggle = document.getElementById("hfAdvToggle");
  const hfClear = document.getElementById("hfClear");
  if(hfSubject) hfSubject.onchange = e=>{ state.histFilter.subjectCode = e.target.value; renderView(); };
  if(hfAdvToggle) hfAdvToggle.onclick = ()=>{ state.histAdvancedOpen = !state.histAdvancedOpen; renderView(); };
  if(hfClear) hfClear.onclick = ()=>{ state.histFilter = { date:"", from:"", to:"", month:"", year:"", subjectCode:"" }; renderView(); };
  const hfDate = document.getElementById("hfDate");
  const hfFrom = document.getElementById("hfFrom");
  const hfTo = document.getElementById("hfTo");
  const hfMonth = document.getElementById("hfMonth");
  const hfYear = document.getElementById("hfYear");
  if(hfDate) hfDate.onchange = e=>{ state.histFilter.date = e.target.value; renderView(); };
  if(hfFrom) hfFrom.onchange = e=>{ state.histFilter.from = e.target.value; renderView(); };
  if(hfTo) hfTo.onchange = e=>{ state.histFilter.to = e.target.value; renderView(); };
  if(hfMonth) hfMonth.onchange = e=>{ state.histFilter.month = e.target.value; renderView(); };
  if(hfYear) hfYear.onchange = e=>{ state.histFilter.year = e.target.value; renderView(); };

  if(state.historyTab === "registers"){
    document.querySelectorAll("[data-open-register]").forEach(c=>{
      c.onclick = ()=>{ state.view = "registers"; state.registerSubject = c.dataset.openRegister; state.registerMonth="all"; state.registerSearch=""; state.registerBelow="none"; render(); };
    });
    return;
  }
  if(state.historyTab === "reports"){
    const gr = document.getElementById("gotoReportsBtn");
    if(gr) gr.onclick = ()=>{ state.view = "reports"; render(); };
    return;
  }
  if(state.historyTab === "deleted"){
    document.querySelectorAll("[data-restore-hist]").forEach(b=>{
      b.onclick = ()=> restoreSessionRecord(b.dataset.restoreHist);
    });
    document.querySelectorAll("[data-perm-del-sess]").forEach(b=>{
      b.onclick = ()=> permanentlyDeleteSessionRecord(b.dataset.permDelSess);
    });
    return;
  }
  if(state.historyTab === "updates") return; // read-only tab, nothing further to bind

  document.querySelectorAll("[data-view-sess]").forEach(b=>{
    b.onclick = ()=>{
      const r = DB.sessions.find(x=>x.id===b.dataset.viewSess);
      alertText(sessionReportText(r));
    };
  });
  document.querySelectorAll("[data-copy-sess]").forEach(b=>{
    b.onclick = async ()=>{
      const r = DB.sessions.find(x=>x.id===b.dataset.copySess);
      await navigator.clipboard.writeText(sessionReportText(r));
      toast("Session report copied to clipboard","success");
    };
  });
  document.querySelectorAll("[data-wa-sess]").forEach(b=>{
    b.onclick = ()=>{
      const r = DB.sessions.find(x=>x.id===b.dataset.waSess);
      window.open(`https://wa.me/?text=${encodeURIComponent(sessionReportText(r))}`, "_blank");
    };
  });
  document.querySelectorAll("[data-edit-sess]").forEach(b=>{
    b.onclick = ()=> editSessionRecord(b.dataset.editSess);
  });
  document.querySelectorAll("[data-del-sess]").forEach(b=>{
    b.onclick = ()=> deleteSessionRecord(b.dataset.delSess);
  });
}
function sessionReportText(r){
  const present = sessionPresentStudents(r);
  const absent = sessionAbsentStudents(r);
  let txt = `📅 Date: ${formatDate(r.date)}\n🕒 Time: ${r.time||"—"}\n📘 Subject: ${r.subjectCode?r.subjectCode+" – ":""}${r.subject}\n👨‍🏫 Faculty: ${r.faculty}\n\n`;
  txt += `👥 Total: ${r.total}  ✅ Total Attend Class: ${r.present}  📚 Total Conduct Class: ${r.total}  📊 ${r.pct}%\n\n`;
  txt += `✅ Present Students:\n${present.length ? present.map(a=>`${a.name} — ${a.rollNo}`).join("\n") : "None"}\n\n`;
  txt += `❌ Absent Students:\n${absent.length ? absent.map(a=>`${a.name} — ${a.rollNo}`).join("\n") : "None 🎉"}`;
  return txt;
}
function alertText(txt){
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `<div class="modal" style="max-width:460px;"><h3>📄 Session Report</h3>
    <pre style="white-space:pre-wrap;font-size:13.5px;background:var(--surface-2);padding:14px;border-radius:10px;max-height:340px;overflow:auto;">${escapeHtml(txt)}</pre>
    <div class="actions"><button class="btn btn-block" id="closeAlert">Close</button></div></div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#closeAlert").onclick = ()=>backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
}

/* ---------------------------------------------------------
   REPORTS PAGE (standalone, mirrors today's live report + export all)
--------------------------------------------------------- */
function renderReportsPage(){
  const stats = computeStats();
  const activeSessions = DB.sessions.filter(r=>!r.deleted);
  return `
  <div class="reports-grid">
    ${renderReportPanel(stats)}
    <div class="panel">
      <h3 style="padding:16px 18px;border-bottom:1px solid var(--border);margin:0;font-size:15px;">📈 All-Time Summary</h3>
      <div class="report-body">
        ${activeSessions.length ? `
        <div class="report-row">Sessions recorded: <b>${activeSessions.length}</b></div>
        <div class="report-row">Average attendance: <b>${parseFloat((activeSessions.reduce((a,r)=>a+parseFloat(r.pct),0)/activeSessions.length).toFixed(2))}%</b></div>
        <div class="report-row">Last session: <b>${formatDate(activeSessions[0].date)} — ${escapeHtml(activeSessions[0].subject)}</b></div>
        ` : `<div class="empty-state"><div class="emoji">📊</div>No sessions saved yet.</div>`}
      </div>
      <div class="report-actions">
        <button class="btn btn-success report-actions-full" id="exportAllExcelBtn"><i class="fa-regular fa-file-excel"></i> Export All Sessions (Excel)</button>
      </div>
    </div>
  </div>`;
}
function bindReportsPageEvents(){
  bindReportPanelEvents();
  const allXlsxBtn = document.getElementById("exportAllExcelBtn");
  if(allXlsxBtn) allXlsxBtn.onclick = ()=>{
    const ok = exportHistoryXlsx(DB.sessions.filter(r=>!r.deleted));
    if(ok) toast("Excel exported","success");
  };
}

/* ---------------------------------------------------------
   SETTINGS
--------------------------------------------------------- */
function renderSettings(){
  const s = DB.settings;
  const accents = ["#f4a825","#3b6ee0","#1fa971","#e5484d","#6a4fd6"];
  return `
  <div class="settings-grid">
    <div class="card settings-card">
      <h4>🎨 Appearance</h4>
      <div class="settings-row"><span class="lbl">Theme<small>Light or dark mode</small></span>
        <select class="field-input" id="setTheme" style="max-width:140px;">
          <option value="light" ${s.theme==='light'?'selected':''}>Light</option>
          <option value="dark" ${s.theme==='dark'?'selected':''}>Dark</option>
          <option value="system" ${s.theme==='system'?'selected':''}>System</option>
        </select>
      </div>
      <div class="settings-row"><span class="lbl">Accent color</span>
        <div class="color-swatches">${accents.map(c=>`<button data-accent="${c}" class="${s.accent===c?'active':''}" style="background:${c}"></button>`).join("")}</div>
      </div>
      <div class="settings-row"><span class="lbl">Font size</span>
        <select class="field-input" id="setFont" style="max-width:140px;">
          <option value="normal" ${s.fontSize==='normal'?'selected':''}>Normal</option>
          <option value="large" ${s.fontSize==='large'?'selected':''}>Large</option>
        </select>
      </div>
    </div>
    <div class="card settings-card">
      <h4>📋 Defaults</h4>
      <div class="settings-row" style="display:block;">
        <span class="lbl">Default Subject<small>Auto-fills faculty and pre-selects on Attendance</small></span>
        <select class="field-input" id="setSubject" style="margin-top:6px;">
          ${activeSubjectsList().map(sub=>`<option value="${sub.code}" ${s.defaultSubjectCode===sub.code?'selected':''}>${escapeHtml(sub.code)} – ${escapeHtml(sub.name)}</option>`).join("")}
        </select>
      </div>
      <div class="settings-row"><span class="lbl">Auto-save<small>Save changes instantly to this device</small></span>
        <label class="switch"><input type="checkbox" id="setAutoSave" ${s.autoSave?'checked':''}><span class="slider"></span></label>
      </div>
    </div>
    <div class="card settings-card">
      <h4>📄 Report Format</h4>
      <p class="sub" style="text-align:left;margin:0 0 10px;">Controls what Copy Report and Share on WhatsApp send by default. Can be overridden per-session from the report panel.</p>
      <div class="settings-row" style="display:block;">
        <select class="field-input" id="setReportFormat">
          <option value="simple" ${s.reportFormat==='simple'?'selected':''}>Simple — Subject, Date, Present Roll Nos only</option>
          <option value="detailed" ${s.reportFormat==='detailed'?'selected':''}>Detailed — full stats + Present &amp; Absent Roll Nos</option>
        </select>
      </div>
    </div>
    <div class="card settings-card">
      <h4>☁️ Cloud Sync</h4>
      ${(window.FirestoreSync && window.FirestoreSync.enabled) ? `
      <p class="sub" style="text-align:left;margin:0 0 10px;">Connected to Firebase. Attendance updates, students, subjects, registers, history and reports sync to every signed-in device in real time — automatically, no refresh needed.</p>
      <div class="settings-row"><span class="lbl">Firebase sync<small>Live — status: ${escapeHtml(syncStatus)}</small></span>
        <label class="switch"><input type="checkbox" checked disabled><span class="slider"></span></label>
      </div>
      <p class="sub" style="text-align:left;margin:10px 0 0;">Still works fully offline — changes made without internet are saved locally and sync automatically the moment you're back online.</p>` : `
      <p class="sub" style="text-align:left;margin:0 0 10px;">Not connected. Attendance data currently lives only on this device/browser.</p>
      <div class="settings-row"><span class="lbl">Firebase sync<small>Requires your own Firebase project — see README</small></span>
        <label class="switch"><input type="checkbox" disabled><span class="slider"></span></label>
      </div>
      <button class="btn btn-sm" id="howToCloud">📖 How to connect Firebase</button>`}
    </div>
    <div class="card settings-card">
      <h4>⚠️ Danger Zone</h4>
      <button class="btn btn-danger btn-block" id="resetAppBtn">🗑️ Reset Application (erase all local data)</button>
    </div>
  </div>`;
}
function bindSettingsEvents(){
  document.getElementById("setTheme").onchange = e=>{ DB.settings.theme=e.target.value; saveDB(DB); applyTheme(); render(); };
  document.querySelectorAll("[data-accent]").forEach(b=>{
    b.onclick = ()=>{ DB.settings.accent=b.dataset.accent; saveDB(DB); applyTheme(); renderView(); };
  });
  document.getElementById("setFont").onchange = e=>{
    DB.settings.fontSize = e.target.value; saveDB(DB);
    document.body.style.fontSize = e.target.value==="large" ? "16px" : "14px";
  };
  document.getElementById("setSubject").onchange = e=>{ DB.settings.defaultSubjectCode=e.target.value; saveDB(DB); toast("Default subject saved","success"); };
  document.getElementById("setAutoSave").onchange = e=>{ DB.settings.autoSave=e.target.checked; saveDB(DB); };
  document.getElementById("setReportFormat").onchange = e=>{ DB.settings.reportFormat=e.target.value; state.reportFormatOverride=null; saveDB(DB); toast("Default report format saved","success"); };
  const howToCloud = document.getElementById("howToCloud");
  if(howToCloud) howToCloud.onclick = ()=>{ state.view="about"; render(); };
  document.getElementById("resetAppBtn").onclick = async ()=>{
    const ok = await confirmModal({title:"Reset application?", message:"This erases ALL students, history and settings on this device. This cannot be undone.", confirmText:"Erase Everything", danger:true});
    if(ok){ localStorage.removeItem(STORAGE_KEY); location.reload(); }
  };
}

/* ---------------------------------------------------------
   PROFILE & SECURITY (all roles) — account details + self-service
   Change Password. A password change here invalidates every session for
   this account, including the current one, and logs the person back out —
   matching the spec's "invalidate active sessions" requirement literally.
--------------------------------------------------------- */
function renderProfile(){
  const u = currentUser;
  const myRec = myStudentRecord();
  return `
  <div class="settings-grid">
    <div class="card settings-card">
      <h4>👤 Account Details</h4>
      <div class="settings-row"><span class="lbl">Full Name</span><span>${escapeHtml(u.fullName)}</span></div>
      <div class="settings-row"><span class="lbl">Username</span><span class="roll-mono">${escapeHtml(u.username)}</span></div>
      <div class="settings-row"><span class="lbl">Role</span><span>${u.role==='admin'?'👨‍🏫 Admin/Teacher':'🎓 Student'}</span></div>
      ${u.userId ? `<div class="settings-row"><span class="lbl">User ID / Roll No.</span><span class="roll-mono">${escapeHtml(u.userId)}</span></div>`:""}
      ${myRec ? `<div class="settings-row"><span class="lbl">Linked Student Record</span><span>${escapeHtml(myRec.name)} — ${escapeHtml(myRec.rollNo)}</span></div>`:""}
      <div class="settings-row"><span class="lbl">Branch / Semester / Section</span><span>${escapeHtml(u.branch||"—")} ${escapeHtml(u.semester||"")} ${escapeHtml(u.section||"")}</span></div>
      <div class="settings-row"><span class="lbl">Last Login</span><span>${u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "This is your first login"}</span></div>
    </div>
    ${isAdmin() ? `
    <div class="card settings-card">
      <h4>🔐 Security — Change Password</h4>
      <div id="cpError"></div>
      <div class="field" style="text-align:left;margin-bottom:12px;"><label style="font-size:12.5px;font-weight:600;color:var(--text-dim);">Current Password</label><div class="password-field"><input class="field-input" id="cpCurrent" type="password" autocomplete="current-password"><button type="button" class="pw-toggle" id="cpCurrentToggle" aria-label="Show password">👁️</button></div></div>
      <div class="field" style="text-align:left;margin-bottom:12px;"><label style="font-size:12.5px;font-weight:600;color:var(--text-dim);">New Password</label><div class="password-field"><input class="field-input" id="cpNew" type="password" autocomplete="new-password"><button type="button" class="pw-toggle" id="cpNewToggle" aria-label="Show password">👁️</button></div></div>
      <div class="field" style="text-align:left;margin-bottom:6px;"><label style="font-size:12.5px;font-weight:600;color:var(--text-dim);">Confirm New Password</label><div class="password-field"><input class="field-input" id="cpConfirm" type="password" autocomplete="new-password"><button type="button" class="pw-toggle" id="cpConfirmToggle" aria-label="Show password">👁️</button></div></div>
      <div id="cpStrength" class="strength-meter"></div>
      <button class="btn btn-primary btn-block" id="cpSaveBtn">✅ Change Password</button>
      <p class="sub" style="text-align:left;margin-top:10px;">Changing your password will sign you out of this device — log back in with the new one.</p>
    </div>` : `
    <div class="card settings-card">
      <h4>🔐 Security</h4>
      <p class="sub" style="text-align:left;">Only an Admin/Teacher can reset your password. If you need it changed, contact your Admin/Teacher — go to <b>User Management → Reset Password</b>.</p>
    </div>`}
  </div>`;
}
function bindProfileEvents(){
  if(!isAdmin()) return; // students have no password fields to bind — see renderProfile
  document.getElementById("cpNew").oninput = e=> renderStrengthMeter("cpStrength", e.target.value);
  wirePasswordToggle("cpCurrent", "cpCurrentToggle");
  wirePasswordToggle("cpNew", "cpNewToggle");
  wirePasswordToggle("cpConfirm", "cpConfirmToggle");
  document.getElementById("cpSaveBtn").onclick = async ()=>{
    const current = document.getElementById("cpCurrent").value;
    const pw = document.getElementById("cpNew").value, confirm = document.getElementById("cpConfirm").value;
    const showErr = (msg)=>{ document.getElementById("cpError").innerHTML = `<div class="login-error">⚠️ ${escapeHtml(msg)}</div>`; };
    const valid = await verifyPassword(currentUser, current);
    if(!valid){ showErr("Current password is incorrect."); return; }
    const err = validateNewPassword(pw, confirm);
    if(err){ showErr(err); return; }
    await setUserPassword(currentUser, pw, false);
    saveDB(DB);
    addLog(`${currentUser.fullName} changed their password`);
    toast("Password changed — please log in again","success");
    doLogout();
  };
}

/* ---------------------------------------------------------
   MY ATTENDANCE (Student only) — a read-only view of their own record
--------------------------------------------------------- */
// Builds the shared per-subject + overall dataset once, used by BOTH the
// desktop table and the new mobile cards (and, further down, by the Excel/
// PDF exports) so every surface always agrees on the same real numbers.
function myAttendanceData(){
  const myRec = myStudentRecord();
  if(!myRec) return null;
  const allSessions = DB.sessions.filter(s=>!s.deleted && myRec.id in (s.marks||{})).sort((a,b)=>a.date.localeCompare(b.date));
  const overall = studentPctInSessions(myRec.id, allSessions);
  const perSubject = subjectsWithHistory().map(sub=>{
    const sessions = subjectSessions(sub.code);
    const p = studentPctInSessions(myRec.id, sessions);
    return { sub, p, sessions, status: attendanceStatusInfo(p.considered ? parseFloat(p.pct) : null) };
  }).filter(r=>r.p.considered>0);
  return { myRec, allSessions, overall, perSubject };
}

function renderMyAttendance(){
  const data = myAttendanceData();
  if(!data){
    return `<div class="card empty-state" style="padding:60px 20px;"><div class="emoji">🔗</div><h3>No student record linked</h3><p>Ask your Admin/Teacher to link your account to a student record in User Management.</p></div>`;
  }
  const { overall, perSubject } = data;

  // ONE layout for every screen size — renders below the existing,
  // unmodified .topbar header. Only CSS grid column counts change
  // responsively (see .subj-cards-grid in mobile-student.css); the
  // markup itself is identical on desktop and mobile.
  return `
  ${renderMobileAttendanceHero(overall)}
  ${renderMobileAttentionStatus(perSubject)}

  <div class="section-title mobile-section-title"><h2>📚 Subject Attendance</h2>
    ${renderExportWidget("subject")}
  </div>
  <div class="subj-cards-grid">
    ${perSubject.map(r=>renderSubjectCard(r)).join("") || `<div class="empty-state"><div class="emoji">📗</div>No attendance recorded yet.</div>`}
  </div>

  <div class="section-title mobile-section-title" style="margin-top:18px;"><h2>📊 Attendance by Subject</h2></div>
  ${renderSubjectDonutChart(perSubject)}`;
}

// Full attendance-breakdown subject card — ONE design used identically
// on desktop and mobile (only the surrounding grid's column count
// changes responsively). Keeps the existing "8 / 9 Classes ... 88.89%"
// row + progress bar, with the Classes/Present/Absent breakdown ADDED
// below the bar (never above it, never replacing it).
function renderSubjectCard(r){
  const pctNum = parseFloat(r.p.pct) || 0;
  return `
  <div class="subj-card status-${r.status.key}">
    <div class="subj-card-code">${escapeHtml(r.sub.code)}</div>
    <div class="subj-card-name">${escapeHtml(r.sub.name)}</div>
    <div class="subj-card-faculty">👨‍🏫 ${escapeHtml(r.sub.faculty || "—")}</div>
    <div class="subj-card-row">
      <span class="subj-card-count">${r.p.present} / ${r.p.considered} Classes</span>
      <span class="subj-card-pct">${r.p.pct}%</span>
    </div>
    <div class="subj-card-bar"><div class="subj-card-bar-fill" style="width:${Math.min(100,pctNum)}%"></div></div>
    <div class="subj-card-breakdown">
      <div><span class="sb-val">${r.p.considered}</span><span class="sb-lbl">Classes</span></div>
      <div><span class="sb-val" style="color:var(--green);">${r.p.present}</span><span class="sb-lbl">Present</span></div>
      <div><span class="sb-val" style="color:var(--red);">${r.p.absent}</span><span class="sb-lbl">Absent</span></div>
    </div>
  </div>`;
}

// Distinct color per subject, cycled if there are more subjects than
// colors — used by both the donut chart arcs and its legend swatches.
const DONUT_COLORS = ["#2E5AAC","#1FA971","#E0932F","#E5484D","#7C5CFC","#17A2B8","#D6336C","#6C757D","#20C997","#C2A200","#8E44AD","#0C8599"];

// Lightens a "#rrggbb" color by mixing it toward white — used to derive
// each subject's Absent shade from its own Present color (dark/normal
// shade = Present, lighter shade of the SAME color = Absent), so every
// subject stays visually identifiable while still showing both values.
function lightenHex(hex, amount){
  const h = hex.replace("#","");
  const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), b = parseInt(h.substring(4,6),16);
  const mix = c => Math.round(c + (255-c)*amount);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

// Truncates a subject name for the on-chart callout label so it doesn't
// run into its neighbours — the full name is always still shown in the
// legend below/beside the chart.
function truncateForLabel(name, max){
  return name.length > max ? name.slice(0, max-1).trimEnd() + "…" : name;
}

// "📊 Attendance by Subject" — a donut with a title pill, per-subject
// present/absent arc pairs (dark = present, light = absent — using the
// SAME base color per subject, per subject colours stay stable across
// re-renders since DONUT_COLORS is indexed by each subject's position
// in perSubject, which itself comes from the stable subjectsWithHistory()
// ordering), on-chart callout labels naming each subject with its
// present/total fraction, a present/absent center readout, a
// "Subject | Present/Absent" legend with dual swatches, and a Total
// Present/Absent summary footer. Pure hand-rolled SVG (no charting
// library is vendored, and this app is built to run fully offline) so
// it needs no network dependency.
function renderSubjectDonutChart(perSubject){
  if(!perSubject.length){
    return `<div class="donut-card"><div class="empty-state" style="padding:20px;"><div class="emoji">📊</div>No attendance recorded yet.</div></div>`;
  }
  const totalPresent = perSubject.reduce((s,r)=>s+r.p.present, 0);
  const totalAbsent = perSubject.reduce((s,r)=>s+r.p.absent, 0);
  const totalAll = totalPresent + totalAbsent;
  // Extra canvas margin around the ring holds the outer callout labels
  // (subject name + present/total) with their leader lines.
  const size = 380, stroke = 32, radius = 72, cx = size/2, cy = size/2;
  const circumf = 2*Math.PI*radius;
  let offset = 0;
  const callouts = [];
  const arcs = totalAll>0 ? perSubject.map((r,i)=>{
    const base = DONUT_COLORS[i%DONUT_COLORS.length];
    const subjTotal = r.p.present + r.p.absent;
    const subjStart = offset;
    const drawSeg = (color, count) => {
      if(!count) return ""; // absent=0 never forces a visible fake sliver
      const dash = (count/totalAll)*circumf;
      const seg = `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-dasharray="${dash.toFixed(2)} ${(circumf-dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
      offset += dash;
      return seg;
    };
    // Present (dark/normal shade) drawn first, then that subject's
    // Absent (lighter shade of the same color) immediately after it —
    // keeps each subject's two slices adjacent on the ring.
    const segSvg = drawSeg(base, r.p.present) + drawSeg(lightenHex(base, 0.62), r.p.absent);
    if(subjTotal>0){
      // Mid-angle of this subject's WHOLE slice (present+absent combined)
      // — the callout points at the subject as a whole, not just its
      // present portion.
      const subjDash = (subjTotal/totalAll)*circumf;
      const midOffset = subjStart + subjDash/2;
      const midAngle = (-90 + (midOffset/circumf)*360) * Math.PI/180;
      const onRingX = cx + radius*Math.cos(midAngle), onRingY = cy + radius*Math.sin(midAngle);
      const leaderR = radius + stroke/2 + 10;
      const labelR = radius + stroke/2 + 16;
      const lx = cx + leaderR*Math.cos(midAngle), ly = cy + leaderR*Math.sin(midAngle);
      const isRight = Math.cos(midAngle) >= 0;
      const tx = cx + labelR*Math.cos(midAngle), ty = cy + labelR*Math.sin(midAngle);
      const anchor = isRight ? "start" : "end";
      const dx = isRight ? 4 : -4;
      callouts.push(`
        <line x1="${onRingX.toFixed(1)}" y1="${onRingY.toFixed(1)}" x2="${lx.toFixed(1)}" y2="${ly.toFixed(1)}" class="donut-leader" stroke="${base}"></line>
        <circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="2.5" fill="${base}"></circle>
        <text x="${(tx+dx).toFixed(1)}" y="${(ty-3).toFixed(1)}" text-anchor="${anchor}" class="donut-callout-name">${escapeHtml(truncateForLabel(r.sub.name, 16))}</text>
        <text x="${(tx+dx).toFixed(1)}" y="${(ty+10).toFixed(1)}" text-anchor="${anchor}" class="donut-callout-frac" fill="${base}">${r.p.present}/${r.p.considered}</text>`);
    }
    return segSvg;
  }).join("") : `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="var(--surface-2)" stroke-width="${stroke}"></circle>`;
  return `
  <div class="donut-card">
    <div class="donut-title-pill">📊 Attendance by Subject</div>
    <div class="donut-body">
      <div class="donut-chart-col">
        <div class="donut-chart-wrap">
          <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Attendance by subject — present and absent, labeled per subject">${arcs}${callouts.join("")}</svg>
          <div class="donut-center">
            <div class="dc-pct">${totalPresent}</div>
            <div class="dc-pct-lbl">PRESENT</div>
            <div class="dc-div"></div>
            <div class="dc-abs">${totalAbsent}</div>
            <div class="dc-abs-lbl">ABSENT</div>
          </div>
        </div>
        <div class="donut-legend-note">
          <span><i class="donut-note-swatch"></i> Dark shade = Present</span>
          <span><i class="donut-note-swatch donut-note-swatch-light"></i> Light shade = Absent</span>
        </div>
      </div>
      <div class="donut-legend-col">
        <div class="donut-legend-head"><span>Subject</span><span>Present / Absent</span></div>
        <div class="donut-legend">
          ${perSubject.map((r,i)=>{
            const base = DONUT_COLORS[i%DONUT_COLORS.length];
            return `
            <div class="donut-legend-item">
              <span class="donut-swatch-pair">
                <span class="donut-swatch" style="background:${base};"></span>
                <span class="donut-swatch donut-swatch-light" style="background:${lightenHex(base,0.62)};"></span>
              </span>
              <span class="donut-legend-name">${escapeHtml(r.sub.name)}</span>
              <span class="donut-legend-frac" style="color:${base};">${r.p.present}/${r.p.considered}</span>
            </div>`;
          }).join("")}
        </div>
        <div class="donut-summary-box">
          <span class="donut-summary-icon">🎓</span>
          <div class="donut-summary-stat"><span class="ds-lbl">Total Present</span><span class="ds-val" style="color:var(--green);">${totalPresent}</span></div>
          <div class="donut-summary-div"></div>
          <div class="donut-summary-stat"><span class="ds-lbl">Total Absent</span><span class="ds-val" style="color:var(--red);">${totalAbsent}</span></div>
        </div>
      </div>
    </div>
  </div>`;
}

// Compact hero card: overall % is the primary visual element, backed by a
// progress bar and a 3-up Classes/Present/Absent breakdown underneath.
function renderMobileAttendanceHero(overall){
  const pctNum = overall.considered ? parseFloat(overall.pct) : 0;
  const barClass = pctNum>=75 ? "" : pctNum>=60 ? "amber" : "red";
  return `
  <div class="attendance-hero">
    <div class="hero-label">Overall Attendance</div>
    <div class="hero-pct">${overall.considered ? overall.pct+"%" : "—"}</div>
    <div class="hero-sub">${overall.present} / ${overall.considered} classes</div>
    <div class="hero-bar"><div class="hero-bar-fill ${barClass}" style="width:${Math.min(100,pctNum)}%"></div></div>
    <div class="hero-breakdown">
      <div><span class="hb-val">${overall.considered}</span><span class="hb-lbl">Classes</span></div>
      <div><span class="hb-val" style="color:var(--green);">${overall.present}</span><span class="hb-lbl">Present</span></div>
      <div><span class="hb-val" style="color:var(--red);">${overall.absent}</span><span class="hb-lbl">Absent</span></div>
    </div>
  </div>`;
}

// Shows nothing when every subject is healthy AND there's no data at all;
// otherwise surfaces the single worst subject (shortage takes priority
// over attention) so the student sees the thing that actually needs
// action first, with a note if more than one subject needs attention.
function renderMobileAttentionStatus(perSubject){
  if(!perSubject.length) return "";
  const shortage = perSubject.filter(r=>r.status.key==="shortage").sort((a,b)=>parseFloat(a.p.pct)-parseFloat(b.p.pct));
  const attention = perSubject.filter(r=>r.status.key==="attention").sort((a,b)=>parseFloat(a.p.pct)-parseFloat(b.p.pct));
  if(shortage.length){
    const worst = shortage[0];
    const more = shortage.length>1 ? ` (+${shortage.length-1} more below 60%)` : "";
    return `<div class="attn-banner attn-shortage"><div class="attn-title">🔴 Attendance Shortage</div><div class="attn-detail">${escapeHtml(worst.sub.name)} — ${worst.p.pct}% — needs immediate attention${more}</div></div>`;
  }
  if(attention.length){
    const worst = attention[0];
    const more = attention.length>1 ? ` (+${attention.length-1} more between 60–75%)` : "";
    return `<div class="attn-banner attn-attention"><div class="attn-title">⚠ Attendance Attention</div><div class="attn-detail">${escapeHtml(worst.sub.name)} — ${worst.p.pct}% — maintain attendance${more}</div></div>`;
  }
  return `<div class="attn-banner attn-good"><div class="attn-title">✓ Attendance is on track</div></div>`;
}

// One Export widget markup, reused on BOTH mobile and desktop (two
// instances can exist on screen at once, so IDs are namespaced by
// `scope` and bindMyAttendanceEvents() binds every instance generically).
function renderExportWidget(scope){
  return `
  <div class="export-wrap" data-export-scope="${scope}">
    <button type="button" class="btn-export-compact" data-export-toggle>⬇ Export</button>
    <div class="export-menu" data-export-menu>
      <button type="button" data-export-fmt="xlsx">📊 Excel</button>
      <button type="button" data-export-fmt="pdf">📄 PDF</button>
    </div>
  </div>`;
}

function bindMyAttendanceEvents(){
  // Generic binding: works for however many .export-wrap widgets are on
  // screen at once (desktop table header + mobile subject header).
  document.querySelectorAll(".export-wrap").forEach(wrap=>{
    const btn = wrap.querySelector("[data-export-toggle]");
    const menu = wrap.querySelector("[data-export-menu]");
    if(!btn || !menu) return;
    btn.onclick = (e)=>{
      e.stopPropagation();
      const willShow = !menu.classList.contains("show");
      document.querySelectorAll(".export-menu.show").forEach(m=> m.classList.remove("show"));
      if(willShow) menu.classList.add("show");
    };
    menu.querySelectorAll("[data-export-fmt]").forEach(b=>{
      b.onclick = ()=>{ menu.classList.remove("show"); exportMyAttendance(b.dataset.exportFmt); };
    });
  });
  document.addEventListener("click", ()=>{
    document.querySelectorAll(".export-menu.show").forEach(m=> m.classList.remove("show"));
  });
}

// Builds the export-ready dataset (overall + subject-wise + full per-
// subject session log, grouped by subject) — the single source of truth
// shared by both the Excel export and the PDF/print export so the two
// documents can never disagree with each other or with the on-screen view.
// "5" -> "5th", "1" -> "1st", etc. — used for the Semester label.
function ordinalSuffix(n){
  const s = ["th","st","nd","rd"], v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
// Derives an academic-session label like "2026–27" purely from the
// current date (July–June session cycle) — genuinely dynamic (changes
// every year on its own), not a stored/hardcoded field, since the
// existing database has no academic-session field to read one from.
function computeAcademicSession(d){
  const y = d.getFullYear(), m = d.getMonth(); // 0=Jan
  const startYear = m>=6 ? y : y-1; // session begins in July
  const endYear = (startYear+1)%100;
  return `${startYear}\u2013${String(endYear).padStart(2,"0")}`;
}

function buildMyAttendanceExportData(){
  const data = myAttendanceData();
  if(!data) return null;
  const { myRec, overall, perSubject } = data;
  const now = new Date();
  // Semester: derived from the student's own subjects (the most common
  // semester value among them) — real data already in the subjects
  // table, not a hardcoded string.
  const semCounts = {};
  perSubject.forEach(r=>{ const sm = r.sub.semester; if(sm!=null && sm!=="") semCounts[sm] = (semCounts[sm]||0)+1; });
  const semKeys = Object.keys(semCounts);
  const modeSem = semKeys.length ? semKeys.reduce((a,b)=> semCounts[a]>=semCounts[b]?a:b) : null;
  const semesterLabel = modeSem ? `${ordinalSuffix(parseInt(modeSem,10))} Semester` : "";
  return {
    studentName: myRec.name,
    rollNo: myRec.rollNo,
    semester: semesterLabel,
    academicSession: computeAcademicSession(now),
    generated: `${now.toLocaleDateString()} ${now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`,
    overall: { conducted: overall.considered, present: overall.present, absent: overall.absent, pct: overall.considered ? parseFloat(overall.pct) : 0 },
    subjects: perSubject.map(r=>({
      code: r.sub.code, name: r.sub.name, faculty: r.sub.faculty || "—",
      present: r.p.present, conducted: r.p.considered, absent: r.p.absent,
      pct: parseFloat(r.p.pct), status: r.status.label
    })),
    log: perSubject.map(r=>({
      code: r.sub.code, name: r.sub.name, faculty: r.sub.faculty || "—",
      present: r.p.present, conducted: r.p.considered, absent: r.p.absent, pct: parseFloat(r.p.pct),
      sessions: r.sessions.filter(s => r.sub.code === s.subjectCode && myRec.id in (s.marks||{})).map(s=>({
        date: s.date, status: s.marks[myRec.id]==="present" ? "Present" : "Absent"
      }))
    }))
  };
}

function exportMyAttendance(fmt){
  const data = buildMyAttendanceExportData();
  if(!data) return;
  if(fmt === "pdf"){
    printMyAttendanceReport(data);
    return;
  }
  const ok = exportMyAttendanceXlsx(data);
  if(ok) toast("Attendance exported (Excel)","success");
}

/* ---------------------------------------------------------
   SUBJECT MANAGEMENT (Admin/Teacher only)
--------------------------------------------------------- */
function renderSubjects(){
  let list = allSubjects();
  const q = state.subjectSearch.trim().toLowerCase();
  if(q) list = list.filter(s => s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || (s.faculty||"").toLowerCase().includes(q));
  if(state.subjectSemFilter !== "all") list = list.filter(s => String(s.semester) === state.subjectSemFilter);
  if(state.subjectStatusFilter !== "all") list = list.filter(s => s.status === state.subjectStatusFilter);
  if(state.subjectTypeFilter !== "all") list = list.filter(s => s.type === state.subjectTypeFilter);
  const semesters = Array.from(new Set(allSubjects().map(s=>String(s.semester)))).sort();

  return `
  <div class="section-title">
    <h2>📚 Subjects <span style="font-weight:400;color:var(--text-dim);font-size:14px;">(${list.length} of ${allSubjects().length})</span></h2>
    <button class="btn btn-primary btn-sm" id="addSubjectBtn">➕ Add Subject</button>
  </div>
  <div class="panel">
    <div class="panel-toolbar">
      <div class="search-input"><span class="ic">🔍</span><input id="subjectSearch" placeholder="Search code, name, faculty..." value="${escapeHtml(state.subjectSearch)}"></div>
      <select class="field-input" id="subjectSemFilter" style="max-width:150px;">
        <option value="all" ${state.subjectSemFilter==='all'?'selected':''}>All semesters</option>
        ${semesters.map(sem=>`<option value="${sem}" ${state.subjectSemFilter===sem?'selected':''}>Semester ${sem}</option>`).join("")}
      </select>
      <select class="field-input" id="subjectTypeFilter" style="max-width:140px;">
        <option value="all" ${state.subjectTypeFilter==='all'?'selected':''}>All types</option>
        <option value="Theory" ${state.subjectTypeFilter==='Theory'?'selected':''}>Theory</option>
        <option value="Lab" ${state.subjectTypeFilter==='Lab'?'selected':''}>Lab</option>
      </select>
      <select class="field-input" id="subjectStatusFilter" style="max-width:150px;">
        <option value="all" ${state.subjectStatusFilter==='all'?'selected':''}>All statuses</option>
        <option value="Active" ${state.subjectStatusFilter==='Active'?'selected':''}>Active</option>
        <option value="Archived" ${state.subjectStatusFilter==='Archived'?'selected':''}>Archived</option>
      </select>
    </div>
    <table class="roster">
      <thead><tr><th>Code</th><th>Subject</th><th>Faculty</th><th>Sem</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>
        ${list.map(s=>`
          <tr>
            <td class="roll-mono">${escapeHtml(s.code)}</td>
            <td class="td-name">${escapeHtml(s.name)}</td>
            <td style="font-size:13px;">${escapeHtml(s.faculty || "Not Assigned")}</td>
            <td>${escapeHtml(String(s.semester))}</td>
            <td><span class="pill ${s.type==='Lab'?'unmarked':'present'}" style="padding:2px 9px;">${escapeHtml(s.type)}</span></td>
            <td><span class="pill ${s.status==='Active'?'present':'absent'}">${escapeHtml(s.status)}</span></td>
            <td class="td-status">
              <div class="status-btns">
                <button class="btn btn-sm" data-edit-subject="${s.id}">✏️ Edit</button>
                <button class="btn btn-sm" data-change-faculty="${s.id}">👨‍🏫 Faculty</button>
                <button class="btn btn-sm ${s.status==='Active'?'btn-outline-danger':'btn-outline-success'}" data-toggle-subject-status="${s.id}">${s.status==='Active'?'⏸️ Disable':'▶️ Enable'}</button>
                <button class="btn btn-sm btn-outline-danger" data-del-subject="${s.id}">🗑️ Delete</button>
              </div>
            </td>
          </tr>`).join("") || `<tr><td colspan="7"><div class="empty-state"><div class="emoji">🔎</div>No subjects match.</div></td></tr>`}
      </tbody>
    </table>
  </div>
  <div class="note-strip">📝 <span>Disabling a subject hides it from attendance marking and new defaults, but keeps every past register and report intact. Editing a subject's code, name, or faculty updates every attendance record already saved under it, so history always stays in sync.</span></div>`;
}

function bindSubjectsEvents(){
  document.getElementById("subjectSearch").oninput = e=>{ state.subjectSearch = e.target.value; renderView(); };
  document.getElementById("subjectSemFilter").onchange = e=>{ state.subjectSemFilter = e.target.value; renderView(); };
  document.getElementById("subjectTypeFilter").onchange = e=>{ state.subjectTypeFilter = e.target.value; renderView(); };
  document.getElementById("subjectStatusFilter").onchange = e=>{ state.subjectStatusFilter = e.target.value; renderView(); };
  document.getElementById("addSubjectBtn").onclick = ()=> openSubjectModal();
  document.querySelectorAll("[data-edit-subject]").forEach(b=> b.onclick = ()=> openSubjectModal(b.dataset.editSubject));
  document.querySelectorAll("[data-change-faculty]").forEach(b=> b.onclick = ()=> openFacultyModal(b.dataset.changeFaculty));
  document.querySelectorAll("[data-toggle-subject-status]").forEach(b=>{
    b.onclick = async ()=>{
      const s = allSubjects().find(x=>x.id===b.dataset.toggleSubjectStatus);
      const activating = s.status !== "Active";
      const ok = await confirmModal({
        title:`${activating?"Enable":"Disable"} this subject?`,
        message: activating
          ? `${s.name} will reappear for attendance marking and in defaults.`
          : `${s.name} will no longer be available for marking new attendance, but every past register and report stays intact.`,
        confirmText: activating?"Enable":"Disable", danger:!activating
      });
      if(!ok) return;
      s.status = activating ? "Active" : "Archived";
      saveDB(DB); addLog(`Subject ${activating?"enabled":"disabled"}: ${s.code} — ${s.name}`);
      toast(`Subject ${activating?"enabled":"disabled"}`,"success"); renderView();
    };
  });
  document.querySelectorAll("[data-del-subject]").forEach(b=>{
    b.onclick = ()=> handleDeleteSubject(b.dataset.delSubject);
  });
}

async function handleDeleteSubject(subjectId){
  const s = allSubjects().find(x=>x.id===subjectId);
  if(!s) return;
  if(subjectHasSessions(s.code)){
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal">
        <h3>⚠️ Can't delete — attendance exists</h3>
        <p class="sub" style="text-align:left;">${escapeHtml(s.name)} (${escapeHtml(s.code)}) already has attendance records saved against it. Deleting it would corrupt those registers and reports, so it can't be removed outright — archive it instead to keep the history and hide it from future attendance.</p>
        <div class="actions">
          <button class="btn" id="dsCancel">Cancel</button>
          <button class="btn btn-primary" id="dsArchive">Archive Instead</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelector("#dsCancel").onclick = ()=> backdrop.remove();
    backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
    backdrop.querySelector("#dsArchive").onclick = ()=>{
      s.status = "Archived"; saveDB(DB); addLog(`Subject archived (delete blocked — has history): ${s.code} — ${s.name}`);
      toast("Subject archived","success"); backdrop.remove(); renderView();
    };
    return;
  }
  const ok = await confirmModal({title:"Delete this subject?", message:`${s.name} (${s.code}) has no attendance history, so it will be permanently removed. This cannot be undone.`, confirmText:"Delete", danger:true});
  if(!ok) return;
  DB.subjects = DB.subjects.filter(x=>x.id!==subjectId);
  DB.deletedSubjectIds = (DB.deletedSubjectIds||[]).concat(subjectId);
  if(DB.settings.defaultSubjectCode === s.code) DB.settings.defaultSubjectCode = (activeSubjectsList()[0]||{}).code || "";
  if(DB.settings.lastSubjectCode === s.code) DB.settings.lastSubjectCode = DB.settings.defaultSubjectCode;
  saveDB(DB); addLog(`Subject deleted: ${s.code} — ${s.name}`); toast("Subject deleted","success"); renderView();
}

// Any attendance record already saved under this subject's code snapshots
// the subject name and faculty at the time — keep those snapshots (and, if
// the code itself changed, the subjectCode link) in sync so registers and
// reports never drift out of sync with the subject's current details.
function cascadeSubjectEditToSessions(oldCode, newCode, newName, newFaculty){
  DB.sessions.forEach(sess=>{
    if(sess.subjectCode === oldCode){
      sess.subjectCode = newCode; sess.subject = newName; sess.faculty = newFaculty;
    }
  });
  if(DB.settings.defaultSubjectCode === oldCode) DB.settings.defaultSubjectCode = newCode;
  if(DB.settings.lastSubjectCode === oldCode) DB.settings.lastSubjectCode = newCode;
  if(state.today.subjectCode === oldCode) state.today.subjectCode = newCode;
}

function openSubjectModal(editId){
  const editing = editId ? allSubjects().find(s=>s.id===editId) : null;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:460px;max-height:88vh;overflow:auto;">
      <h3>${editing?"✏️ Edit Subject":"➕ Add Subject"}</h3>
      <p class="sub">${editing?"Update this subject's details.":"Create a new subject for attendance, reports, and dashboards."}</p>
      <div id="subError"></div>
      <div class="field"><label>Subject Code</label><input class="field-input" id="subCode" autocomplete="off" value="${editing?escapeHtml(editing.code):""}"></div>
      <div class="field"><label>Subject Name</label><input class="field-input" id="subName" value="${editing?escapeHtml(editing.name):""}"></div>
      <div class="field"><label>Faculty</label><input class="field-input" id="subFaculty" placeholder="Not Assigned" value="${editing?escapeHtml(editing.faculty||""):""}"></div>
      <div class="field"><label>Semester</label><input class="field-input" id="subSemester" type="number" min="1" max="8" value="${editing?escapeHtml(String(editing.semester)):"5"}"></div>
      <div class="field"><label>Type</label>
        <select class="field-input" id="subType">
          <option value="Theory" ${!editing||editing.type==='Theory'?'selected':''}>Theory</option>
          <option value="Lab" ${editing?.type==='Lab'?'selected':''}>Lab</option>
        </select>
      </div>
      <div class="field"><label>Status</label>
        <select class="field-input" id="subStatus">
          <option value="Active" ${!editing||editing.status==='Active'?'selected':''}>Active</option>
          <option value="Archived" ${editing?.status==='Archived'?'selected':''}>Archived</option>
        </select>
      </div>
      <div class="actions">
        <button class="btn" id="subCancel">Cancel</button>
        <button class="btn btn-primary" id="subSave">${editing?"Save Changes":"Save"}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#subCancel").onclick = ()=> backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
  backdrop.querySelector("#subSave").onclick = ()=>{
    const showErr = (msg)=>{ document.getElementById("subError").innerHTML = `<div class="login-error">⚠️ ${escapeHtml(msg)}</div>`; };
    const code = document.getElementById("subCode").value.trim();
    const name = document.getElementById("subName").value.trim();
    const faculty = document.getElementById("subFaculty").value.trim();
    const semester = parseInt(document.getElementById("subSemester").value, 10) || 5;
    const type = document.getElementById("subType").value;
    const status = document.getElementById("subStatus").value;
    if(!code || !name){ showErr("Subject Code and Subject Name are required."); return; }
    const dupeCode = allSubjects().find(s => s.code.toLowerCase()===code.toLowerCase() && s.id!==editId);
    if(dupeCode){ showErr("That Subject Code is already in use."); return; }
    const dupeName = allSubjects().find(s => s.name.toLowerCase()===name.toLowerCase() && String(s.semester)===String(semester) && s.id!==editId);
    if(dupeName){ showErr("A subject with that name already exists in this semester."); return; }
    if(editing){
      const oldCode = editing.code;
      Object.assign(editing, { code, name, faculty, semester, type, status });
      editing.updatedAt = Date.now();
      cascadeSubjectEditToSessions(oldCode, code, name, faculty);
      addLog(`Subject updated: ${code} — ${name}`); toast("Subject updated","success");
    }else{
      const subject = { id:"sub"+Date.now().toString(36)+Math.random().toString(36).slice(2,8), code, name, semester, facultyId:null, faculty, type, status, updatedAt: Date.now() };
      DB.subjects.push(subject);
      addLog(`Subject created: ${code} — ${name}`); toast("Subject created","success");
    }
    saveDB(DB); backdrop.remove(); renderView();
  };
}

function openFacultyModal(subjectId){
  const s = allSubjects().find(x=>x.id===subjectId);
  if(!s) return;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <h3>👨‍🏫 Change Faculty</h3>
      <p class="sub" style="text-align:left;">${escapeHtml(s.name)}<br><span style="color:var(--text-faint);">${escapeHtml(s.code)}</span></p>
      <div class="field"><label>Faculty</label><input class="field-input" id="facName" placeholder="Not Assigned" value="${escapeHtml(s.faculty||"")}"></div>
      <div class="actions">
        <button class="btn" id="facCancel">Cancel</button>
        <button class="btn btn-primary" id="facSave">Save</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#facCancel").onclick = ()=> backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
  backdrop.querySelector("#facSave").onclick = ()=>{
    const faculty = document.getElementById("facName").value.trim();
    s.faculty = faculty;
    s.updatedAt = Date.now();
    cascadeSubjectEditToSessions(s.code, s.code, s.name, faculty);
    saveDB(DB); addLog(`Faculty changed for ${s.code} — ${s.name}: ${faculty || "Not Assigned"}`);
    toast("Faculty updated","success"); backdrop.remove(); renderView();
  };
}

/* ---------------------------------------------------------
   USER MANAGEMENT (Admin/Teacher only)
--------------------------------------------------------- */
function renderUserManagement(){
  const allStudents = DB.users.filter(u=>u.role==="student");
  const allAdmins = DB.users.filter(u=>u.role==="admin");
  const tab = state.userTab === "admin" ? "admin" : "student";

  return `
  <div class="section-title">
    <h2>🔑 User Management</h2>
    <button class="btn btn-primary btn-sm" id="addUserBtn">➕ Add User</button>
  </div>
  <div class="role-toggle" style="max-width:420px;margin-bottom:18px;">
    <button data-user-tab="student" class="${tab==='student'?'active':''}">🎓 Student Accounts <span class="pill unmarked" style="padding:1px 8px;margin-left:4px;">${allStudents.length}</span></button>
    <button data-user-tab="admin" class="${tab==='admin'?'active':''}">👨‍🏫 Admin Accounts <span class="pill unmarked" style="padding:1px 8px;margin-left:4px;">${allAdmins.length}</span></button>
  </div>
  ${tab==='admin' ? renderAdminAccountsSection(allAdmins) : renderStudentAccountsSection(allStudents)}
  <div class="note-strip">📝 <span>Passwords are hashed (never stored in plain text) using this browser's built-in Web Crypto API. Since this app has no server, that protects against casual snooping but isn't a substitute for real backend authentication — see README for connecting Firebase Authentication.</span></div>`;
}

function renderStudentAccountsSection(allStudents){
  let list = allStudents;
  const q = state.studentUserSearch.trim().toLowerCase();
  if(q){
    list = list.filter(u=>{
      const linked = u.studentId ? studentById(u.studentId) : null;
      const pending = u.pendingProfile;
      return u.fullName.toLowerCase().includes(q)
        || (u.userId||"").toLowerCase().includes(q)
        || (linked && linked.rollNo && linked.rollNo.toLowerCase().includes(q))
        || (linked && linked.regNo && linked.regNo.toLowerCase().includes(q))
        || (pending && pending.rollNo && pending.rollNo.toLowerCase().includes(q))
        || (pending && pending.regNo && pending.regNo.toLowerCase().includes(q));
    });
  }
  if(state.studentUserStatusFilter !== "all") list = list.filter(u => u.status === state.studentUserStatusFilter);
  const active = allStudents.filter(u=>u.status==="active").length;
  const pendingCount = allStudents.filter(u=>u.status==="pending").length;

  return `
  <div class="stat-grid">
    <div class="stat-card stat-total"><div class="ic">🎓</div><div class="lbl">Total Students</div><div class="val">${allStudents.length}</div></div>
    <div class="stat-card stat-present"><div class="ic">✅</div><div class="lbl">Active</div><div class="val">${active}</div></div>
    <div class="stat-card stat-absent"><div class="ic">⏸️</div><div class="lbl">Inactive</div><div class="val">${allStudents.length-active}</div></div>
  </div>
  ${pendingCount ? `<div class="note-strip">🔔 <span><b>${pendingCount}</b> student registration${pendingCount===1?"":"s"} waiting for approval — filter by <b>Pending</b> below.</span></div>` : ""}
  <div class="panel">
    <div class="panel-toolbar">
      <div class="search-input"><span class="ic">🔍</span><input id="studentUserSearch" placeholder="Search name, registration no., roll no..." value="${escapeHtml(state.studentUserSearch)}"></div>
      <select class="field-input" id="studentUserStatusFilter" style="max-width:160px;">
        <option value="all" ${state.studentUserStatusFilter==='all'?'selected':''}>All statuses</option>
        <option value="pending" ${state.studentUserStatusFilter==='pending'?'selected':''}>Pending${pendingCount?` (${pendingCount})`:""}</option>
        <option value="active" ${state.studentUserStatusFilter==='active'?'selected':''}>Active</option>
        <option value="inactive" ${state.studentUserStatusFilter==='inactive'?'selected':''}>Inactive</option>
        <option value="rejected" ${state.studentUserStatusFilter==='rejected'?'selected':''}>Rejected</option>
      </select>
      <button class="btn btn-sm" id="autoGenBtn">⚡ Auto-Generate Student Logins</button>
    </div>
    <table class="roster">
      <thead><tr><th>Name</th><th>Registration No.</th><th>Roll No.</th><th>Username</th><th>Status</th><th>Last Login</th><th>Actions</th></tr></thead>
      <tbody>
        ${list.map(u=>{
          const linked = u.studentId ? studentById(u.studentId) : (u.pendingProfile || null);
          return `
          <tr>
            <td class="td-name">${escapeHtml(u.fullName)}</td>
            <td class="roll-mono">${escapeHtml(u.userId || (linked?linked.regNo:"") || "—")}</td>
            <td class="roll-mono">${escapeHtml(linked ? linked.rollNo : "—")}</td>
            <td class="roll-mono">${escapeHtml(u.username)}</td>
            <td>${statusPill(u.status)}</td>
            <td style="font-size:12px;color:var(--text-faint);">${u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "Never"}</td>
            <td class="td-status">
              <div class="status-btns">
                ${u.status==="pending" ? `
                  <button class="btn btn-sm btn-success" data-approve-user="${u.id}">✅ Approve</button>
                  <button class="btn btn-sm btn-outline-danger" data-reject-user="${u.id}">✖️ Reject</button>
                  <button class="btn btn-sm btn-outline-danger" data-del-user="${u.id}">🗑️ Delete</button>
                ` : `
                  <button class="btn btn-sm" data-edit-user="${u.id}">✏️ Edit</button>
                  <button class="btn btn-sm" data-reset-pw="${u.id}">🔑 Reset Password</button>
                  ${u.status!=="rejected" ? `<button class="btn btn-sm ${u.status==='active'?'btn-outline-danger':'btn-outline-success'}" data-toggle-status="${u.id}">${u.status==='active'?'⏸️ Deactivate':'▶️ Activate'}</button>` : ""}
                  <button class="btn btn-sm btn-outline-danger" data-del-user="${u.id}">🗑️ Delete</button>
                `}
              </div>
            </td>
          </tr>`;}).join("") || `<tr><td colspan="7"><div class="empty-state"><div class="emoji">🔎</div>No student accounts match.</div></td></tr>`}
      </tbody>
    </table>
  </div>`;
}

// Consistent status pill across Student/Admin tables — active/inactive keep
// the original look, pending and rejected get their own distinct colors.
function statusPill(status){
  if(status==="pending") return `<span class="pill unmarked" style="color:var(--amber);">Pending</span>`;
  if(status==="rejected") return `<span class="pill absent">Rejected</span>`;
  return `<span class="pill ${status==='active'?'present':'absent'}">${status==='active'?'Active':'Inactive'}</span>`;
}

function renderAdminAccountsSection(allAdmins){
  let list = allAdmins;
  const q = state.adminUserSearch.trim().toLowerCase();
  if(q) list = list.filter(u => u.fullName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) || (u.designation||"").toLowerCase().includes(q));
  if(state.adminUserStatusFilter !== "all") list = list.filter(u => u.status === state.adminUserStatusFilter);
  const totalAdmins = allAdmins.filter(u=>u.designation==="Admin").length;
  const totalTeachers = allAdmins.filter(u=>u.designation!=="Admin").length;
  const active = allAdmins.filter(u=>u.status==="active").length;
  const pendingCount = allAdmins.filter(u=>u.status==="pending").length;
  const isPrimary = currentUser.id === "u1";

  return `
  <div class="stat-grid">
    <div class="stat-card stat-total"><div class="ic">🛡️</div><div class="lbl">Total Admins</div><div class="val">${totalAdmins}</div></div>
    <div class="stat-card stat-pct"><div class="ic">👨‍🏫</div><div class="lbl">Total Teachers</div><div class="val">${totalTeachers}</div></div>
    <div class="stat-card stat-present"><div class="ic">✅</div><div class="lbl">Active</div><div class="val">${active}</div></div>
    <div class="stat-card stat-absent"><div class="ic">⏸️</div><div class="lbl">Inactive</div><div class="val">${allAdmins.length-active}</div></div>
  </div>
  ${pendingCount ? `<div class="note-strip">🔔 <span><b>${pendingCount}</b> Admin/Teacher registration${pendingCount===1?"":"s"} waiting for approval${isPrimary?" — filter by <b>Pending</b> below.":". Only the Primary Admin can review these."}</span></div>` : ""}
  <div class="panel">
    <div class="panel-toolbar">
      <div class="search-input"><span class="ic">🔍</span><input id="adminUserSearch" placeholder="Search name, username, role..." value="${escapeHtml(state.adminUserSearch)}"></div>
      <select class="field-input" id="adminUserStatusFilter" style="max-width:160px;">
        <option value="all" ${state.adminUserStatusFilter==='all'?'selected':''}>All statuses</option>
        <option value="pending" ${state.adminUserStatusFilter==='pending'?'selected':''}>Pending${pendingCount?` (${pendingCount})`:""}</option>
        <option value="active" ${state.adminUserStatusFilter==='active'?'selected':''}>Active</option>
        <option value="inactive" ${state.adminUserStatusFilter==='inactive'?'selected':''}>Inactive</option>
        <option value="rejected" ${state.adminUserStatusFilter==='rejected'?'selected':''}>Rejected</option>
      </select>
    </div>
    <table class="roster">
      <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last Login</th><th>Actions</th></tr></thead>
      <tbody>
        ${list.map(u=>`
          <tr>
            <td class="td-name">${escapeHtml(u.fullName)}${u.id===currentUser.id?' <span class="pill unmarked" style="padding:2px 8px;">you</span>':''}${u.id==='u1'?' <span class="pill unmarked" style="padding:2px 8px;">primary</span>':''}</td>
            <td class="roll-mono">${escapeHtml(u.username)}</td>
            <td>${u.designation==='Admin'?'🛡️ Admin':'👨‍🏫 Teacher'}</td>
            <td>${statusPill(u.status)}</td>
            <td style="font-size:12px;color:var(--text-faint);">${u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "Never"}</td>
            <td class="td-status">
              <div class="status-btns">
                ${u.status==="pending" ? (isPrimary ? `
                  <button class="btn btn-sm btn-success" data-approve-user="${u.id}">✅ Approve</button>
                  <button class="btn btn-sm btn-outline-danger" data-reject-user="${u.id}">✖️ Reject</button>
                  <button class="btn btn-sm btn-outline-danger" data-del-user="${u.id}">🗑️ Delete</button>
                ` : `<span class="pill unmarked">Only the Primary Admin can review this</span>`) : `
                  <button class="btn btn-sm" data-edit-user="${u.id}">✏️ Edit</button>
                  <button class="btn btn-sm" data-reset-pw="${u.id}">🔑 Reset Password</button>
                  ${u.status!=="rejected" ? `<button class="btn btn-sm ${u.status==='active'?'btn-outline-danger':'btn-outline-success'}" data-toggle-status="${u.id}">${u.status==='active'?'⏸️ Deactivate':'▶️ Activate'}</button>` : ""}
                  ${u.id!==currentUser.id && u.id!=='u1' ? `<button class="btn btn-sm btn-outline-danger" data-del-user="${u.id}">🗑️ Delete</button>` : ""}
                `}
              </div>
            </td>
          </tr>`).join("") || `<tr><td colspan="6"><div class="empty-state"><div class="emoji">🔎</div>No Admin/Teacher accounts match.</div></td></tr>`}
      </tbody>
    </table>
  </div>`;
}

function bindUserManagementEvents(){
  document.getElementById("addUserBtn").onclick = ()=> openAddUserChoiceModal();
  document.querySelectorAll("[data-user-tab]").forEach(b=>{
    b.onclick = ()=>{ state.userTab = b.dataset.userTab; renderView(); };
  });

  if(state.userTab === "admin"){
    document.getElementById("adminUserSearch").oninput = e=>{ state.adminUserSearch = e.target.value; renderView(); };
    document.getElementById("adminUserStatusFilter").onchange = e=>{ state.adminUserStatusFilter = e.target.value; renderView(); };
  }else{
    document.getElementById("studentUserSearch").oninput = e=>{ state.studentUserSearch = e.target.value; renderView(); };
    document.getElementById("studentUserStatusFilter").onchange = e=>{ state.studentUserStatusFilter = e.target.value; renderView(); };
    document.getElementById("autoGenBtn").onclick = ()=> runAutoGenerateStudentLogins();
  }
  bindUserRowActions();
}

// Shared by both the Student and Admin/Teacher tables — Edit/Reset
// Password/Activate-Deactivate/Delete all work identically either way, they
// just operate on whichever rows are currently on screen.
function bindUserRowActions(){
  document.querySelectorAll("[data-edit-user]").forEach(b=> b.onclick = ()=> openUserModal(b.dataset.editUser));
  document.querySelectorAll("[data-reset-pw]").forEach(b=> b.onclick = ()=> openResetPasswordModal(b.dataset.resetPw));
  document.querySelectorAll("[data-approve-user]").forEach(b=>{
    b.onclick = async ()=>{
      const u = DB.users.find(x=>x.id===b.dataset.approveUser);
      if(u.role==="admin" && currentUser.id!=="u1"){ toast("Only the Primary Admin can approve Admin/Teacher registrations","error"); return; }
      const ok = await confirmModal({title:"Approve this registration?", message:`${u.fullName} will be able to sign in immediately.`, confirmText:"Approve"});
      if(!ok) return;
      if(u.role==="student" && u.pendingProfile){
        const p = u.pendingProfile;
        const dupeRoll = DB.students.find(s=>!s.deleted && s.rollNo.toLowerCase()===p.rollNo.toLowerCase());
        const dupeBoard = DB.students.find(s=>!s.deleted && (s.boardRoll||"").toLowerCase()===p.boardRoll.toLowerCase());
        if(dupeRoll || dupeBoard){
          toast(`Can't approve — Class Roll No. or Board Roll No. now collides with an existing student (${(dupeRoll||dupeBoard).name}). Edit one of them first.`,"error");
          return;
        }
        const student = addStudent(p);
        u.studentId = student.id;
      }
      u.status = "active";
      u.updatedAt = Date.now();
      saveDB(DB);
      addLog(`${u.role==="admin"?"Admin/Teacher":"Student"} registration approved: ${u.fullName}`);
      toast("Registration approved","success"); renderView();
    };
  });
  document.querySelectorAll("[data-reject-user]").forEach(b=>{
    b.onclick = async ()=>{
      const u = DB.users.find(x=>x.id===b.dataset.rejectUser);
      if(u.role==="admin" && currentUser.id!=="u1"){ toast("Only the Primary Admin can reject Admin/Teacher registrations","error"); return; }
      const ok = await confirmModal({title:"Reject this registration?", message:`${u.fullName} will not be able to sign in. The request stays on record as Rejected.`, confirmText:"Reject", danger:true});
      if(!ok) return;
      u.status = "rejected";
      u.updatedAt = Date.now();
      saveDB(DB);
      addLog(`${u.role==="admin"?"Admin/Teacher":"Student"} registration rejected: ${u.fullName}`);
      toast("Registration rejected","success"); renderView();
    };
  });
  document.querySelectorAll("[data-toggle-status]").forEach(b=>{
    b.onclick = async ()=>{
      const u = DB.users.find(x=>x.id===b.dataset.toggleStatus);
      const activating = u.status !== "active";
      if(!activating && u.id===currentUser.id){ toast("You can't deactivate your own account while logged in","error"); return; }
      if(!activating){
        const adminCount = DB.users.filter(x=>x.role==="admin" && x.status==="active").length;
        if(u.role==="admin" && adminCount<=1){ toast("Can't deactivate the last active Admin/Teacher account","error"); return; }
      }
      const ok = await confirmModal({title:`${activating?"Activate":"Deactivate"} this account?`, message:`${u.fullName} will ${activating?"regain":"lose"} the ability to log in.`, confirmText: activating?"Activate":"Deactivate", danger:!activating});
      if(!ok) return;
      u.status = activating ? "active" : "inactive";
      if(!activating) u.sessionVersion = (u.sessionVersion||0)+1; // kick out any active session immediately
      u.updatedAt = Date.now();
      saveDB(DB); addLog(`${u.fullName} account ${activating?"activated":"deactivated"}`);
      toast(`Account ${activating?"activated":"deactivated"}`,"success"); renderView();
    };
  });
  document.querySelectorAll("[data-del-user]").forEach(b=>{
    b.onclick = async ()=>{
      const u = DB.users.find(x=>x.id===b.dataset.delUser);
      if(u.id==="u1"){ toast("The primary Admin account can't be deleted","error"); return; }
      const adminCount = DB.users.filter(x=>x.role==="admin").length;
      if(u.role==="admin" && adminCount<=1){ toast("Can't delete the last Admin/Teacher account","error"); return; }
      const ok = await confirmModal({title:"Delete this user?", message:`${u.fullName}'s login will be permanently removed. This cannot be undone.`, confirmText:"Delete", danger:true});
      if(ok){
        DB.users = DB.users.filter(x=>x.id!==u.id);
        DB.deletedUserIds = (DB.deletedUserIds||[]).concat(u.id);
        saveDB(DB); addLog(`User deleted: ${u.fullName}`); toast("User deleted","success"); renderView();
      }
    };
  });
}

// "Add User" asks Student vs Admin/Teacher first, then opens a form tailored
// to that choice (see requirement: show the appropriate form, not one giant
// generic one).
function openAddUserChoiceModal(){
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:380px;">
      <h3>➕ Add User</h3>
      <p class="sub">What type of account do you want to create?</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px;">
        <button class="btn btn-primary btn-block" id="addChooseStudent" style="justify-content:flex-start;padding:14px 16px;">🎓 Add Student</button>
        <button class="btn btn-block" id="addChooseAdmin" style="justify-content:flex-start;padding:14px 16px;">👨‍🏫 Add Admin/Teacher</button>
      </div>
      <div class="actions" style="margin-top:18px;"><button class="btn" id="addChooseCancel">Cancel</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#addChooseCancel").onclick = ()=> backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
  backdrop.querySelector("#addChooseStudent").onclick = ()=>{ backdrop.remove(); openUserModal(null, "student"); };
  backdrop.querySelector("#addChooseAdmin").onclick = ()=>{ backdrop.remove(); openUserModal(null, "admin"); };
}

// Bulk-creates a Student account for every active student who doesn't already
// have one linked, using username = Registration No. and password = first 4
// letters of first name (uppercase) + last 3 digits of Reg No. Since passwords
// are hashed immediately and never stored in plain text, the returned `created`
// list is the ONLY moment these temporary passwords are ever visible.
async function generateMissingStudentAccounts(){
  const linkedIds = new Set(DB.users.filter(u=>u.studentId).map(u=>u.studentId));
  const candidates = activeStudents().filter(s=>!linkedIds.has(s.id));
  const created = [];
  for(const stu of candidates){
    if(!stu.regNo) continue; // no Reg No. on file — skip, nothing safe to generate
    const username = generateStudentUsername(stu);
    if(DB.users.find(u=>u.username.toLowerCase()===username.toLowerCase())) continue; // avoid collisions
    const password = generateStudentPassword(stu);
    const user = {
      id:"u"+Date.now()+Math.random().toString(36).slice(2,6), fullName:stu.name, username, role:"student",
      userId:stu.regNo, email:"", mobile:"", studentId:stu.id,
      branch:"", semester:"", section:"", subject:"",
      status:"active", lastLogin:null, createdAt:new Date().toISOString(), sessionVersion:0
    };
    // Students never change/reset their own password (only an Admin can,
    // from User Management), so this account is never force-flagged into
    // the "set a new password" screen — it logs straight into the Dashboard.
    await setUserPassword(user, password, false);
    DB.users.push(user);
    created.push({ name:stu.name, username, password });
  }
  return { created, skipped: candidates.length - created.length, candidateCount: candidates.length };
}

// Manual trigger from User Management — asks first, shows results immediately.
async function runAutoGenerateStudentLogins(){
  const linkedIds = new Set(DB.users.filter(u=>u.studentId).map(u=>u.studentId));
  const candidateCount = activeStudents().filter(s=>!linkedIds.has(s.id)).length;
  if(!candidateCount){ toast("Every active student already has a linked account","info"); return; }
  const ok = await confirmModal({
    title:"Auto-generate student logins?",
    message:`This creates up to ${candidateCount} new Student account${candidateCount===1?"":"s"} — username = Registration No., password = first 4 letters of first name + last 3 digits of Reg No. Students log in directly with these credentials — only an Admin/Teacher can reset a student's password later.`,
    confirmText:"Generate"
  });
  if(!ok) return;
  const { created, skipped } = await generateMissingStudentAccounts();
  saveDB(DB);
  addLog(`Auto-generated ${created.length} student login${created.length===1?"":"s"}${skipped?` (${skipped} skipped — missing Reg. No. or username clash)`:""}`);
  renderView();
  showGeneratedCredentialsModal(created, skipped);
}

// Automatic trigger at boot — runs silently for every student in the database
// with no login yet, with no confirmation dialog needed. The generated
// credentials are queued in DB.pendingCredentialReveal and shown to the
// Admin/Teacher the moment they reach the dashboard (see render()), since
// that's the only place these temporary passwords are ever visible.
async function autoProvisionStudentAccounts(){
  const { created } = await generateMissingStudentAccounts();
  if(!created.length) return;
  DB.pendingCredentialReveal = (DB.pendingCredentialReveal||[]).concat(created);
  addLog(`Auto-generated ${created.length} student login${created.length===1?"":"s"} (automatic provisioning for all students)`);
  saveDB(DB);
}
function showGeneratedCredentialsModal(created, skipped){
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:520px;max-height:88vh;overflow:auto;">
      <h3>⚡ ${created.length} Student Login${created.length===1?"":"s"} Created</h3>
      <p class="sub">Share these with each student — this is the only time the password is shown. Each account must set a new password on first login.</p>
      <div style="max-height:340px;overflow:auto;border:1px solid var(--border);border-radius:10px;">
        <table class="roster" style="font-size:13px;">
          <thead><tr><th>Name</th><th>Username</th><th>Temp Password</th></tr></thead>
          <tbody>
            ${created.map(c=>`<tr><td>${escapeHtml(c.name)}</td><td class="roll-mono">${escapeHtml(c.username)}</td><td class="roll-mono">${escapeHtml(c.password)}</td></tr>`).join("") || `<tr><td colspan="3"><div class="empty-state"><div class="emoji">🔎</div>Nothing generated.</div></td></tr>`}
          </tbody>
        </table>
      </div>
      ${skipped ? `<p class="sub" style="margin-top:10px;">${skipped} student${skipped===1?" was":"s were"} skipped (missing Registration No. or a username clash with an existing account) — add those manually via Add User.</p>`:""}
      <div class="actions">
        <button class="btn" id="gcCopy">📋 Copy List</button>
        <button class="btn btn-primary btn-block" id="gcClose">Done</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#gcClose").onclick = ()=> backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
  backdrop.querySelector("#gcCopy").onclick = async ()=>{
    const text = created.map(c=>`${c.name}\t${c.username}\t${c.password}`).join("\n");
    await navigator.clipboard.writeText(`Name\tUsername\tTemporary Password\n${text}`);
    toast("Copied to clipboard","success");
  };
}

function openUserModal(editId, presetRole){
  const editing = editId ? DB.users.find(u=>u.id===editId) : null;
  const role = editing ? editing.role : (presetRole === "admin" ? "admin" : "student");
  const isAdmin = role === "admin";
  const activeStuds = activeStudents();
  // Privacy of the Primary Admin: their email/mobile are visible and
  // editable only by the Primary Admin themself — every other Admin/Teacher
  // sees a locked notice instead, whether they're viewing or editing that
  // account.
  const canSeePrimaryContact = !(editing && editing.id === "u1") || currentUser.id === "u1";
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal" style="max-width:480px;max-height:88vh;overflow:auto;">
      <h3>${editing ? "✏️ Edit User" : (isAdmin ? "➕ Add Admin/Teacher" : "➕ Add Student")}</h3>
      <p class="sub">${editing?"Update account details.":(isAdmin?"Create a new Admin/Teacher login.":"Create a new Student login.")}</p>
      <div id="umError"></div>
      <div class="field"><label>Full Name${reqStar()}</label><input class="field-input" id="umName" value="${editing?escapeHtml(editing.fullName):""}"></div>
      <div class="field" id="umUserIdWrap"><label>Registration No.${reqStar()}</label><input class="field-input" id="umUserId" value="${editing?escapeHtml(editing.userId||""):""}"></div>
      <div class="field" id="umDesignationWrap"><label>Designation</label>
        <select class="field-input" id="umDesignation">
          <option value="Teacher" ${editing?.designation!=='Admin'?'selected':''}>Teacher</option>
          <option value="Admin" ${editing?.designation==='Admin'?'selected':''}>Admin</option>
        </select>
      </div>
      ${canSeePrimaryContact ? `
      <div class="field"><label>Email (optional)</label><input class="field-input" id="umEmail" type="email" value="${editing?escapeHtml(editing.email||""):""}"></div>
      <div class="field"><label>Mobile (optional)</label><input class="field-input" id="umMobile" value="${editing?escapeHtml(editing.mobile||""):""}"></div>
      ` : `
      <div class="note-strip">🔒 <span>Email and mobile for the primary Admin account are private — only the primary Admin can view or edit them.</span></div>
      `}
      <div class="field"><label>Username${reqStar()}</label><input class="field-input" id="umUsername" autocomplete="off" value="${editing?escapeHtml(editing.username):""}"></div>
      ${!editing ? `
      <div class="field"><label>Password${reqStar()}</label><div class="password-field"><input class="field-input" id="umPassword" type="password" autocomplete="new-password"><button type="button" class="pw-toggle" id="umPasswordToggle" aria-label="Show password">👁️</button></div></div>
      <div class="field"><label>Confirm Password${reqStar()}</label><div class="password-field"><input class="field-input" id="umConfirm" type="password" autocomplete="new-password"><button type="button" class="pw-toggle" id="umConfirmToggle" aria-label="Show password">👁️</button></div></div>
      <div id="umStrength" class="strength-meter"></div>
      ` : ""}
      ${editing ? `
      <div class="field"><label>Role</label>
        <select class="field-input" id="umRole">
          <option value="admin" ${role==='admin'?'selected':''}>Admin / Teacher</option>
          <option value="student" ${role==='student'?'selected':''}>Student</option>
        </select>
      </div>` : `<input type="hidden" id="umRole" value="${role}">`}
      <div class="field" id="umStudentLinkWrap">
        <label>Link to Student Record (optional)</label>
        <select class="field-input" id="umStudentLink">
          <option value="">— Not linked —</option>
          ${activeStuds.map(s=>`<option value="${s.id}" ${editing?.studentId===s.id?'selected':''}>${escapeHtml(s.name)} — ${escapeHtml(s.rollNo)}</option>`).join("")}
        </select>
      </div>
      <div class="field" id="umBranchWrap"><label>Branch</label><input class="field-input" id="umBranch" value="${editing?escapeHtml(editing.branch||""):""}"></div>
      <div class="field" id="umSemesterWrap"><label>Semester</label><input class="field-input" id="umSemester" value="${editing?escapeHtml(editing.semester||""):""}"></div>
      <div class="field" id="umSectionWrap"><label>Section</label><input class="field-input" id="umSection" value="${editing?escapeHtml(editing.section||""):""}"></div>
      <div class="field" id="umSubjectWrap"><label>Subject taught (optional)</label><input class="field-input" id="umSubject" value="${editing?escapeHtml(editing.subject||""):""}"></div>
      <div class="field"><label>Status</label>
        <select class="field-input" id="umStatus">
          <option value="active" ${!editing||editing.status==='active'?'selected':''}>Active</option>
          <option value="inactive" ${editing?.status==='inactive'?'selected':''}>Inactive</option>
        </select>
      </div>
      <div class="actions">
        <button class="btn" id="umCancel">Cancel</button>
        <button class="btn btn-primary" id="umSave">${editing?"Save Changes":"Create User"}</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const roleSel = backdrop.querySelector("#umRole");
  const linkWrap = backdrop.querySelector("#umStudentLinkWrap");
  const userIdWrap = backdrop.querySelector("#umUserIdWrap");
  const branchWrap = backdrop.querySelector("#umBranchWrap");
  const semesterWrap = backdrop.querySelector("#umSemesterWrap");
  const sectionWrap = backdrop.querySelector("#umSectionWrap");
  const designationWrap = backdrop.querySelector("#umDesignationWrap");
  const subjectWrap = backdrop.querySelector("#umSubjectWrap");
  // Shows only the fields relevant to the account type being created/edited —
  // Registration No./Student link/Branch/Semester/Section for Students,
  // Designation/Subject-taught for Admin/Teacher — per the "appropriate
  // form" requirement, instead of one generic form for every account type.
  const syncFieldVisibility = ()=>{
    const admin = roleSel.value === "admin";
    linkWrap.style.display = admin ? "none" : "";
    userIdWrap.style.display = admin ? "none" : "";
    branchWrap.style.display = admin ? "none" : "";
    semesterWrap.style.display = admin ? "none" : "";
    sectionWrap.style.display = admin ? "none" : "";
    designationWrap.style.display = admin ? "" : "none";
    subjectWrap.style.display = admin ? "" : "none";
  };
  syncFieldVisibility();
  if(roleSel.tagName === "SELECT") roleSel.onchange = syncFieldVisibility;
  const pwInput = backdrop.querySelector("#umPassword");
  if(pwInput) pwInput.oninput = e=> renderStrengthMeter("umStrength", e.target.value);
  wirePasswordToggle("umPassword", "umPasswordToggle");
  wirePasswordToggle("umConfirm", "umConfirmToggle");
  const linkSel = backdrop.querySelector("#umStudentLink");
  if(linkSel && !editing){
    linkSel.onchange = ()=>{
      const stu = activeStuds.find(s=>s.id===linkSel.value);
      if(!stu) return;
      const nameEl = document.getElementById("umName"), userEl = document.getElementById("umUsername");
      const pwEl = document.getElementById("umPassword"), confirmEl = document.getElementById("umConfirm"), idEl = document.getElementById("umUserId");
      if(nameEl && !nameEl.value.trim()) nameEl.value = stu.name;
      if(idEl && !idEl.value.trim()) idEl.value = stu.regNo || "";
      if(userEl && !userEl.value.trim()) userEl.value = generateStudentUsername(stu);
      if(pwEl && !pwEl.value){ const pw = generateStudentPassword(stu); pwEl.value = pw; if(confirmEl) confirmEl.value = pw; renderStrengthMeter("umStrength", pw); }
      toast("Username & temporary password auto-filled from Reg. No.","info");
    };
  }
  backdrop.querySelector("#umCancel").onclick = ()=> backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
  backdrop.querySelector("#umSave").onclick = async ()=>{
    const fullName = document.getElementById("umName").value.trim();
    const username = document.getElementById("umUsername").value.trim();
    const finalRole = document.getElementById("umRole").value;
    const finalIsAdmin = finalRole === "admin";
    const showErr = (msg)=>{ document.getElementById("umError").innerHTML = `<div class="login-error">⚠️ ${escapeHtml(msg)}</div>`; };
    const requiredFields = [{id:"umName", label:"Full Name"}, {id:"umUsername", label:"Username"}];
    if(!finalIsAdmin) requiredFields.push({id:"umUserId", label:"Registration No."});
    if(!editing) requiredFields.push({id:"umPassword", label:"Password"}, {id:"umConfirm", label:"Confirm Password"});
    const missing = validateRequired(requiredFields);
    if(missing.length){ showErr(`Please fill in: ${missing.join(", ")}.`); return; }
    const dupe = DB.users.find(u=>u.username.toLowerCase()===username.toLowerCase() && u.id!==editId);
    if(dupe){ showErr("That username is already taken."); return; }
    if(!editing){
      const pw = document.getElementById("umPassword").value, confirm = document.getElementById("umConfirm").value;
      const pwErr = validateNewPassword(pw, confirm);
      if(pwErr){ showErr(pwErr); return; }
    }
    const fields = {
      fullName, username,
      userId: finalIsAdmin ? (editing?.userId || "") : document.getElementById("umUserId").value.trim(),
      email: canSeePrimaryContact ? document.getElementById("umEmail").value.trim() : (editing?.email || ""),
      mobile: canSeePrimaryContact ? document.getElementById("umMobile").value.trim() : (editing?.mobile || ""),
      role: finalRole,
      designation: finalIsAdmin ? document.getElementById("umDesignation").value : undefined,
      studentId: finalIsAdmin ? null : (document.getElementById("umStudentLink").value || null),
      branch: finalIsAdmin ? (editing?.branch || "") : document.getElementById("umBranch").value.trim(),
      semester: finalIsAdmin ? (editing?.semester || "") : document.getElementById("umSemester").value.trim(),
      section: finalIsAdmin ? (editing?.section || "") : document.getElementById("umSection").value.trim(),
      subject: document.getElementById("umSubject").value.trim(),
      status: document.getElementById("umStatus").value
    };
    if(editing){
      Object.assign(editing, fields);
      if(!finalIsAdmin) delete editing.designation;
      editing.updatedAt = Date.now();
      addLog(`User updated: ${fullName}`); toast("User updated","success");
    }else{
      const user = { id:"u"+Date.now(), ...fields, lastLogin:null, createdAt:new Date().toISOString(), sessionVersion:0 };
      await setUserPassword(user, document.getElementById("umPassword").value, finalIsAdmin);
      DB.users.push(user);
      addLog(`User created: ${fullName} (${finalIsAdmin?(fields.designation||'Admin/Teacher'):'Student'})`); toast("User created","success");
    }
    saveDB(DB); backdrop.remove();
    state.userTab = finalIsAdmin ? "admin" : "student";
    renderView();
  };
}

function openResetPasswordModal(userId){
  const u = DB.users.find(x=>x.id===userId);
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal">
      <h3>🔑 Reset Password</h3>
      <p class="sub">Set a new temporary password for <b>${escapeHtml(u.fullName)}</b>.</p>
      <div id="rpwError"></div>
      <div class="field"><label>New Temporary Password</label><div class="password-field"><input class="field-input" id="rpwNew" type="password" autocomplete="new-password"><button type="button" class="pw-toggle" id="rpwNewToggle" aria-label="Show password">👁️</button></div></div>
      <div class="field"><label>Confirm Password</label><div class="password-field"><input class="field-input" id="rpwConfirm" type="password" autocomplete="new-password"><button type="button" class="pw-toggle" id="rpwConfirmToggle" aria-label="Show password">👁️</button></div></div>
      <div id="rpwStrength" class="strength-meter"></div>
      ${u.role==="admin"
        ? `<label class="remember-row"><input type="checkbox" id="rpwForce" checked/> Force password change on next login</label>`
        : `<p class="sub" style="text-align:left;">Students log in directly with this password — they can't reset or change it themselves.</p>`}
      <div class="actions">
        <button class="btn" id="rpwCancel">Cancel</button>
        <button class="btn btn-primary" id="rpwSave">Reset Password</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#rpwNew").oninput = e=> renderStrengthMeter("rpwStrength", e.target.value);
  wirePasswordToggle("rpwNew", "rpwNewToggle");
  wirePasswordToggle("rpwConfirm", "rpwConfirmToggle");
  backdrop.querySelector("#rpwCancel").onclick = ()=> backdrop.remove();
  backdrop.addEventListener("click", e=>{ if(e.target===backdrop) backdrop.remove(); });
  backdrop.querySelector("#rpwSave").onclick = async ()=>{
    const pw = document.getElementById("rpwNew").value, confirm = document.getElementById("rpwConfirm").value;
    const err = validateNewPassword(pw, confirm);
    if(err){ document.getElementById("rpwError").innerHTML = `<div class="login-error">⚠️ ${escapeHtml(err)}</div>`; return; }
    const force = u.role==="admin" && document.getElementById("rpwForce").checked;
    await setUserPassword(u, pw, force);
    saveDB(DB);
    addLog(`Password reset for ${u.fullName} by ${currentUser.fullName}`);
    toast("Password reset successfully.","success");
    backdrop.remove(); renderView();
  };
}

/* ---------------------------------------------------------
   LOGS (admin only)
--------------------------------------------------------- */
function renderLogs(){
  return `
  <div class="section-title">
    <h2>📝 Activity Log</h2>
    <button class="btn btn-sm btn-outline-danger" id="clearLogsBtn">🗑️ Clear Activity Log</button>
  </div>
  <div class="panel">
    ${DB.logs.map(l=>`
      <div class="log-item"><div class="dot"></div><div><div>${escapeHtml(l.text)} <span style="color:var(--text-faint);">— ${escapeHtml(l.by)}</span></div><div class="time">${new Date(l.at).toLocaleString()}</div></div></div>
    `).join("") || `<div class="empty-state"><div class="emoji">📝</div>No activity yet.</div>`}
  </div>`;
}
// Clears only DB.logs — never touches students, attendance, reports, subjects,
// or settings. The clear action itself is logged immediately after (a single
// fresh entry), same as any real audit log would do, so there's always a
// record of who cleared it and when.
function bindLogsEvents(){
  document.getElementById("clearLogsBtn").onclick = async ()=>{
    if(!DB.logs.length){ toast("Activity Log is already empty","info"); return; }
    const ok = await confirmModal({title:"Clear Activity Log?", message:"All activity history will be permanently deleted. This cannot be undone.", confirmText:"Clear Log", danger:true});
    if(!ok) return;
    DB.logs = [];
    saveDB(DB);
    addLog("Activity Log cleared");
    toast("Activity Log Cleared Successfully.","success");
    renderView();
  };
}

/* ---------------------------------------------------------
   BACKUP (admin only)
--------------------------------------------------------- */
function renderBackup(){
  return `
  <div class="settings-grid">
    <div class="card settings-card">
      <h4>📤 Export</h4>
      <p class="sub" style="text-align:left;">Download a full backup of students, history, users and settings as JSON.</p>
      <button class="btn btn-success btn-block" id="exportJsonBtn">💾 Export JSON Backup</button>
    </div>
    <div class="card settings-card">
      <h4>📥 Import</h4>
      <p class="sub" style="text-align:left;">Restore from a previously exported JSON backup. This replaces current data.</p>
      <input type="file" id="importFile" accept="application/json" class="field-input">
      <button class="btn btn-primary btn-block" id="importJsonBtn" style="margin-top:10px;">📥 Import & Restore</button>
    </div>
  </div>`;
}
function bindBackupEvents(){
  document.getElementById("exportJsonBtn").onclick = ()=>{
    downloadFile(`esh-attendance-backup-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(DB, null, 2));
    addLog("Backup exported"); toast("Backup completed successfully","success");
  };
  document.getElementById("importJsonBtn").onclick = ()=>{
    const file = document.getElementById("importFile").files[0];
    if(!file){ toast("Choose a JSON file first","error"); return; }
    const reader = new FileReader();
    reader.onload = ()=>{
      try{
        const parsed = JSON.parse(reader.result);
        if(!parsed.students) throw new Error("Invalid backup file");
        DB = parsed; saveDB(DB); addLog("Data restored from backup file");
        toast("Backup restored","success"); render();
      }catch(e){ toast("Invalid backup file","error"); }
    };
    reader.readAsText(file);
  };
}

/* ---------------------------------------------------------
   ABOUT
--------------------------------------------------------- */
function renderAbout(){
  const connected = window.FirestoreSync && window.FirestoreSync.enabled;
  return `
  <div class="card" style="padding:24px;max-width:640px;">
    <h3>👥 Class Attendance Manager</h3>
    <p style="color:var(--text-dim);line-height:1.7;">Built to take attendance in under a minute. Data is stored locally on this device first (so it always works with zero setup and no internet connection)${connected?", and syncs to Firebase in real time across every signed-in device.":"."}</p>
    ${connected ? `
    <h4>☁️ Cloud Sync — Connected</h4>
    <p style="color:var(--text-dim);line-height:1.7;">This device is connected to Firebase. Students, subjects, sessions, registers, history and reports all sync automatically to every other signed-in device — no manual refresh needed. If the internet drops, the app keeps working fully offline from the local copy and syncs the moment the connection returns.</p>` : `
    <h4>☁️ Connecting real Cloud Sync (optional)</h4>
    <ol style="color:var(--text-dim);line-height:1.9;">
      <li>Create a free project at <b>console.firebase.google.com</b></li>
      <li>Enable <b>Firestore Database</b> (in production mode) — then, in <b>Build → Authentication → Sign-in method</b>, enable the <b>Anonymous</b> provider (this app signs devices in anonymously so Firestore's rules can require a signed-in request; it does not use Email/Password)</li>
      <li>Paste the security rules from <code>firestore.rules</code> into <b>Firestore Database → Rules</b> and publish them</li>
      <li>Copy your web app config into <code>firebase/firebase-config.js</code></li>
      <li>Set <code>FIREBASE_ENABLED = true</code> at the top of that file</li>
      <li>Re-deploy — the app will then sync students, sessions and users in real time across every signed-in device</li>
    </ol>
    <p class="sub" style="text-align:left;">Until then, use <b>Settings → Backup & Restore</b> to move data between devices via JSON export/import.</p>`}
  </div>`;
}

/* ---------------------------------------------------------
   UTIL
--------------------------------------------------------- */
function downloadFile(filename, content){
  const blob = new Blob([content], {type:"text/plain"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------
   BOOT
--------------------------------------------------------- */
async function boot(){
  await initializeDefaultPasswords();
  await autoProvisionStudentAccounts();
  currentUser = currentUser || loadSession();
  if(currentUser) state.view = defaultViewFor(currentUser.role);
  loadOrResetMarksForSession();
  applyTheme();
  if(DB.settings.fontSize === "large") document.body.style.fontSize = "16px";
  render();

  // Cloud sync connects in the background so the app stays instant and
  // offline-first — local data is what renders first, Firebase catches up
  // a moment later and then keeps every device in sync in real time.
  // Started unconditionally at boot (not just when a remembered local
  // session is found) so DB.users is kept fresh from Firestore even on a
  // brand-new device that has never logged in here before — otherwise a
  // login attempt for an account created on another device would be
  // checked only against this device's own (empty/seed) local copy.
  // Sync status/toasts still never surface to a signed-out person — see
  // the currentUser guards inside connectCloudSync/setSyncStatus.
  connectCloudSync();
}
document.addEventListener("DOMContentLoaded", boot);

// One delegated listener covers every button app-wide, including ones inside
// modals created after the fact — no per-button wiring needed anywhere else.
document.addEventListener("pointerdown", e=>{
  const btn = e.target.closest(".btn");
  if(!btn || btn.disabled) return;
  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const ripple = document.createElement("span");
  ripple.className = "btn-ripple";
  ripple.style.width = ripple.style.height = size + "px";
  ripple.style.left = (e.clientX - rect.left - size/2) + "px";
  ripple.style.top = (e.clientY - rect.top - size/2) + "px";
  btn.appendChild(ripple);
  ripple.addEventListener("animationend", ()=> ripple.remove());
});

if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("./service-worker.js").catch(()=>{});
  });
}
