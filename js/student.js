import { guardPage, logOut } from "./auth.js";
import { db } from "./firebase-config.js";
import { classStatusLabel, infoTypeLabel, yearLabel, semesterLabel } from "./academic.js";
import {
  toISODate, parseISODate, todayISO, addDays, weekdayName, monthName,
  startOfWeek, isDateInRange, currentSemesterNumber, nextSemester,
  effectiveStatus,
} from "./calendarUtils.js";
import { uploadFile, fileUrl, fileBodyHtml } from "./localFiles.js";
import {
  collection, query, where, orderBy, onSnapshot,
  doc, documentId, addDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

let currentUser = null;
let enrolledCourses = new Map(); // courseId -> courseName
let enrolledEntries = [];        // scheduleEntries across all enrolled courses
let overridesCache = [];         // scheduleOverrides for enrolled courses
let dayOffsCache = [];           // courseDaysOff for enrolled courses
let semestersCache = {};         // {1: {startDate,endDate}, 2: {...}}
let scheduleUnsub = null;
let overridesUnsub = null;
let dayOffsUnsub = null;
let courseDocsUnsub = null;
let enrolledCourseDocs = [];     // full course docs (with subjects[]) for enrolled courses
const courseInfoSubjectUnsubs = new Map(); // subjectId -> unsub fn
let myClaimedItemIds = new Set();

let calWeekAnchor = new Date();
let calSelectedDate = null;

guardPage({
  allowedRoles: ["student"],
  onReady: (user) => {
    currentUser = user;
    document.getElementById("userName").textContent = user.email;
    document.getElementById("loadingScreen").style.display = "none";
    document.getElementById("appShell").style.display = "block";
    listenToSemesters();
    listenToEnrollments();
    listenToGeneralInfo();
    listenToLostFound();
    listenToMyClaims();
  },
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
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

// ---------------- Section tabs ----------------
document.querySelectorAll(".section-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".section-tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".section-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("section-" + tab.dataset.section).classList.add("active");
  });
});

// ---------------- Semesters ----------------
function listenToSemesters() {
  onSnapshot(collection(db, "semesters"), (snap) => {
    semestersCache = {};
    snap.forEach((d) => { semestersCache[Number(d.id)] = { id: d.id, ...d.data() }; });
    renderCalendar();
  });
}

// ---------------- Enrollments -> drives Calendar + Course Info ----------------
function listenToEnrollments() {
  const q = query(collection(db, "enrollments"), where("studentUserId", "==", currentUser.uid));
  onSnapshot(q, (snap) => {
    enrolledCourses = new Map();
    snap.forEach((d) => enrolledCourses.set(d.data().courseId, d.data().courseName));
    listenToSchedule();
    listenToOverridesAndDaysOff();
    listenToEnrolledCourseDocs();
  });
}

function listenToSchedule() {
  if (scheduleUnsub) scheduleUnsub();
  const notice = document.getElementById("enrollmentNotice");
  const courseIds = [...enrolledCourses.keys()].slice(0, 10); // Firestore 'in' supports up to 10

  if (courseIds.length === 0) {
    enrolledEntries = [];
    notice.style.display = "block";
    notice.className = "form-msg error";
    notice.textContent = "You're not enrolled in any courses yet — ask your lecturer to add you.";
    document.getElementById("noSessionNotice").style.display = "none";
    document.getElementById("calendarBody").style.display = "none";
    return;
  }
  notice.style.display = "none";

  const q = query(collection(db, "scheduleEntries"), where("courseId", "in", courseIds));
  scheduleUnsub = onSnapshot(q, (snap) => {
    enrolledEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCalendar();
  });
}

function listenToOverridesAndDaysOff() {
  if (overridesUnsub) { overridesUnsub(); overridesUnsub = null; }
  if (dayOffsUnsub) { dayOffsUnsub(); dayOffsUnsub = null; }
  overridesCache = [];
  dayOffsCache = [];
  const courseIds = [...enrolledCourses.keys()].slice(0, 10);
  if (courseIds.length === 0) return;
  overridesUnsub = onSnapshot(query(collection(db, "scheduleOverrides"), where("courseId", "in", courseIds)), (snap) => {
    overridesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCalendar();
  });
  dayOffsUnsub = onSnapshot(query(collection(db, "courseDaysOff"), where("courseId", "in", courseIds)), (snap) => {
    dayOffsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCalendar();
  });
}

// ---------------- Calendar: gate on "is a semester currently active" ----------------
function renderCalendar() {
  if (enrolledCourses.size === 0) return; // listenToSchedule already shows the "not enrolled" notice
  const activeSem = currentSemesterNumber(semestersCache, todayISO());
  const noSession = document.getElementById("noSessionNotice");
  const body = document.getElementById("calendarBody");

  if (!activeSem) {
    const next = nextSemester(semestersCache, todayISO());
    noSession.style.display = "block";
    noSession.innerHTML = `<div class="no-session-card"><h2 style="color:var(--navy); font-size:16px; margin-bottom:6px;">No semester is currently active</h2><p>${
      next ? `Semester ${next.semester} starts ${escapeHtml(next.startDate)}.` : "Check back once your next semester's dates are set."
    }</p></div>`;
    body.style.display = "none";
    return;
  }
  noSession.style.display = "none";
  body.style.display = "block";
  renderCalWeek();
}

// ---------------- Calendar: Week view ----------------
function renderCalWeek() {
  const activeSem = currentSemesterNumber(semestersCache, todayISO());
  if (!activeSem) return;
  const sem = semestersCache[activeSem];
  const label = document.getElementById("calWeekLabel");
  const strip = document.getElementById("calWeekStrip");

  const weekStart = addDays(startOfWeek(calWeekAnchor), 1); // Monday
  const weekEnd = addDays(weekStart, 4); // Friday
  label.textContent = `${weekStart.getDate()} ${monthName(weekStart.getMonth())} – ${weekEnd.getDate()} ${monthName(weekEnd.getMonth())} ${weekEnd.getFullYear()}`;

  const today = todayISO();
  const weekDates = [...Array(5)].map((_, i) => toISODate(addDays(weekStart, i)));
  if (!calSelectedDate || !weekDates.includes(calSelectedDate)) {
    calSelectedDate =
      weekDates.includes(today) && isDateInRange(today, sem.startDate, sem.endDate)
        ? today
        : weekDates.find((d) => isDateInRange(d, sem.startDate, sem.endDate)) || weekDates[0];
  }

  const dowLetters = ["M", "T", "W", "T", "F"];
  let stripHtml = "";
  weekDates.forEach((dateStr, i) => {
    const date = parseISODate(dateStr);
    const wd = weekdayName(date);
    const inSemester = isDateInRange(dateStr, sem.startDate, sem.endDate);
    const hasClasses = inSemester && enrolledEntries.some((e) => e.dayOfWeek === wd && (e.semester == null || e.semester === activeSem));
    const classes = ["week-day"];
    if (!inSemester) classes.push("no-school");
    if (dateStr === today) classes.push("today");
    if (dateStr === calSelectedDate) classes.push("selected");
    if (hasClasses) classes.push("has-classes");
    stripHtml += `<div class="${classes.join(" ")}" ${inSemester ? `data-date="${dateStr}"` : ""}>
      <span>${dowLetters[i]}</span>
      <span class="wd-num">${date.getDate()}</span>
    </div>`;
  });
  strip.innerHTML = stripHtml;
  strip.querySelectorAll(".week-day[data-date]").forEach((el) =>
    el.addEventListener("click", () => {
      calSelectedDate = el.dataset.date;
      renderCalWeek();
    })
  );

  document.getElementById("calWeekPrev").disabled = toISODate(addDays(weekStart, -1)) < sem.startDate;
  document.getElementById("calWeekNext").disabled = toISODate(addDays(weekEnd, 1)) > sem.endDate;

  renderCalDayClasses(calSelectedDate, activeSem);
}
document.getElementById("calWeekPrev").addEventListener("click", () => { calWeekAnchor = addDays(calWeekAnchor, -7); renderCalWeek(); });
document.getElementById("calWeekNext").addEventListener("click", () => { calWeekAnchor = addDays(calWeekAnchor, 7); renderCalWeek(); });


function renderCalDayClasses(dateStr, semNum) {
  const heading = document.getElementById("calSelectedDayLabel");
  const holder = document.getElementById("calDayClasses");
  const date = parseISODate(dateStr);
  heading.textContent = `${weekdayName(date)}, ${date.getDate()} ${monthName(date.getMonth())} ${date.getFullYear()}`;

  const wd = weekdayName(date);
  const dayEntries = enrolledEntries
    .filter((e) => e.dayOfWeek === wd && (e.semester == null || e.semester === semNum))
    .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));

  if (dayEntries.length === 0) {
    holder.innerHTML = `<div class="placeholder-card"><p>No classes on this day.</p></div>`;
    return;
  }

  const overrideMap = new Map(overridesCache.map((o) => [o.scheduleEntryId + "_" + o.date, o]));
  const dayOffByCourseDate = new Set(dayOffsCache.map((d) => d.courseId + "_" + d.date));

  holder.innerHTML = dayEntries.map((e) => {
    const dayOffSet = dayOffByCourseDate.has(e.courseId + "_" + dateStr) ? new Set([dateStr]) : new Set();
    const status = effectiveStatus(e, dateStr, dayOffSet, overrideMap);
    return `
      <div class="event-item" style="display:flex; gap:12px; background:white; border-radius:8px; padding:12px 14px; margin-bottom:8px; border:1px solid var(--border);">
        <div class="event-time" style="font-weight:700; color:var(--navy); font-size:13px; min-width:100px;">${escapeHtml(e.startTime)}–${escapeHtml(e.endTime)}</div>
        <div style="flex:1;">
          <div style="font-weight:600; font-size:14px;">${escapeHtml(e.subjectName || enrolledCourses.get(e.courseId) || "Class")}</div>
          <div class="small-muted">${escapeHtml(enrolledCourses.get(e.courseId) || "")} · ${escapeHtml(e.venue || "No venue set")}${e.lecturerName ? ` · ${escapeHtml(e.lecturerName)}` : ""}</div>
        </div>
        <span class="badge status-${status.toLowerCase()}">${escapeHtml(classStatusLabel(status))}</span>
      </div>`;
  }).join("");
}

// ---------------- Information — General Info (read-only) ----------------
function infoCardHtml(item) {
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
      <div class="small-muted" style="margin-top:6px;">${fmtDate(item.createdAt)}</div>
    </div>`;
}

function listenToGeneralInfo() {
  const q = query(collection(db, "generalInfoItems"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    const list = document.getElementById("generalInfoList");
    if (snap.empty) {
      list.innerHTML = `<div class="placeholder-card"><p>No general info posted yet.</p></div>`;
      return;
    }
    list.innerHTML = snap.docs.map((d) => infoCardHtml({ id: d.id, ...d.data() })).join("");
  });
}

// ---------------- Information — Course Info (read-only, per enrolled course) ----------------
function listenToEnrolledCourseDocs() {
  if (courseDocsUnsub) { courseDocsUnsub(); courseDocsUnsub = null; }
  clearCourseInfoSubs();
  const courseIds = [...enrolledCourses.keys()].slice(0, 10);
  const notice = document.getElementById("courseInfoNotice");

  if (courseIds.length === 0) {
    enrolledCourseDocs = [];
    notice.style.display = "block";
    notice.className = "form-msg error";
    notice.textContent = "You're not enrolled in any courses yet.";
    document.getElementById("courseInfoList").innerHTML = "";
    return;
  }
  notice.style.display = "none";

  const q = query(collection(db, "courses"), where(documentId(), "in", courseIds));
  courseDocsUnsub = onSnapshot(q, (snap) => {
    enrolledCourseDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCourseInfo();
  });
}

function clearCourseInfoSubs() {
  courseInfoSubjectUnsubs.forEach((unsub) => unsub());
  courseInfoSubjectUnsubs.clear();
}

function renderCourseInfo() {
  clearCourseInfoSubs();
  const list = document.getElementById("courseInfoList");
  if (enrolledCourseDocs.length === 0) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = enrolledCourseDocs.map((course) => {
    const subjects = [...(course.subjects || [])].sort(
      (a, b) => a.year - b.year || a.semester - b.semester || a.name.localeCompare(b.name)
    );
    return `
      <div class="placeholder-card" style="margin-bottom:16px;">
        <h2>${escapeHtml(course.name)}</h2>
        ${subjects.map((s) => `
          <div class="subject-info-block" style="box-shadow:none;">
            <div class="subject-info-head">
              <h3>${escapeHtml(s.name)} <span class="small-muted">— ${yearLabel(s.year)}, ${semesterLabel(s.semester)}</span></h3>
            </div>
            <div id="waLink-${s.id}" class="small-muted" style="margin-bottom:8px;">No WhatsApp group link yet.</div>
            <div class="subject-info-items" id="studentSubjItems-${s.id}"><p class="small-muted">Loading…</p></div>
          </div>`).join("")}
      </div>`;
  }).join("");

  enrolledCourseDocs.forEach((course) => {
    (course.subjects || []).forEach((s) => {
      if (courseInfoSubjectUnsubs.has(s.id)) return; // a subject can repeat across courses — one listener is enough
      const linkUnsub = onSnapshot(doc(db, "subjectInfo", s.id), (snap) => {
        document.querySelectorAll(`#waLink-${s.id}`).forEach((el) => {
          const link = snap.exists() ? snap.data().whatsappLink : "";
          el.innerHTML = link
            ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">Open WhatsApp group →</a>`
            : "No WhatsApp group link yet.";
        });
      });
      const itemsUnsub = onSnapshot(
        query(collection(db, "subjectInfo", s.id, "items"), orderBy("createdAt", "desc")),
        (snap) => {
          document.querySelectorAll(`#studentSubjItems-${s.id}`).forEach((holder) => {
            if (snap.empty) {
              holder.innerHTML = `<p class="small-muted">No info added for this subject yet.</p>`;
              return;
            }
            holder.innerHTML = snap.docs.map((d) => infoCardHtml({ id: d.id, ...d.data() })).join("");
          });
        }
      );
      courseInfoSubjectUnsubs.set(s.id, () => { linkUnsub(); itemsUnsub(); });
    });
  });
}

// ---------------- Lost & Found ----------------
let latestItems = [];

function listenToLostFound() {
  const q = query(collection(db, "lostFoundItems"), orderBy("dateReported", "desc"));
  onSnapshot(q, (snap) => {
    latestItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderLostFound();
  });
}

function listenToMyClaims() {
  const q = query(collection(db, "itemClaims"), where("claimantUserId", "==", currentUser.uid));
  onSnapshot(q, (snap) => {
    myClaimedItemIds = new Set(snap.docs.map((d) => d.data().itemId));
    renderLostFound();
  });
}

function renderLostFound() {
  const list = document.getElementById("lostFoundList");
  if (latestItems.length === 0) {
    list.innerHTML = `<div class="placeholder-card"><p>No items reported yet.</p></div>`;
    return;
  }
  list.innerHTML = latestItems.map((i) => {
    const status = i.status || "Lost";
    const isMine = i.reportedByUserId === currentUser.uid;
    const alreadyClaimed = myClaimedItemIds.has(i.id);
    let actionHtml = "";
    if (status === "Claimed") {
      actionHtml = `<span class="small-muted">Already claimed</span>`;
    } else if (isMine) {
      actionHtml = `<span class="small-muted">You reported this item</span>`;
    } else if (alreadyClaimed) {
      actionHtml = `<span class="small-muted">Claim submitted — awaiting review</span>`;
    } else {
      actionHtml = `<button class="btn btn-secondary btn-small claimBtn" data-id="${i.id}">Claim this item</button>`;
    }
    const photoHtml = i.fileName
      ? `<a href="${fileUrl(i.fileName, i.fileOriginalName)}" target="_blank" rel="noopener"><img src="${fileUrl(i.fileName, i.fileOriginalName)}" alt="${escapeHtml(i.itemName)}" loading="lazy" style="width:100%; max-height:220px; object-fit:cover; border-radius:8px; margin-bottom:10px; display:block;" /></a>`
      : "";
    return `
      <div class="card" style="background:white; border-radius:10px; padding:16px; margin-bottom:12px; border:1px solid var(--border);">
        ${photoHtml}
        <span class="badge status-${status.toLowerCase()}">${escapeHtml(status)}</span>
        <div style="font-weight:600; font-size:15px; margin:6px 0 4px;">${escapeHtml(i.itemName)}${i.category ? ` <span class="small-muted">(${escapeHtml(i.category)})</span>` : ""}</div>
        <div style="font-size:13px; color:#555; margin-bottom:8px;">${escapeHtml(i.description)}</div>
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--muted);">
          <span>${fmtDate(i.dateReported)}</span>
          ${actionHtml}
        </div>
      </div>`;
  }).join("");

  document.querySelectorAll(".claimBtn").forEach((b) =>
    b.addEventListener("click", () => submitClaim(b.dataset.id))
  );
}

async function submitClaim(itemId) {
  try {
    await addDoc(collection(db, "itemClaims"), {
      itemId,
      claimantUserId: currentUser.uid,
      claimDate: serverTimestamp(),
      status: "Pending",
    });
  } catch (err) {
    alert("Couldn't submit claim: " + err.message);
  }
}

// ---------------- Report item modal ----------------
const reportModal = document.getElementById("reportModal");
const photoInput = document.getElementById("itemPhotoInput");
const photoPreview = document.getElementById("itemPhotoPreview");
photoInput.addEventListener("change", () => {
  const f = photoInput.files[0];
  if (f && f.type.startsWith("image/")) {
    photoPreview.src = URL.createObjectURL(f);
    photoPreview.classList.remove("hidden");
  } else {
    photoPreview.classList.add("hidden");
  }
});

document.getElementById("reportItemBtn").addEventListener("click", () => {
  document.getElementById("reportForm").reset();
  photoPreview.classList.add("hidden");
  document.getElementById("reportMsg").className = "form-msg";
  reportModal.classList.remove("hidden");
});
document.getElementById("cancelReport").addEventListener("click", () => {
  reportModal.classList.add("hidden");
});

document.getElementById("reportForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("reportMsg");
  const btn = document.getElementById("reportSubmitBtn");
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    const status = document.querySelector('input[name="itemStatus"]:checked').value;
    const photo = photoInput.files[0];
    if (photo && !photo.type.startsWith("image/")) throw new Error("The photo must be an image.");
    const photoFields = photo ? await uploadFile(photo) : {}; // fileName, fileOriginalName, fileSize
    await addDoc(collection(db, "lostFoundItems"), {
      itemName: document.getElementById("itemNameInput").value.trim(),
      category: document.getElementById("itemCategoryInput").value.trim(),
      description: document.getElementById("itemDescInput").value.trim(),
      status,
      ...photoFields,
      reportedByUserId: currentUser.uid,
      dateReported: serverTimestamp(),
    });
    msg.textContent = "Item reported.";
    msg.className = "form-msg success";
    setTimeout(() => reportModal.classList.add("hidden"), 800);
  } catch (err) {
    msg.textContent = "Couldn't submit report: " + err.message;
    msg.className = "form-msg error";
  } finally {
    btn.disabled = false;
    btn.textContent = "Submit Report";
  }
});
