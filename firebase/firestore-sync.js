// firebase/firestore-sync.js
//
// Bridges the app's existing DB object (see js/app.js STORAGE section) to
// Cloud Firestore for real-time, multi-device sync — without changing how
// DB is used anywhere else in the app.
//
// STRATEGY: the whole DB object (students, subjects, sessions, users,
// settings, logs, liveAttendance) is mirrored as ONE Firestore document at
// appData/main. That mirrors how it's already stored locally today — one
// JSON blob under a single localStorage key — so this is additive rather
// than a data-model rewrite, and it's appropriate at class-roster scale
// (~50 students, a few hundred sessions/year — comfortably under
// Firestore's 1MB document limit). If this ever needs to scale to a whole
// department across many semesters, split `sessions` into its own
// subcollection at that point (see README "Suggested Firestore data shape").
//
// HONEST LIMITATION: Firestore still stores the whole app as ONE document
// (appData/main) for simplicity at class-roster scale, but js/app.js no
// longer treats an incoming copy as "replace everything" — see
// mergeCloudDB() in js/app.js, which unions students/users/subjects/
// sessions/logs by id and keeps whichever copy of a given record is newer
// (via each record's `updatedAt`), rather than letting whichever device
// happened to push last silently erase the other device's changes. That's
// what makes multi-device login, registration, and roster changes reliable
// even when two devices go offline and each make different edits before
// reconnecting. What's still last-write-wins: fields with no natural
// per-record id — Settings, class name, and the day's in-progress
// liveAttendance — which fall back to "whichever whole DB was saved most
// recently, wins" for just those fields. If simultaneous multi-device
// editing of the SAME session's marks becomes common, that's the point to
// split `sessions` into per-document records with field-level merge too.
//
// AUTH LIMITATION: this signs in anonymously to Firebase so Firestore
// security rules can require "request.auth != null" — it does NOT create a
// real per-user Firebase Authentication account for every Admin/Teacher/
// Student. The app's existing local username+password check (hashed,
// js/app.js AUTH section) still decides who gets into the UI. That means
// role-based data isolation (a Student's reads limited to their own record)
// is still enforced client-side, not by the server — same caveat the
// README already documents for the local-only build. Closing that gap for
// real needs individual Firebase Auth accounts per user, which in turn
// needs a small backend (Cloud Function with the Admin SDK) to bulk-create
// them — out of scope for a static-hosted app with no server component.
//
// Exposed as window.FirestoreSync since js/app.js is a classic (non-module)
// script and can't `import` this directly.

import { auth, db, FIREBASE_ENABLED } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, onSnapshot, enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import {
  signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";

const DOC_REF = FIREBASE_ENABLED ? doc(db, "appData", "main") : null;

let ready = false;
let pushTimer = null;
let lastMergeFn = null;
let onStatus = (msg) => console.log("[FirestoreSync]", msg);

async function enableOffline() {
  try {
    await enableIndexedDbPersistence(db);
  } catch (e) {
    // Expected to fail if multiple tabs of the app are open at once, or in
    // browsers without IndexedDB — non-fatal, the app just won't have an
    // offline cache in that specific tab.
    console.warn("Firestore offline persistence not enabled:", e.code || e);
  }
}

/**
 * @param {Object} opts
 * @param {() => Object} opts.getLocalDB   returns the current in-memory DB
 * @param {(remoteDB: Object) => void} opts.onRemoteChange  called when another
 *        device pushes a change (never called for our own pending writes)
 * @param {(local:Object, remote:Object)=>Object} [opts.mergeCloudDB] app.js's
 *        record-level merge function — used before every push so a write can
 *        never blindly clobber a newer change already on the server.
 * @param {(msg: string, type?: string) => void} [opts.onStatus]  UI toast hook
 */
async function init({ getLocalDB, onRemoteChange, mergeCloudDB, onStatus: statusCb }) {
  if (!FIREBASE_ENABLED) {
    console.log("Firebase disabled (FIREBASE_ENABLED=false) — running localStorage-only.");
    return { enabled: false };
  }
  if (statusCb) onStatus = statusCb;
  if (mergeCloudDB) lastMergeFn = mergeCloudDB;

  await enableOffline();

  await new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => { unsub(); resolve(user); });
    signInAnonymously(auth).catch((e) => {
      onStatus("Firebase sign-in failed: " + e.message, "error");
      resolve(null);
    });
  });

  try {
    const snap = await getDoc(DOC_REF);
    if (!snap.exists()) {
      // First device to ever connect this app to this Firebase project —
      // one-time upload of whatever's currently in localStorage.
      await setDoc(DOC_REF, { db: getLocalDB(), _updatedAt: Date.now() });
      onStatus("Connected to Firebase — local data uploaded", "success");
    } else {
      onRemoteChange(snap.data().db);
      onStatus("Connected to Firebase — synced", "success");
    }
  } catch (e) {
    onStatus("Firebase unreachable — working offline from local data", "info");
  }

  // Real-time listener for changes made on OTHER devices/tabs.
  // hasPendingWrites === true means this snapshot is our own optimistic
  // local write echoing back before the server has confirmed it — skip it,
  // we already applied that change locally. Only remote, server-confirmed
  // changes should trigger a re-merge.
  onSnapshot(DOC_REF, (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return;
    onRemoteChange(snap.data().db);
  }, (err) => {
    onStatus("Firebase sync error: " + err.message, "error");
  });

  ready = true;
  return { enabled: true };
}

/**
 * One-off fetch of whatever is currently in Firestore, WITHOUT waiting for
 * the realtime listener. Used before checking a login's credentials (see
 * js/app.js attemptLogin) so a brand-new account created on another device
 * can authenticate here even if this device's realtime listener hasn't
 * caught up yet, and even if nobody has ever logged into THIS device
 * before (i.e. before connectCloudSync's listener has had a chance to run).
 * Ensures anonymous sign-in first if this tab hasn't signed in yet.
 * Returns the remote `db` object, or null if Firebase is disabled,
 * unreachable, or the document doesn't exist yet.
 */
async function pullLatest() {
  if (!FIREBASE_ENABLED) return null;
  try {
    if (!auth.currentUser) {
      await new Promise((resolve) => {
        const unsub = onAuthStateChanged(auth, (user) => { unsub(); resolve(user); });
        signInAnonymously(auth).catch(() => resolve(null));
      });
    }
    const snap = await getDoc(DOC_REF);
    if (!snap.exists()) return null;
    return snap.data().db;
  } catch (e) {
    onStatus("Couldn't reach Firebase for latest login data: " + (e.message || e), "info");
    return null;
  }
}

/**
 * Fetches the current server doc and folds `dbObject` into it using the
 * exact same record-level merge (mergeCloudDB, passed in by app.js) used
 * for incoming changes — so a push can never blindly clobber a newer
 * change some other device already wrote to Firestore (e.g. a delete that
 * hasn't reached this device's realtime listener yet). Falls back to
 * writing `dbObject` as-is if the server can't be reached.
 */
async function mergeThenWrite(dbObject, mergeCloudDB) {
  let toWrite = dbObject;
  try {
    const snap = await getDoc(DOC_REF);
    if (snap.exists() && mergeCloudDB) {
      // Merge server-first, local-second so `dbObject`'s own edits (the
      // reason this push is happening) still win over anything genuinely
      // older on the server, while anything on the server that's newer
      // than what this device has seen (e.g. another device's delete)
      // is preserved rather than being overwritten.
      toWrite = mergeCloudDB(snap.data().db, dbObject);
    }
  } catch (e) {
    // Couldn't reach the server to merge first — write what we have rather
    // than lose the change entirely; the next successful sync reconciles it.
  }
  await setDoc(DOC_REF, { db: toWrite, _updatedAt: Date.now() });
  return toWrite;
}

/**
 * Debounced (or immediate) push of the full DB object to Firestore. Safe to
 * call on every saveDB(). Regular writes are batched briefly so rapid
 * successive edits (e.g. tapping through a register) coalesce into one
 * network write instead of one per tap; pass {immediate:true} for changes
 * that must reach other devices right away (deletes, restores, password/
 * account changes) — that path skips the debounce and merges-then-writes
 * immediately.
 * @param {(local:Object, remote:Object)=>Object} [mergeCloudDB] app.js's
 *        merge function, passed in via init() so this module doesn't need
 *        to duplicate that logic.
 */
function push(dbObject, opts) {
  if (!FIREBASE_ENABLED || !ready) return;
  const immediate = opts && opts.immediate;
  if (immediate) {
    clearTimeout(pushTimer);
    mergeThenWrite(dbObject, lastMergeFn).catch((e) => {
      onStatus("Sync failed, will retry on next change: " + e.message, "error");
    });
    return;
  }
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    mergeThenWrite(dbObject, lastMergeFn).catch((e) => {
      onStatus("Sync failed, will retry on next change: " + e.message, "error");
    });
  }, 250);
}

window.FirestoreSync = {
  init,
  push,
  pullLatest,
  get enabled() { return FIREBASE_ENABLED; },
  get ready() { return ready; },
};
