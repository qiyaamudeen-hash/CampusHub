import { guardPage, logOut, createUserAsAdmin } from "./auth.js";
import { db } from "./firebase-config.js";
import {
  DEGREES, YEARS, SEMESTERS, SUBJECT_TYPES,
  yearLabel, semesterLabel, typeLabel,
} from "./academic.js";
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  getDocs,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

let currentAdminUid = null;

guardPage({
  allowedRoles: ["admin"],
  onReady: (user) => {
    currentAdminUid = user.uid;
    document.getElementById("userName").textContent = user.email;
    document.getElementById("loadingScreen").style.display = "none";
    document.getElementById("appShell").style.display = "block";
    listenToUsers();
    listenToSubjects();
    listenToAdminCourses();
  },
});

document.getElementById("newPasswordToggle").addEventListener("change", (e) => {
  document.getElementById("newPassword").type = e.target.checked ? "text" : "password";
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await logOut();
  window.location.href = "index.html";
});

function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString();
}

function listenToUsers() {
  const q = query(collection(db, "users"), orderBy("name"));
  onSnapshot(q, (snap) => {
    const tbody = document.getElementById("usersTableBody");
    if (snap.empty) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No users yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = "";
    snap.forEach((docSnap) => {
      const u = docSnap.data();
      const uid = docSnap.id;
      const disabled = !!u.disabled;
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${escapeHtml(u.name || "—")}</td>
        <td>${escapeHtml(u.email || "—")}</td>
        <td><span class="badge role-${u.role || "student"}">${escapeHtml(u.role || "student")}</span></td>
        <td><span class="badge ${disabled ? "status-disabled" : "status-active"}">${disabled ? "Disabled" : "Active"}</span></td>
        <td>${fmtDate(u.lastLoginAt)}</td>
        <td>
          <button class="btn btn-secondary btn-small historyBtn" data-uid="${uid}" data-name="${escapeHtml(u.name || u.email)}">History</button>
        </td>
      `;
      tbody.appendChild(row);
    });
    attachRowHandlers();
  });
}

function attachRowHandlers() {
  document.querySelectorAll(".historyBtn").forEach((btn) => {
    btn.addEventListener("click", () => showHistory(btn.dataset.uid, btn.dataset.name));
  });
}

async function showHistory(uid, name) {
  document.getElementById("historyModalTitle").textContent = "Login history — " + name;
  const tbody = document.getElementById("historyTableBody");
  tbody.innerHTML = `<tr class="empty-row"><td colspan="2">Loading…</td></tr>`;
  document.getElementById("historyModal").classList.remove("hidden");

  const q = query(collection(db, "users", uid, "loginEvents"), orderBy("at", "desc"), limit(10));
  const snap = await getDocs(q);
  if (snap.empty) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="2">No login history yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  snap.forEach((d) => {
    const ev = d.data();
    const row = document.createElement("tr");
    row.innerHTML = `<td>${fmtDate(ev.at)}</td><td class="small-muted">${escapeHtml((ev.userAgent || "").slice(0, 60))}</td>`;
    tbody.appendChild(row);
  });
}

document.getElementById("closeHistory").addEventListener("click", () => {
  document.getElementById("historyModal").classList.add("hidden");
});

// ---- Add user modal ----
const addUserModal = document.getElementById("addUserModal");
document.getElementById("addUserBtn").addEventListener("click", () => {
  document.getElementById("addUserForm").reset();
  document.getElementById("addUserMsg").className = "form-msg";
  addUserModal.classList.remove("hidden");
});
document.getElementById("cancelAddUser").addEventListener("click", () => {
  addUserModal.classList.add("hidden");
});

document.getElementById("addUserForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("addUserMsg");
  const btn = document.getElementById("addUserSubmitBtn");
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    const name = document.getElementById("newName").value.trim();
    const email = document.getElementById("newEmail").value.trim();
    const password = document.getElementById("newPassword").value;
    const role = document.getElementById("newRole").value;
    await createUserAsAdmin(name, email, password, role);
    msg.textContent = "Account created.";
    msg.className = "form-msg success";
    setTimeout(() => addUserModal.classList.add("hidden"), 900);
  } catch (err) {
    console.error("Create user failed:", err.code, err.message);
    msg.textContent = err.message || "Something went wrong.";
    msg.className = "form-msg error";
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Account";
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ============================================================
// Tabs
// ============================================================
document.querySelectorAll(".section-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".section-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".section-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("section-" + tab.dataset.section).classList.add("active");
  });
});

// ============================================================
// Subjects & Courses  (Admin: create + view only)
// ============================================================
const $ = (id) => document.getElementById(id);
const asOptions = (items) =>
  items.map((i) => `<option value="${i.value}">${escapeHtml(i.label)}</option>`).join("");
const degreeItems = DEGREES.map((d) => ({ value: d, label: d }));

let subjectsCache = [];
let coursesCache = [];
const selectedSubjectIds = new Set();

// ---- static dropdowns ----
$("subjFilterDegree").innerHTML = `<option value="">All degrees</option>` + asOptions(degreeItems);
$("subjFilterYear").innerHTML = `<option value="">All years</option>` + asOptions(YEARS);
$("subjDegree").innerHTML = asOptions(degreeItems);
$("subjYear").innerHTML = asOptions(YEARS);
$("subjSemester").innerHTML = asOptions(SEMESTERS);
$("subjType").innerHTML = asOptions(SUBJECT_TYPES);
$("crsDegree").innerHTML = `<option value="">Select a degree…</option>` + asOptions(degreeItems);
$("crsYear").innerHTML = `<option value="">Select a year…</option>` + asOptions(YEARS);

function showMsg(el, text, type) {
  el.textContent = text;
  el.className = text ? "form-msg " + type : "form-msg";
}

// ------------------------- Subjects -------------------------
function listenToSubjects() {
  onSnapshot(query(collection(db, "subjects"), orderBy("name")), (snap) => {
    subjectsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSubjectsTable();
    renderSubjectPicker();
  });
}

function renderSubjectsTable() {
  const tbody = $("subjectsTableBody");
  const degree = $("subjFilterDegree").value;
  const year = $("subjFilterYear").value;
  const rows = subjectsCache
    .filter((s) => (!degree || s.degree === degree) && (!year || String(s.year) === year))
    .sort((a, b) =>
      a.degree.localeCompare(b.degree) || a.year - b.year || a.semester - b.semester || a.name.localeCompare(b.name)
    );
  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${
      subjectsCache.length ? "No subjects match these filters." : "No subjects yet — add your first one."
    }</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((s) => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.code || "—")}</td>
      <td>${escapeHtml(s.degree)}</td>
      <td>${yearLabel(s.year)}</td>
      <td>${semesterLabel(s.semester)}</td>
      <td><span class="badge type-${s.type}">${typeLabel(s.type)}</span></td>
    </tr>`).join("");
}
$("subjFilterDegree").addEventListener("change", renderSubjectsTable);
$("subjFilterYear").addEventListener("change", renderSubjectsTable);

$("addSubjectBtn").addEventListener("click", () => {
  $("subjectForm").reset();
  showMsg($("subjectMsg"), "", "");
  $("subjectModal").classList.remove("hidden");
});
$("cancelSubject").addEventListener("click", () => $("subjectModal").classList.add("hidden"));

$("subjectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("subjectMsg");
  const btn = $("subjectSubmitBtn");
  const name = $("subjName").value.trim();
  const degree = $("subjDegree").value;

  if (subjectsCache.some((s) => s.degree === degree && s.name.toLowerCase() === name.toLowerCase())) {
    showMsg(msg, `A subject called "${name}" already exists for ${degree}.`, "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    await addDoc(collection(db, "subjects"), {
      name,
      code: $("subjCode").value.trim(),
      degree,
      year: Number($("subjYear").value),
      semester: Number($("subjSemester").value),
      type: $("subjType").value,
      createdBy: currentAdminUid,
      createdAt: serverTimestamp(),
    });
    showMsg(msg, "Subject added.", "success");
    setTimeout(() => $("subjectModal").classList.add("hidden"), 700);
  } catch (err) {
    console.error("Add subject failed:", err.code, err.message);
    showMsg(msg, "Couldn't add subject: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Add Subject";
  }
});

// ------------------------- Courses -------------------------
function listenToAdminCourses() {
  onSnapshot(query(collection(db, "courses"), orderBy("name")), (snap) => {
    coursesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCoursesTable();
  });
}

function courseYearsText(c) {
  return (c.years || []).map(yearLabel).join(", ") || "—";
}

function renderCoursesTable() {
  const tbody = $("coursesTableBody");
  if (coursesCache.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No courses yet — create your first one.</td></tr>`;
    return;
  }
  tbody.innerHTML = coursesCache.map((c) => `
    <tr>
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.degree)}</td>
      <td><span class="badge type-${c.kind}">${typeLabel(c.kind)}</span></td>
      <td>${courseYearsText(c)}</td>
      <td class="small-muted">${(c.subjects || []).length} — ${escapeHtml((c.subjects || []).map((s) => s.name).join(", "))}</td>
    </tr>`).join("");
}

// ---- subject picker inside the Create Course modal ----
function renderSubjectPicker() {
  const kind = $("crsKind").value;
  const degree = $("crsDegree").value;
  const year = Number($("crsYear").value);
  const picker = $("crsSubjectPicker");

  $("crsYearField").style.display = kind === "general" ? "block" : "none";
  $("crsRuleHint").textContent =
    kind === "general"
      ? "General course: subjects come from the chosen degree and year only. At most one specialized subject per semester (two in total)."
      : "Specialized course: subjects come from any year of the chosen degree, with no limit on specialized subjects.";

  const note = (text) => `<p class="small-muted" style="padding:10px 0;">${text}</p>`;

  if (!degree || (kind === "general" && !year)) {
    picker.innerHTML = note(`Choose a degree${kind === "general" ? " and year" : ""} to see the available subjects.`);
    return;
  }

  const pool = subjectsCache.filter((s) => s.degree === degree && (kind === "specialized" || s.year === year));
  if (pool.length === 0) {
    picker.innerHTML = note("No subjects exist for this selection yet. Add them in the Subjects tab first.");
    return;
  }

  const groups = [];
  if (kind === "general") {
    SEMESTERS.forEach((sem) =>
      groups.push({ title: sem.label, items: pool.filter((s) => s.semester === sem.value) })
    );
  } else {
    YEARS.forEach((y) =>
      SEMESTERS.forEach((sem) =>
        groups.push({
          title: `${y.label} — ${sem.label}`,
          items: pool.filter((s) => s.year === y.value && s.semester === sem.value),
        })
      )
    );
  }

  picker.innerHTML = groups
    .filter((g) => g.items.length)
    .map((g) => `
      <div class="pick-group-title">${escapeHtml(g.title)}</div>
      ${g.items.map((s) => `
        <label class="pick-row">
          <input type="checkbox" data-id="${s.id}" ${selectedSubjectIds.has(s.id) ? "checked" : ""} />
          <span style="flex:1;">${escapeHtml(s.name)}${s.code ? ` <span class="small-muted">(${escapeHtml(s.code)})</span>` : ""}</span>
          <span class="badge type-${s.type}">${typeLabel(s.type)}</span>
        </label>`).join("")}
    `).join("");
}

["crsKind", "crsDegree", "crsYear"].forEach((id) =>
  $(id).addEventListener("change", () => {
    selectedSubjectIds.clear();
    showMsg($("courseMsg"), "", "");
    renderSubjectPicker();
  })
);

// One delegated listener handles every checkbox in the picker.
$("crsSubjectPicker").addEventListener("change", (e) => {
  const cb = e.target.closest('input[type="checkbox"][data-id]');
  if (!cb) return;
  const subject = subjectsCache.find((s) => s.id === cb.dataset.id);
  if (!subject) return;

  if (cb.checked) {
    // General courses: only one specialized subject per semester.
    if ($("crsKind").value === "general" && subject.type === "specialized") {
      const clash = [...selectedSubjectIds]
        .map((id) => subjectsCache.find((s) => s.id === id))
        .find((s) => s && s.type === "specialized" && s.semester === subject.semester);
      if (clash) {
        cb.checked = false;
        showMsg(
          $("courseMsg"),
          `A general course can only have one specialized subject per semester — ${semesterLabel(subject.semester)} already has "${clash.name}".`,
          "error"
        );
        return;
      }
    }
    selectedSubjectIds.add(subject.id);
  } else {
    selectedSubjectIds.delete(subject.id);
  }
  showMsg($("courseMsg"), "", "");
});

$("addCourseBtn").addEventListener("click", () => {
  $("courseForm").reset();
  selectedSubjectIds.clear();
  showMsg($("courseMsg"), "", "");
  renderSubjectPicker();
  $("courseModal").classList.remove("hidden");
});
$("cancelCourse").addEventListener("click", () => $("courseModal").classList.add("hidden"));

$("courseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("courseMsg");
  const btn = $("courseSubmitBtn");

  const name = $("crsName").value.trim();
  const kind = $("crsKind").value;
  const degree = $("crsDegree").value;
  const year = Number($("crsYear").value);
  const chosen = [...selectedSubjectIds].map((id) => subjectsCache.find((s) => s.id === id)).filter(Boolean);

  // ---- validation ----
  if (!name) return showMsg(msg, "Give the course a name.", "error");
  if (!degree) return showMsg(msg, "Choose a degree.", "error");
  if (kind === "general" && !year) return showMsg(msg, "Choose a year for a general course.", "error");
  if (chosen.length === 0) return showMsg(msg, "Select at least one subject.", "error");
  if (coursesCache.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return showMsg(msg, `A course called "${name}" already exists.`, "error");
  }
  if (kind === "general") {
    for (const sem of [1, 2]) {
      const n = chosen.filter((s) => s.type === "specialized" && s.semester === sem).length;
      if (n > 1) {
        return showMsg(msg, `Only one specialized subject is allowed in ${semesterLabel(sem)} of a general course.`, "error");
      }
    }
  }

  const years = kind === "general" ? [year] : [...new Set(chosen.map((s) => s.year))].sort();

  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    await addDoc(collection(db, "courses"), {
      name,
      kind,
      degree,
      year: kind === "general" ? year : null,
      years,
      subjectIds: chosen.map((s) => s.id),
      // Denormalised copy so Lecturer/Student pages need no extra reads.
      // Safe because subjects can't be edited or deleted after creation.
      subjects: chosen.map((s) => ({
        id: s.id, name: s.name, code: s.code || "", year: s.year, semester: s.semester, type: s.type,
      })),
      createdBy: currentAdminUid,
      createdAt: serverTimestamp(),
    });
    showMsg(msg, "Course created.", "success");
    setTimeout(() => $("courseModal").classList.add("hidden"), 700);
  } catch (err) {
    console.error("Create course failed:", err.code, err.message);
    showMsg(msg, "Couldn't create course: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Course";
  }
});
