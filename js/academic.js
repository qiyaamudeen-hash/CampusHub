
export const DEGREES = ["BSc IT", "DIT", "BBA", "BCom"];

export const YEARS = [
  { value: 1, label: "First Year" },
  { value: 2, label: "Second Year" },
  { value: 3, label: "Third Year" },
];

export const SEMESTERS = [
  { value: 1, label: "First Semester" },
  { value: 2, label: "Second Semester" },
];

export const SUBJECT_TYPES = [
  { value: "general", label: "General subject" },
  { value: "specialized", label: "Specialized subject" },
];

// Class timetables only ever run Monday to Friday.
export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// A scheduled class's live status.
export const CLASS_STATUSES = [
  { value: "Happening", label: "Happening" },
  { value: "InProgress", label: "In Progress" },
  { value: "Postponed", label: "Postponed" },
  { value: "Cancelled", label: "Cancelled" },
];

// Info-item kinds. General (campus-wide) info can be a document, a picture,
// or a typed message; per-subject info is limited to documents or messages.
export const GENERAL_INFO_TYPES = [
  { value: "document", label: "Document" },
  { value: "picture", label: "Picture" },
  { value: "message", label: "Message" },
];
export const SUBJECT_INFO_TYPES = [
  { value: "document", label: "Document" },
  { value: "message", label: "Message" },
];

export const yearLabel = (y) => (YEARS.find((x) => x.value === Number(y)) || {}).label || "—";
export const semesterLabel = (s) => (SEMESTERS.find((x) => x.value === Number(s)) || {}).label || "—";
export const typeLabel = (t) => (t === "specialized" ? "Specialized" : "General");
export const classStatusLabel = (s) => (CLASS_STATUSES.find((x) => x.value === s) || {}).label || s || "Happening";
export const infoTypeLabel = (t) => (t === "document" ? "Document" : t === "picture" ? "Picture" : "Message");
