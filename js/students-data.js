// students-data.js
// Default/seed student database. This only seeds the app the FIRST time it
// ever runs on a device — after that, all add/edit/delete/restore actions
// are read from localStorage (see app.js -> DB.students).
//
// Add your own class roster here, or leave this empty and add students from
// the Admin Dashboard after deployment (Students -> Add Student). Each entry
// needs: rollNo, name, regNo, boardRoll (adjust the fields to match your
// institution's numbering if different).
//
// Example:
// { rollNo: "01/EE/24", name: "Jane Doe", regNo: "1000000001", boardRoll: "5100000001" },

const SEED_STUDENTS = [
].map((s, i) => ({ id: "s" + (i + 1), sNo: i + 1, ...s, deleted: false }));
