// firebase/firebase-config.js
//
// Connected to the "attendance-manager-gpm" Firebase project.
// FIREBASE_ENABLED is true, so js/app.js's cloud sync layer (see
// firebase/firestore-sync.js) is live: real-time multi-device sync via
// Firestore, layered on top of localStorage as an offline-first cache.
//
// Two things must ALSO be done once, in the Firebase Console, or sync will
// silently fail (see README.md -> "Connecting Firebase" for the full list):
//   1. Authentication -> Sign-in method -> enable the Anonymous provider
//      (this app signs devices in anonymously, not with Email/Password).
//   2. Firestore Database -> Rules -> paste the contents of firestore.rules
//      and Publish.

// firebase/firebase-config.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-analytics.js";

// Enable Firebase — set to true only after you've pasted your own project's
// config below (see README.md -> "Connecting Firebase").
export const FIREBASE_ENABLED = true;

// Firebase Project Configuration — replace with your own project's values
// from Firebase Console -> Project Settings -> General -> Your apps.
const firebaseConfig = {
  apiKey: "AIzaSyDvLWDoejEkO3hf_zOvVEQzX6QiYZkQvnQ",
  authDomain: "attendance-manager-gpm.firebaseapp.com",
  projectId: "attendance-manager-gpm",
  storageBucket: "attendance-manager-gpm.firebasestorage.app",
  messagingSenderId: "805050206991",
  appId: "1:805050206991:web:0b2be7275ff3b0c73f0c7a",
  measurementId: "G-HXTH3GKCXR"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);

// Firebase Services
export const auth = getAuth(app);
export const db = getFirestore(app);
export const analytics = getAnalytics(app);

console.log("✅ Firebase Connected Successfully");


// Example Firestore security rules to start from (paste into Firebase Console
// -> Firestore Database -> Rules), enforcing Admin/Teacher vs Student permissions:
//
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//     function isSignedIn() { return request.auth != null; }
//     function myUser() { return get(/databases/$(database)/documents/users/$(request.auth.uid)).data; }
//     function isAdmin() { return isSignedIn() && myUser().role == 'admin'; }
//     match /students/{studentId} {
//       allow read: if isSignedIn();
//       allow create, update: if isAdmin();
//       allow delete: if isAdmin();
//     }
//     match /sessions/{sessionId} {
//       // Admin/Teacher can read every session (needed for registers/reports).
//       // A Student reading the full session doc would see everyone's marks —
//       // acceptable for a small class, but if that's a concern, split each
//       // session's per-student status into its own subcollection instead
//       // (e.g. sessions/{sessionId}/marks/{studentId}) and scope THAT
//       // subcollection's reads to `request.auth.uid == studentId` so a
//       // Student's query can only ever return their own mark.
//       allow read: if isSignedIn();
//       allow create, update: if isAdmin();
//       allow delete: if isAdmin();
//     }
//     match /users/{userId} {
//       // Everyone can read their own account; only Admin/Teacher can read the
//       // full user list (needed for User Management) or write any account.
//       allow read: if isSignedIn() && (request.auth.uid == userId || isAdmin());
//       allow write: if isAdmin();
//     }
//   }
// }
