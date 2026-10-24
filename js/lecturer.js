import { guardPage, logOut } from "./auth.js";
import { db } from "./firebase-config.js";
import {
  DEGREES, YEARS, SEMESTERS, yearLabel, semesterLabel, typeLabel,
  DAYS, CLASS_STATUSES, infoTypeLabel,
} from "./academic.js";
import {
  toISODate, addDays, weekdayName, monthName,
  startOfWeek, currentSemesterNumber, effectiveStatus,
} from "./calendarUtils.js";
import { uploadFile, fileUrl, fileBodyHtml, DOC_ACCEPT, IMAGE_ACCEPT } from "./localFiles.js";
import {
  collection, query, where, orderBy, onSnapshot, getDocs, getDoc,
  doc, addDoc, updateDoc, deleteDoc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

let currentUser = null;
let coursesCache = [];        // named courses created by Admin (with denormalized subjects[])
let lecturersCache = [];      // { id, name, email } for every lecturer account
let semestersCache = {};      // {1: {startDate,endDate}, 2: {...}}
let currentTtCourseId = null;
let courseScheduleUnsub = null;
let ttEntriesCache = [];      // scheduleEntries for the currently selected Course Timetable
let ttOverrides = [];         // scheduleOverrides for that course
let ttDayOffs = [];           // courseDaysOff for that course
let ttOverridesUnsub = null;
let ttDayOffsUnsub = null;
let ttWeekAnchor = new Date();
const courseInfoSubjectUnsubs = new Map(); // subjectId -> unsub fn (items listener)

const $ = (id) => document.getElementById(id);

guardPage({
  allowedRoles: ["lecturer"],
  onReady: (user) => {
    currentUser = user;
    $("userName").textContent = user.email;
    $("loadingScreen").style.display = "none";
    $("appShell").style.display = "block";
    listenToCourses();
    listenToLecturers();
    listenToLostFound();
    listenToClaims();
    listenToGeneralInfo();
    listenToMyTimetable();
    listenToSemesters();
    switchTtCourse("");
  },
});

$("logoutBtn").addEventListener("click", async () => {
  await logOut();
  window.location.href = "index.html";
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}
function fmtDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString();
}
function showMsg(el, text, type) {
  el.textContent = text;
  el.className = text ? "form-msg " + type : "form-msg";
}

// ---------------- Section tabs ----------------
document.querySelectorAll(".section-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".section-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".section-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("section-" + tab.dataset.section).classList.add("active");
  });
});

// ---------------- Sub-tabs (scoped to whichever section they're inside) ----------------
document.querySelectorAll(".subtab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const scope = tab.closest(".section-panel");
    scope.querySelectorAll(".subtab").forEach((t) => t.classList.remove("active"));
    scope.querySelectorAll(".subpanel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    scope.querySelector("#subtab-" + tab.dataset.subtab).classList.add("active");
  });
});

// ---------------- Static dropdowns ----------------
const degreeOptions =
  `<option value="">All degrees</option>` + DEGREES.map((d) => `<option value="${d}">${d}</option>`).join("");
const yearOptions =
  `<option value="">All years</option>` + YEARS.map((y) => `<option value="${y.value}">${y.label}</option>`).join("");
$("enrollDegree").innerHTML = degreeOptions;
$("enrollYear").innerHTML = yearOptions;

const dayOptions = DAYS.map((d) => `<option>${d}</option>`).join("");
const statusOptions = CLASS_STATUSES.map((s) => `<option value="${s.value}">${s.label}</option>`).join("");
const semesterFormOptions = SEMESTERS.map((s) => `<option value="${s.value}">${s.label}</option>`).join("");
$("mySchedDay").innerHTML = dayOptions;
$("ttSchedDay").innerHTML = dayOptions;
$("mySchedStatus").innerHTML = statusOptions;
$("ttSchedStatus").innerHTML = statusOptions;
$("mySchedSemester").innerHTML = semesterFormOptions;
$("ttSchedSemester").innerHTML = semesterFormOptions;

// A course matches a year filter if that year is one of the years it covers
// (a general course covers one year; a specialized course covers several).
function matchesFilter(course, degree, year) {
  return (!degree || course.degree === degree) && (!year || (course.years || []).includes(Number(year)));
}

// ============================================================
// Courses (created by Admin) — drives every other section
// ============================================================
function listenToCourses() {
  onSnapshot(query(collection(db, "courses"), orderBy("name")), (snap) => {
    coursesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    refreshEnrollCourseOptions();
    populateInfoCourseSelect();
    populateMySchedCourseOptions();
    populateTtCourseSelect();
  });
}

// ============================================================
// Information — General Info
// ============================================================
function infoCardHtml(item, removable, extraAttrs = "") {
  const body =
    item.type === "message"
      ? `<p>${escapeHtml(item.content).replace(/\n/g, "<br>")}</p>`
      : item.fileName
        ? fileBodyHtml(item)
        : `<p><a href="${escapeHtml(item.content)}" target="_blank" rel="noopener">${escapeHtml(item.content)}</a></p>`;
  return `
    <div class="info-card">
      <span class="info-type">${infoTypeLabel(item.type)}</span>
      <h4>${escapeHtml(item.title || "Untitled")}</h4>
      ${body}
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
        <span class="small-muted">${fmtDate(item.createdAt)}</span>
        ${removable ? `<button class="btn btn-danger btn-small removeInfoBtn" data-id="${item.id}" ${extraAttrs}>Remove</button>` : ""}
      </div>
    </div>`;
}

let generalInfoCache = [];
function listenToGeneralInfo() {
  const q = query(collection(db, "generalInfoItems"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    generalInfoCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const list = $("generalInfoList");
    if (generalInfoCache.length === 0) {
      list.innerHTML = `<div class="placeholder-card"><p>No general info posted yet.</p></div>`;
      return;
    }
    list.innerHTML = generalInfoCache.map((i) => infoCardHtml(i, true)).join("");
    list.querySelectorAll(".removeInfoBtn").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Remove this info item?")) return;
        await deleteDoc(doc(db, "generalInfoItems", b.dataset.id));
      })
    );
  });
}

function toggleGiFields() {
  const isMsg = $("giType").value === "message";
  $("giMessageField").style.display = isMsg ? "block" : "none";
  $("giLinkField").style.display = isMsg ? "none" : "block";
}
$("giType").addEventListener("change", toggleGiFields);

$("addGeneralInfoBtn").addEventListener("click", () => {
  $("generalInfoForm").reset();
  toggleGiFields();
  showMsg($("generalInfoMsg"), "", "");
  $("generalInfoModal").classList.remove("hidden");
});
$("cancelGeneralInfo").addEventListener("click", () => $("generalInfoModal").classList.add("hidden"));

$("generalInfoForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("generalInfoMsg");
  const type = $("giType").value;
  const title = $("giTitle").value.trim();
  const content = type === "message" ? $("giMessage").value.trim() : $("giLink").value.trim();
  if (!title || !content) {
    showMsg(msg, `Fill in a title and ${type === "message" ? "a message" : "a link"}.`, "error");
    return;
  }
  try {
    await addDoc(collection(db, "generalInfoItems"), {
      type, title, content,
      createdBy: currentUser.uid,
      createdAt: serverTimestamp(),
    });
    showMsg(msg, "Info posted.", "success");
    setTimeout(() => $("generalInfoModal").classList.add("hidden"), 600);
  } catch (err) {
    showMsg(msg, "Couldn't post info: " + err.message, "error");
  }
});

// ============================================================
// Information — Course Info (per-subject WhatsApp link + info items)
// ============================================================
function populateInfoCourseSelect() {
  const sel = $("infoCourseSelect");
  const prev = sel.value;
  sel.innerHTML =
    `<option value="">Select a course…</option>` +
    coursesCache.map((c) => `<option value="${c.id}">${escapeHtml(c.name)} — ${escapeHtml(c.degree)}</option>`).join("");
  if (coursesCache.some((c) => c.id === prev)) sel.value = prev;
  renderCourseInfo(sel.value);
}
$("infoCourseSelect").addEventListener("change", (e) => renderCourseInfo(e.target.value));

function clearCourseInfoSubs() {
  courseInfoSubjectUnsubs.forEach((unsub) => unsub());
  courseInfoSubjectUnsubs.clear();
}

function renderCourseInfo(courseId) {
  clearCourseInfoSubs();
  const list = $("courseInfoList");
  const course = coursesCache.find((c) => c.id === courseId);
  if (!course) {
    list.innerHTML = `<div class="placeholder-card"><p>Choose a course above to manage its subjects' info.</p></div>`;
    return;
  }
  const subjects = [...(course.subjects || [])].sort(
    (a, b) => a.year - b.year || a.semester - b.semester || a.name.localeCompare(b.name)
  );
  if (subjects.length === 0) {
    list.innerHTML = `<div class="placeholder-card"><p>This course has no subjects.</p></div>`;
    return;
  }
  list.innerHTML = subjects.map((s) => `
    <div class="subject-info-block">
      <div class="subject-info-head">
        <h3>${escapeHtml(s.name)} <span class="small-muted">— ${yearLabel(s.year)}, ${semesterLabel(s.semester)}</span></h3>
      </div>
      <div class="field" style="margin-bottom:10px;">
        <label>WhatsApp group link</label>
        <div style="display:flex; gap:8px;">
          <input type="url" class="subjWhatsappInput" data-subject-id="${s.id}" placeholder="https://chat.whatsapp.com/…"
                 style="flex:1; padding:10px 12px; border:2px solid var(--bg); border-radius:6px; font-size:14px;" />
          <button class="btn btn-secondary btn-small saveWhatsappBtn" data-subject-id="${s.id}" style="width:auto;">Save</button>
        </div>
        <span class="form-msg" id="whatsappMsg-${s.id}"></span>
      </div>
      <div class="subject-info-items" id="subjectItems-${s.id}"><p class="small-muted">Loading…</p></div>
      <button class="btn btn-secondary btn-small addSubjectInfoBtn" data-subject-id="${s.id}" data-subject-name="${escapeHtml(s.name)}">+ Add Info</button>
    </div>`).join("");

  subjects.forEach((s) => {
    getDoc(doc(db, "subjectInfo", s.id)).then((snap) => {
      const input = list.querySelector(`.subjWhatsappInput[data-subject-id="${s.id}"]`);
      if (input && snap.exists()) input.value = snap.data().whatsappLink || "";
    });
    const itemsQ = query(collection(db, "subjectInfo", s.id, "items"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(itemsQ, (snap) => {
      const holder = document.getElementById(`subjectItems-${s.id}`);
      if (!holder) return; // course was switched away before this fired
      if (snap.empty) {
        holder.innerHTML = `<p class="small-muted">No info added for this subject yet.</p>`;
        return;
      }
      holder.innerHTML = snap.docs.map((d) => infoCardHtml({ id: d.id, ...d.data() }, true, `data-subject-id="${s.id}"`)).join("");
      holder.querySelectorAll(".removeInfoBtn").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm("Remove this info item?")) return;
          await deleteDoc(doc(db, "subjectInfo", b.dataset.subjectId, "items", b.dataset.id));
        })
      );
    });
    courseInfoSubjectUnsubs.set(s.id, unsub);
  });
}

$("courseInfoList").addEventListener("click", async (e) => {
  const saveBtn = e.target.closest(".saveWhatsappBtn");
  if (saveBtn) {
    const subjectId = saveBtn.dataset.subjectId;
    const input = $("courseInfoList").querySelector(`.subjWhatsappInput[data-subject-id="${subjectId}"]`);
    const msgEl = document.getElementById(`whatsappMsg-${subjectId}`);
    const course = coursesCache.find((c) => c.id === $("infoCourseSelect").value);
    const subject = (course && course.subjects || []).find((s) => s.id === subjectId);
    try {
      await setDoc(doc(db, "subjectInfo", subjectId), {
        subjectId,
        subjectName: subject ? subject.name : "",
        whatsappLink: input.value.trim(),
        updatedBy: currentUser.uid,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      if (msgEl) {
        msgEl.textContent = "Saved.";
        msgEl.className = "form-msg success";
        setTimeout(() => { msgEl.className = "form-msg"; }, 1500);
      }
    } catch (err) {
      if (msgEl) { msgEl.textContent = "Couldn't save: " + err.message; msgEl.className = "form-msg error"; }
    }
    return;
  }
  const addBtn = e.target.closest(".addSubjectInfoBtn");
  if (addBtn) openSubjectInfoModal(addBtn.dataset.subjectId, addBtn.dataset.subjectName);
});

let siTargetSubjectId = null;
function toggleSiFields() {
  const type = $("siType").value;
  $("siMessageField").style.display = type === "message" ? "block" : "none";
  $("siFileField").style.display = type === "message" ? "none" : "block";
  $("siFile").accept = type === "picture" ? IMAGE_ACCEPT : DOC_ACCEPT;
}
$("siType").addEventListener("change", toggleSiFields);

function openSubjectInfoModal(subjectId, subjectName) {
  siTargetSubjectId = subjectId;
  $("subjectInfoModalTitle").textContent = "Add Info — " + subjectName;
  $("subjectInfoForm").reset();
  toggleSiFields();
  showMsg($("subjectInfoMsg"), "", "");
  $("subjectInfoModal").classList.remove("hidden");
}
$("cancelSubjectInfo").addEventListener("click", () => $("subjectInfoModal").classList.add("hidden"));

$("subjectInfoForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("subjectInfoMsg");
  const type = $("siType").value;
  const title = $("siTitle").value.trim();
  const message = $("siMessage").value.trim();
  const file = $("siFile").files[0];
  if (!title || (type === "message" ? !message : !file)) {
    showMsg(msg, `Fill in a title and ${type === "message" ? "a message" : "choose a file"}.`, "error");
    return;
  }
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const data = { type, title, createdBy: currentUser.uid, createdAt: serverTimestamp() };
    if (type === "message") {
      data.content = message;
    } else {
      showMsg(msg, "Uploading…", "success");
      Object.assign(data, await uploadFile(file)); // adds fileName, fileOriginalName, fileSize
    }
    await addDoc(collection(db, "subjectInfo", siTargetSubjectId, "items"), data);
    showMsg(msg, "Info added.", "success");
    setTimeout(() => $("subjectInfoModal").classList.add("hidden"), 600);
  } catch (err) {
    showMsg(msg, "Couldn't add info: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ============================================================
// Enrollment (unchanged)
// ============================================================
let enrollUnsub = null;
let enrollCourseId = null;

function refreshEnrollCourseOptions() {
  const sel = $("enrollCourseSelect");
  const prev = sel.value;
  const list = coursesCache.filter((c) => matchesFilter(c, $("enrollDegree").value, $("enrollYear").value));

  if (list.length === 0) {
    sel.innerHTML = `<option value="">${coursesCache.length ? "No courses match these filters" : "No courses yet"}</option>`;
  } else {
    sel.innerHTML = list
      .map((c) => `<option value="${c.id}">${escapeHtml(c.name)} — ${escapeHtml(c.degree)} · ${typeLabel(c.kind)}</option>`)
      .join("");
    if (list.some((c) => c.id === prev)) sel.value = prev;
  }
  showEnrollmentsFor(sel.value);
}
$("enrollDegree").addEventListener("change", refreshEnrollCourseOptions);
$("enrollYear").addEventListener("change", refreshEnrollCourseOptions);
$("enrollCourseSelect").addEventListener("change", (e) => showEnrollmentsFor(e.target.value));

function showEnrollmentsFor(courseId) {
  if (courseId === enrollCourseId) return;
  enrollCourseId = courseId;
  if (enrollUnsub) { enrollUnsub(); enrollUnsub = null; }

  const tbody = $("enrollTableBody");
  if (!courseId) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">Select a course above.</td></tr>`;
    return;
  }
  const q = query(collection(db, "enrollments"), where("courseId", "==", courseId));
  enrollUnsub = onSnapshot(q, (snap) => {
    if (snap.empty) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No students enrolled in this course yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = snap.docs.map((d) => {
      const en = d.data();
      return `
        <tr>
          <td>${escapeHtml(en.studentName)} <span class="small-muted">(${escapeHtml(en.studentEmail)})</span></td>
          <td>${escapeHtml(en.courseName)}</td>
          <td>${fmtDate(en.enrolledAt)}</td>
          <td><button class="btn btn-danger btn-small unenrollBtn" data-id="${d.id}">Remove</button></td>
        </tr>`;
    }).join("");
    document.querySelectorAll(".unenrollBtn").forEach((b) =>
      b.addEventListener("click", async () => {
        await deleteDoc(doc(db, "enrollments", b.dataset.id));
      })
    );
  });
}

$("enrollBtn").addEventListener("click", async () => {
  const msg = $("enrollMsg");
  msg.className = "form-msg";
  const courseId = $("enrollCourseSelect").value;
  const email = $("enrollEmailInput").value.trim();
  const course = coursesCache.find((c) => c.id === courseId);

  if (!course) {
    msg.textContent = "Choose a course first.";
    msg.className = "form-msg error";
    return;
  }
  if (!email) {
    msg.textContent = "Enter the student's email.";
    msg.className = "form-msg error";
    return;
  }
  try {
    const usersSnap = await getDocs(query(collection(db, "users"), where("email", "==", email)));
    const studentDoc = usersSnap.docs.find((d) => d.data().role === "student");
    if (!studentDoc) {
      msg.textContent = "No student account found with that email.";
      msg.className = "form-msg error";
      return;
    }
    const dup = await getDocs(
      query(collection(db, "enrollments"), where("courseId", "==", courseId), where("studentUserId", "==", studentDoc.id))
    );
    if (!dup.empty) {
      msg.textContent = `${studentDoc.data().name} is already enrolled in ${course.name}.`;
      msg.className = "form-msg error";
      return;
    }
    await addDoc(collection(db, "enrollments"), {
      courseId,
      courseName: course.name,
      studentUserId: studentDoc.id,
      studentName: studentDoc.data().name,
      studentEmail: studentDoc.data().email,
      enrolledAt: serverTimestamp(),
    });
    msg.textContent = `${studentDoc.data().name} enrolled in ${course.name}.`;
    msg.className = "form-msg success";
    $("enrollEmailInput").value = "";
  } catch (err) {
    msg.textContent = "Couldn't enroll student: " + err.message;
    msg.className = "form-msg error";
  }
});

// ============================================================
// Lost & Found (unchanged)
// ============================================================
function listenToLostFound() {
  const q = query(collection(db, "lostFoundItems"), orderBy("dateReported", "desc"));
  onSnapshot(q, (snap) => {
    const tbody = $("lostFoundTableBody");
    if (snap.empty) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No items reported yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = "";
    snap.forEach((d) => {
      const i = d.data();
      const status = i.status || "Lost";
      const row = document.createElement("tr");
      const photo = i.fileName
        ? `<a href="${fileUrl(i.fileName, i.fileOriginalName)}" target="_blank" rel="noopener"><img src="${fileUrl(i.fileName, i.fileOriginalName)}" alt="" loading="lazy" style="width:56px; height:56px; object-fit:cover; border-radius:6px; display:block; margin-bottom:6px;" /></a>`
        : "";
      row.innerHTML = `
        <td>${photo}${escapeHtml(i.itemName)}</td>
        <td>${escapeHtml(i.description || "—")}</td>
        <td><span class="badge status-${status.toLowerCase()}">${escapeHtml(status)}</span></td>
        <td>
          ${status !== "Found" ? `<button class="btn btn-secondary btn-small markBtn" data-id="${d.id}" data-status="Found">Mark Found</button>` : ""}
          ${status !== "Claimed" ? `<button class="btn btn-secondary btn-small markBtn" data-id="${d.id}" data-status="Claimed">Mark Claimed</button>` : ""}
        </td>`;
      tbody.appendChild(row);
    });
    document.querySelectorAll(".markBtn").forEach((b) =>
      b.addEventListener("click", async () => {
        await updateDoc(doc(db, "lostFoundItems", b.dataset.id), { status: b.dataset.status });
      })
    );
  });
}

function listenToClaims() {
  const q = query(collection(db, "itemClaims"), where("status", "==", "Pending"));
  onSnapshot(q, (snap) => {
    const tbody = $("claimsTableBody");
    if (snap.empty) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No pending claims.</td></tr>`;
      return;
    }
    tbody.innerHTML = "";
    snap.forEach((d) => {
      const cl = d.data();
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${escapeHtml(cl.itemId)}</td>
        <td>${escapeHtml(cl.claimantUserId)}</td>
        <td>${fmtDate(cl.claimDate)}</td>
        <td>
          <button class="btn btn-secondary btn-small approveBtn" data-id="${d.id}" data-item="${cl.itemId}">Approve</button>
          <button class="btn btn-danger btn-small rejectBtn" data-id="${d.id}">Reject</button>
        </td>`;
      tbody.appendChild(row);
    });
    document.querySelectorAll(".approveBtn").forEach((b) =>
      b.addEventListener("click", async () => {
        await updateDoc(doc(db, "itemClaims", b.dataset.id), { status: "Approved" });
        await updateDoc(doc(db, "lostFoundItems", b.dataset.item), { status: "Claimed" });
      })
    );
    document.querySelectorAll(".rejectBtn").forEach((b) =>
      b.addEventListener("click", async () => {
        await updateDoc(doc(db, "itemClaims", b.dataset.id), { status: "Rejected" });
      })
    );
  });
}

// ============================================================
// Semester Dates
// ============================================================
function listenToSemesters() {
  onSnapshot(collection(db, "semesters"), (snap) => {
    semestersCache = {};
    snap.forEach((d) => { semestersCache[Number(d.id)] = { id: d.id, ...d.data() }; });
    renderSemesterBars();
    renderTtWeek();
  });
}

function renderSemesterBars() {
  const holder = $("semesterBars");
  holder.innerHTML = [1, 2].map((num) => {
    const s = semestersCache[num] || {};
    return `
      <div class="semester-bar">
        <div class="sem-name">Semester ${num}</div>
        <div class="sem-dates" id="semView-${num}">
          <span><span class="small-muted">Start</span><br>${s.startDate ? escapeHtml(s.startDate) : "Not set"}</span>
          <span><span class="small-muted">End</span><br>${s.endDate ? escapeHtml(s.endDate) : "Not set"}</span>
        </div>
        <div class="sem-dates hidden" id="semEdit-${num}">
          <div class="field"><label>Start date</label><input type="date" id="semStart-${num}" value="${s.startDate || ""}" /></div>
          <div class="field"><label>End date</label><input type="date" id="semEnd-${num}" value="${s.endDate || ""}" /></div>
        </div>
        <button type="button" class="btn btn-secondary btn-small semEditBtn" data-sem="${num}" style="width:auto;">Edit</button>
        <button type="button" class="btn btn-primary btn-small hidden semSaveBtn" data-sem="${num}" style="width:auto;">Save</button>
        <span class="form-msg" id="semMsg-${num}"></span>
      </div>`;
  }).join("");

  holder.querySelectorAll(".semEditBtn").forEach((b) =>
    b.addEventListener("click", () => {
      $("semView-" + b.dataset.sem).classList.add("hidden");
      $("semEdit-" + b.dataset.sem).classList.remove("hidden");
      b.classList.add("hidden");
      holder.querySelector(`.semSaveBtn[data-sem="${b.dataset.sem}"]`).classList.remove("hidden");
    })
  );
  holder.querySelectorAll(".semSaveBtn").forEach((b) =>
    b.addEventListener("click", async () => {
      const num = b.dataset.sem;
      const start = $("semStart-" + num).value;
      const end = $("semEnd-" + num).value;
      const msgEl = $("semMsg-" + num);
      if (!start || !end) { showMsg(msgEl, "Set both dates.", "error"); return; }
      if (start > end) { showMsg(msgEl, "Start date must be before end date.", "error"); return; }
      try {
        await setDoc(doc(db, "semesters", num), {
          semester: Number(num),
          startDate: start,
          endDate: end,
          updatedBy: currentUser.uid,
          updatedAt: serverTimestamp(),
        }, { merge: true });
        showMsg(msgEl, "Saved.", "success");
      } catch (err) {
        showMsg(msgEl, "Couldn't save: " + err.message, "error");
      }
    })
  );
}

// ============================================================
// Timetable — My Timetable
// ============================================================
function populateMySchedCourseOptions() {
  const sel = $("mySchedCourse");
  const prev = sel.value;
  sel.innerHTML = coursesCache.length
    ? coursesCache.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")
    : `<option value="">No courses yet</option>`;
  if (coursesCache.some((c) => c.id === prev)) sel.value = prev;
  populateMySchedSubjectOptions();
}
$("mySchedCourse").addEventListener("change", populateMySchedSubjectOptions);
$("mySchedSemester").addEventListener("change", populateMySchedSubjectOptions);

function populateMySchedSubjectOptions() {
  const course = coursesCache.find((c) => c.id === $("mySchedCourse").value);
  const sem = Number($("mySchedSemester").value);
  const subjects = course
    ? [...(course.subjects || [])].filter((s) => s.semester === sem).sort((a, b) => a.year - b.year || a.name.localeCompare(b.name))
    : [];
  $("mySchedSubject").innerHTML = subjects.length
    ? subjects.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} — ${yearLabel(s.year)}</option>`).join("")
    : `<option value="">No ${semesterLabel(sem)} subjects in this course</option>`;
}

function listenToMyTimetable() {
  const q = query(collection(db, "scheduleEntries"), where("lecturerId", "==", currentUser.uid));
  onSnapshot(q, (snap) => {
    const tbody = $("myTimetableBody");
    if (snap.empty) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No classes on your timetable yet — add one below.</td></tr>`;
      return;
    }
    const entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    entries.sort((a, b) => DAYS.indexOf(a.dayOfWeek) - DAYS.indexOf(b.dayOfWeek) || (a.startTime || "").localeCompare(b.startTime || ""));
    tbody.innerHTML = entries.map((s) => `
      <tr>
        <td>${escapeHtml(s.dayOfWeek)}</td>
        <td>${escapeHtml(s.startTime)}–${escapeHtml(s.endTime)}</td>
        <td>${s.semester ? "Sem " + s.semester : "—"}</td>
        <td>${escapeHtml(s.courseName || "—")}</td>
        <td>${escapeHtml(s.subjectName || "—")}</td>
        <td>${escapeHtml(s.venue || "—")}</td>
        <td>
          <select class="statusSelect" data-id="${s.id}">
            ${CLASS_STATUSES.map((c) => `<option value="${c.value}" ${s.status === c.value ? "selected" : ""}>${c.label}</option>`).join("")}
          </select>
        </td>
        <td>
          <button class="btn btn-secondary btn-small editMySchedBtn" data-id="${s.id}">Edit</button>
          <button class="btn btn-danger btn-small delMySchedBtn" data-id="${s.id}">Remove</button>
        </td>
      </tr>`).join("");

    tbody.querySelectorAll(".statusSelect").forEach((sel) =>
      sel.addEventListener("change", async () => {
        await updateDoc(doc(db, "scheduleEntries", sel.dataset.id), { status: sel.value });
      })
    );
    tbody.querySelectorAll(".delMySchedBtn").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Remove this class from your timetable?")) return;
        await deleteDoc(doc(db, "scheduleEntries", b.dataset.id));
      })
    );
    tbody.querySelectorAll(".editMySchedBtn").forEach((b) =>
      b.addEventListener("click", () => {
        const entry = entries.find((x) => x.id === b.dataset.id);
        if (entry) startEditMySched(entry);
      })
    );
  });
}

function startEditMySched(entry) {
  $("mySchedEntryId").value = entry.id;
  $("mySchedCourse").value = entry.courseId;
  $("mySchedSemester").value = entry.semester || 1;
  populateMySchedSubjectOptions();
  $("mySchedSubject").value = entry.subjectId;
  $("mySchedDay").value = entry.dayOfWeek;
  $("mySchedStart").value = entry.startTime || "";
  $("mySchedEnd").value = entry.endTime || "";
  $("mySchedVenue").value = entry.venue || "";
  $("mySchedStatus").value = entry.status || "Happening";
  $("mySchedSubmitBtn").textContent = "Save Changes";
  $("cancelMySchedEdit").classList.remove("hidden");
  showMsg($("mySchedMsg"), "", "");
}
function resetMySchedForm() {
  $("myScheduleForm").reset();
  $("mySchedEntryId").value = "";
  populateMySchedSubjectOptions();
  $("mySchedSubmitBtn").textContent = "+ Add to My Timetable";
  $("cancelMySchedEdit").classList.add("hidden");
}
$("cancelMySchedEdit").addEventListener("click", resetMySchedForm);

$("myScheduleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("mySchedMsg");
  const course = coursesCache.find((c) => c.id === $("mySchedCourse").value);
  const subject = course && (course.subjects || []).find((s) => s.id === $("mySchedSubject").value);
  if (!course || !subject) {
    showMsg(msg, "Choose a course and subject.", "error");
    return;
  }
  const payload = {
    courseId: course.id,
    courseName: course.name,
    semester: Number($("mySchedSemester").value),
    subjectId: subject.id,
    subjectName: subject.name,
    lecturerId: currentUser.uid,
    lecturerName: currentUser.email,
    dayOfWeek: $("mySchedDay").value,
    startTime: $("mySchedStart").value,
    endTime: $("mySchedEnd").value,
    venue: $("mySchedVenue").value.trim(),
    status: $("mySchedStatus").value,
  };
  const entryId = $("mySchedEntryId").value;
  try {
    if (entryId) {
      await updateDoc(doc(db, "scheduleEntries", entryId), payload);
      showMsg(msg, "Class updated.", "success");
    } else {
      await addDoc(collection(db, "scheduleEntries"), { ...payload, createdAt: serverTimestamp() });
      showMsg(msg, "Class added to your timetable.", "success");
    }
    resetMySchedForm();
  } catch (err) {
    showMsg(msg, "Couldn't save: " + err.message, "error");
  }
});

// ============================================================
// Timetable — Course Timetable
// ============================================================
function listenToLecturers() {
  const q = query(collection(db, "users"), where("role", "==", "lecturer"));
  onSnapshot(q, (snap) => {
    lecturersCache = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((l) => !l.disabled)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    populateTtLecturerOptions();
  });
}

function populateTtLecturerOptions() {
  const sel = $("ttSchedLecturer");
  const prev = sel.value;
  sel.innerHTML = lecturersCache.length
    ? lecturersCache
        .map((l) => `<option value="${l.id}">${escapeHtml(l.name || l.email)}${currentUser && l.id === currentUser.uid ? " (you)" : ""}</option>`)
        .join("")
    : `<option value="">No lecturers found</option>`;
  if (lecturersCache.some((l) => l.id === prev)) sel.value = prev;
}

function populateTtCourseSelect() {
  const sel = $("ttCourseSelect");
  const prev = sel.value;
  sel.innerHTML =
    `<option value="">Select a course…</option>` +
    coursesCache.map((c) => `<option value="${c.id}">${escapeHtml(c.name)} — ${escapeHtml(c.degree)}</option>`).join("");
  if (coursesCache.some((c) => c.id === prev)) {
    sel.value = prev;
  } else if (sel.value !== prev) {
    sel.value = "";
  }
  if (sel.value === currentTtCourseId) {
    populateTtSubjectOptions(); // course list refreshed but selection unchanged — keep subjects in sync
  } else {
    switchTtCourse(sel.value);
  }
}
$("ttCourseSelect").addEventListener("change", (e) => switchTtCourse(e.target.value));
$("ttSchedSemester").addEventListener("change", populateTtSubjectOptions);

function populateTtSubjectOptions() {
  const course = coursesCache.find((c) => c.id === currentTtCourseId);
  const sem = Number($("ttSchedSemester").value);
  const subjects = course
    ? [...(course.subjects || [])].filter((s) => s.semester === sem).sort((a, b) => a.year - b.year || a.name.localeCompare(b.name))
    : [];
  $("ttSchedSubject").innerHTML = subjects.length
    ? subjects.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} — ${yearLabel(s.year)}</option>`).join("")
    : `<option value="">No ${semesterLabel(sem)} subjects in this course</option>`;
}

function listenToOverridesAndDaysOff(courseId) {
  if (ttOverridesUnsub) { ttOverridesUnsub(); ttOverridesUnsub = null; }
  if (ttDayOffsUnsub) { ttDayOffsUnsub(); ttDayOffsUnsub = null; }
  ttOverrides = [];
  ttDayOffs = [];
  if (!courseId) { renderTtWeek(); return; }
  ttOverridesUnsub = onSnapshot(query(collection(db, "scheduleOverrides"), where("courseId", "==", courseId)), (snap) => {
    ttOverrides = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTtWeek();
  });
  ttDayOffsUnsub = onSnapshot(query(collection(db, "courseDaysOff"), where("courseId", "==", courseId)), (snap) => {
    ttDayOffs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTtWeek();
  });
}

function switchTtCourse(courseId) {
  currentTtCourseId = courseId || null;
  if (courseScheduleUnsub) { courseScheduleUnsub(); courseScheduleUnsub = null; }
  resetTtSchedForm();
  const tbody = $("courseTimetableBody");
  if (!courseId) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">Choose a course above.</td></tr>`;
    $("ttSchedSubject").innerHTML = "";
    ttEntriesCache = [];
    listenToOverridesAndDaysOff(null);
    return;
  }
  populateTtSubjectOptions();
  listenToOverridesAndDaysOff(courseId);
  const q = query(collection(db, "scheduleEntries"), where("courseId", "==", courseId));
  courseScheduleUnsub = onSnapshot(q, (snap) => {
    if (snap.empty) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No timetable entries for this course yet.</td></tr>`;
      ttEntriesCache = [];
      renderTtWeek();
      return;
    }
    const entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    entries.sort((a, b) => DAYS.indexOf(a.dayOfWeek) - DAYS.indexOf(b.dayOfWeek) || (a.startTime || "").localeCompare(b.startTime || ""));
    ttEntriesCache = entries;
    tbody.innerHTML = entries.map((s) => `
      <tr>
        <td>${escapeHtml(s.dayOfWeek)}</td>
        <td>${escapeHtml(s.startTime)}–${escapeHtml(s.endTime)}</td>
        <td>${s.semester ? "Sem " + s.semester : "—"}</td>
        <td>${escapeHtml(s.subjectName || "—")}</td>
        <td>${escapeHtml(s.lecturerName || "—")}</td>
        <td>${escapeHtml(s.venue || "—")}</td>
        <td>
          <select class="statusSelect" data-id="${s.id}">
            ${CLASS_STATUSES.map((c) => `<option value="${c.value}" ${s.status === c.value ? "selected" : ""}>${c.label}</option>`).join("")}
          </select>
        </td>
        <td>
          <button class="btn btn-secondary btn-small editTtSchedBtn" data-id="${s.id}">Edit</button>
          <button class="btn btn-danger btn-small delTtSchedBtn" data-id="${s.id}">Remove</button>
        </td>
      </tr>`).join("");

    tbody.querySelectorAll(".statusSelect").forEach((sel) =>
      sel.addEventListener("change", async () => {
        await updateDoc(doc(db, "scheduleEntries", sel.dataset.id), { status: sel.value });
      })
    );
    tbody.querySelectorAll(".delTtSchedBtn").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Remove this class from the course timetable?")) return;
        await deleteDoc(doc(db, "scheduleEntries", b.dataset.id));
      })
    );
    tbody.querySelectorAll(".editTtSchedBtn").forEach((b) =>
      b.addEventListener("click", () => {
        const entry = entries.find((x) => x.id === b.dataset.id);
        if (entry) startEditTtSched(entry);
      })
    );

    renderTtWeek();
  });
}

function startEditTtSched(entry) {
  $("ttSchedEntryId").value = entry.id;
  $("ttSchedSemester").value = entry.semester || 1;
  populateTtSubjectOptions();
  $("ttSchedSubject").value = entry.subjectId;
  populateTtLecturerOptions();
  $("ttSchedLecturer").value = entry.lecturerId;
  $("ttSchedDay").value = entry.dayOfWeek;
  $("ttSchedStart").value = entry.startTime || "";
  $("ttSchedEnd").value = entry.endTime || "";
  $("ttSchedVenue").value = entry.venue || "";
  $("ttSchedStatus").value = entry.status || "Happening";
  $("ttSchedSubmitBtn").textContent = "Save Changes";
  $("cancelTtSchedEdit").classList.remove("hidden");
  showMsg($("ttSchedMsg"), "", "");
}
function resetTtSchedForm() {
  $("courseScheduleForm").reset();
  $("ttSchedEntryId").value = "";
  populateTtSubjectOptions();
  populateTtLecturerOptions();
  $("ttSchedSubmitBtn").textContent = "+ Add to Course Timetable";
  $("cancelTtSchedEdit").classList.add("hidden");
}
$("cancelTtSchedEdit").addEventListener("click", resetTtSchedForm);

$("courseScheduleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("ttSchedMsg");
  const course = coursesCache.find((c) => c.id === currentTtCourseId);
  const subject = course && (course.subjects || []).find((s) => s.id === $("ttSchedSubject").value);
  const lecturer = lecturersCache.find((l) => l.id === $("ttSchedLecturer").value);
  if (!course || !subject) {
    showMsg(msg, "Choose a course and subject.", "error");
    return;
  }
  if (!lecturer) {
    showMsg(msg, "Choose a lecturer.", "error");
    return;
  }
  const payload = {
    courseId: course.id,
    courseName: course.name,
    semester: Number($("ttSchedSemester").value),
    subjectId: subject.id,
    subjectName: subject.name,
    lecturerId: lecturer.id,
    lecturerName: lecturer.name || lecturer.email,
    dayOfWeek: $("ttSchedDay").value,
    startTime: $("ttSchedStart").value,
    endTime: $("ttSchedEnd").value,
    venue: $("ttSchedVenue").value.trim(),
    status: $("ttSchedStatus").value,
  };
  const entryId = $("ttSchedEntryId").value;
  try {
    if (entryId) {
      await updateDoc(doc(db, "scheduleEntries", entryId), payload);
      showMsg(msg, "Class updated.", "success");
    } else {
      await addDoc(collection(db, "scheduleEntries"), { ...payload, createdAt: serverTimestamp() });
      showMsg(msg, "Class added to the course timetable.", "success");
    }
    resetTtSchedForm();
  } catch (err) {
    showMsg(msg, "Couldn't save: " + err.message, "error");
  }
});

// ---------------- Calendar Status Editor — Weekly ----------------
function renderTtWeek() {
  const list = $("ttWeekList");
  const label = $("ttWeekLabel");
  if (!currentTtCourseId) { list.innerHTML = ""; label.textContent = "—"; return; }

  const weekStart = startOfWeek(ttWeekAnchor);
  const weekEnd = addDays(weekStart, 6);
  label.textContent = `${weekStart.getDate()} ${monthName(weekStart.getMonth())} – ${weekEnd.getDate()} ${monthName(weekEnd.getMonth())} ${weekEnd.getFullYear()}`;

  const overrideMap = new Map(ttOverrides.map((o) => [o.scheduleEntryId + "_" + o.date, o]));
  const dayOffSet = new Set(ttDayOffs.map((d) => d.date));

  let html = "";
  let any = false;
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const dateStr = toISODate(date);
    const wd = weekdayName(date);
    const semNum = currentSemesterNumber(semestersCache, dateStr);
    const dayEntries = ttEntriesCache
      .filter((e) => e.dayOfWeek === wd && (e.semester == null || e.semester === semNum))
      .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));
    if (dayEntries.length === 0) continue;
    any = true;
    const isDayOff = dayOffSet.has(dateStr);
    html += `
      <div class="subject-info-block">
        <h3 style="font-size:13px; color:var(--navy); margin-bottom:8px;">${wd}, ${date.getDate()} ${monthName(date.getMonth())}${isDayOff ? ` <span class="badge status-cancelled">Day Off</span>` : ""}</h3>
        <table class="data-table" style="box-shadow:none; border:none;">
          <tbody>
            ${dayEntries.map((e) => {
              const eff = effectiveStatus(e, dateStr, dayOffSet, overrideMap);
              return `
                <tr>
                  <td>${escapeHtml(e.startTime)}–${escapeHtml(e.endTime)}</td>
                  <td>${escapeHtml(e.subjectName)}</td>
                  <td>
                    <select class="weekOverrideSelect" data-entry="${e.id}" data-date="${dateStr}" ${isDayOff ? "disabled" : ""}>
                      ${CLASS_STATUSES.map((c) => `<option value="${c.value}" ${eff === c.value ? "selected" : ""}>${c.label}</option>`).join("")}
                    </select>
                  </td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  }
  list.innerHTML = any ? html : `<div class="placeholder-card"><p>No classes scheduled this week — check the Semester Dates, or this week may fall in the break between semesters.</p></div>`;

  list.querySelectorAll(".weekOverrideSelect").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const entryId = sel.dataset.entry;
      const date = sel.dataset.date;
      try {
        await setDoc(doc(db, "scheduleOverrides", entryId + "_" + date), {
          courseId: currentTtCourseId,
          scheduleEntryId: entryId,
          date,
          status: sel.value,
          createdBy: currentUser.uid,
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        alert("Couldn't save this week's status: " + err.message);
      }
    })
  );
}
$("ttWeekPrev").addEventListener("click", () => { ttWeekAnchor = addDays(ttWeekAnchor, -7); renderTtWeek(); });
$("ttWeekNext").addEventListener("click", () => { ttWeekAnchor = addDays(ttWeekAnchor, 7); renderTtWeek(); });
