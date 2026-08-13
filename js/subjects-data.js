// subjects-data.js
// One-time seed list for your subjects. This is only ever read ONCE, the
// first time the app runs on a device (or when migrating a pre-Subject-
// Management database), to populate the real, editable subject list at
// DB.subjects. From then on DB.subjects is the single source of truth —
// see the Subject Management section in app.js (renderSubjects/
// openSubjectModal/etc) for everything that reads, adds, edits, or
// archives subjects.
//
// Add your own subjects here, or leave this empty and add them from the
// Admin Dashboard after deployment (Subjects -> Add Subject).
//
// Example:
// { code: "T1010101", name: "Engineering Mathematics", faculty: "Faculty Name" },

const SEED_SUBJECTS = [
];

// Turns the raw seed rows above into full DB.subjects records (id, semester,
// type, status). Called once from loadDB()/migrateDB() in app.js.
function seedSubjectsFromLegacy(){
  return SEED_SUBJECTS.map(s => ({
    id: "sub" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    code: s.code,
    name: s.name,
    semester: 5,
    facultyId: null,
    faculty: s.faculty,
    type: /^P/.test(s.code) || /\(Lab\)/i.test(s.name) ? "Lab" : "Theory",
    status: "Active"
  }));
}
