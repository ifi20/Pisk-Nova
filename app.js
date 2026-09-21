"use strict";

/*
 * PISK NOVA Enterprise Edition
 * ---------------------------------------------------------------------------
 * This file intentionally uses plain, beginner-friendly JavaScript.
 * No framework, package manager, backend, or build process is required.
 */

// ================================ CONFIGURATION ================================

var STORAGE_KEY = "pisk_saved_students";
var BACKUP_FORMAT = "PISK_NOVA_LOCAL_BACKUP";
var SCHEMA_VERSION = 2;

// IMPORTANT: A browser-only password is not secure against source inspection.
// This value is retained to preserve the original Smart Login behavior.
var ADMIN_USERNAME = "admin";
var ADMIN_PASSWORD = "123";

/*
 * FBISE formats vary between institutions and exam sessions.
 * This expression accepts either:
 * 1) a numeric registration number containing 6–16 digits, or
 * 2) 2–4 alphanumeric groups separated by a hyphen or slash.
 * Change this one constant if your institution receives a stricter board format.
 */
var FBISE_REG_REGEX = /^(?:\d{6,16}|[A-Z0-9]{2,8}(?:[-/][A-Z0-9]{1,12}){1,3})$/i;

// Pakistan CNIC/B-Form: 00000-0000000-0
var PAK_ID_REGEX = /^\d{5}-\d{7}-\d$/;

// Saudi Iqama: 10 digits and normally begins with 1 or 2.
var IQAMA_REGEX = /^[12]\d{9}$/;

var EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// The existing 600-mark subject structure is kept exactly as supplied.
var SUBJECTS = [
  { key: "chemistry", label: "Chemistry", max: 75 },
  { key: "computerBiology", label: "Computer / Biology", max: 75 },
  { key: "physics", label: "Physics", max: 75 },
  { key: "math", label: "Mathematics", max: 75 },
  { key: "english", label: "English", max: 75 },
  { key: "urdu", label: "Urdu", max: 75 },
  { key: "islamiyat", label: "Islamiyat", max: 100 },
  { key: "tarjumaQuran", label: "Tarjuma-tul-Quran", max: 50 }
];

var currentStudent = null;
var allStudentsCache = [];
var pendingImport = null;

// ================================ SMALL HELPERS ================================

function byId(id) {
  return document.getElementById(id);
}

function clean(value) {
  return String(value == null ? "" : value).trim();
}

// Escaping user data prevents stored HTML/script injection when records are shown.
function escapeHTML(value) {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeNumber(value) {
  var number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatDate(dateText) {
  if (!dateText) return "Not recorded";
  var parts = dateText.split("-");
  if (parts.length !== 3) return dateText;
  return parts[2] + " " + new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    .toLocaleString("en", { month: "short" }) + " " + parts[0];
}

function showToast(message, type) {
  var toast = document.createElement("div");
  toast.className = "toast " + (type || "");
  toast.textContent = message;
  byId("toast-region").appendChild(toast);
  window.setTimeout(function () { toast.remove(); }, 4200);
}

function showFieldError(inputId, message) {
  var input = byId(inputId);
  var error = byId(inputId + "-error");
  input.classList.add("invalid");
  input.setAttribute("aria-invalid", "true");
  if (error) {
    error.textContent = message;
    error.classList.remove("hidden");
  }
}

function clearFieldError(inputId) {
  var input = byId(inputId);
  var error = byId(inputId + "-error");
  input.classList.remove("invalid");
  input.removeAttribute("aria-invalid");
  if (error) error.classList.add("hidden");
}

function debounce(callback, delay) {
  var timer;
  return function () {
    var args = arguments;
    window.clearTimeout(timer);
    timer = window.setTimeout(function () { callback.apply(null, args); }, delay);
  };
}

// =============================== DATA MANAGEMENT ===============================

function getLocalStudents() {
  try {
    var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Local database could not be parsed:", error);
    showToast("The local database is damaged. Export it before making changes.", "error");
    return [];
  }
}

function saveLocalStudents(students) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(students));
}

/*
 * New records use the full schema. Old JSON records are normalized at runtime
 * so the original database remains searchable and Smart Login remains intact.
 */
function normalizeStudent(record) {
  var normalized = Object.assign({}, record);
  normalized.admission = clean(record.admission || record.rollNumber);
  normalized.name = clean(record.name);
  normalized.father = clean(record.father || record.fatherName);
  normalized.fatherEmail = clean(record.fatherEmail);
  normalized.class = clean(record.class);
  normalized.incharge = clean(record.incharge);
  normalized.fbiseRegistrationNumber = clean(record.fbiseRegistrationNumber);
  normalized.studentGovernmentId = clean(record.studentGovernmentId);
  normalized.fatherGovernmentId = clean(record.fatherGovernmentId);
  normalized.dateOfBirth = clean(record.dateOfBirth);
  normalized.schemaVersion = Number(record.schemaVersion || 1);
  return normalized;
}

/*
 * Merge rule:
 * - JSON supplies the base database.
 * - A LocalStorage record with the same roll number replaces the JSON version.
 * This prevents duplicate cards and lets restored/local data be the newest copy.
 */
function mergeStudentDatabases(jsonStudents, localStudents) {
  var map = new Map();
  jsonStudents.forEach(function (student) {
    var normalized = normalizeStudent(student);
    map.set(normalized.admission.toLowerCase(), normalized);
  });
  localStudents.forEach(function (student) {
    var normalized = normalizeStudent(student);
    map.set(normalized.admission.toLowerCase(), normalized);
  });
  return Array.from(map.values());
}

async function loadAllStudents() {
  var jsonStudents = [];
  try {
    var response = await fetch("students.json", { cache: "no-store" });
    if (!response.ok) throw new Error("students.json returned " + response.status);
    var data = await response.json();
    if (!Array.isArray(data)) throw new Error("students.json must contain an array");
    jsonStudents = data;
  } catch (error) {
    /*
     * LocalStorage still works if students.json cannot be loaded. This commonly
     * happens when index.html is opened via file:// instead of a local web server.
     */
    console.warn("Base JSON database unavailable:", error);
    showToast("Base JSON could not load. Run the folder through a local web server; local records are still available.", "error");
  }
  allStudentsCache = mergeStudentDatabases(jsonStudents, getLocalStudents());
  return allStudentsCache;
}

function validateImportedRecord(record, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return "Record " + (index + 1) + " is not an object.";
  }
  if (!clean(record.admission) || !clean(record.name) || !clean(record.father)) {
    return "Record " + (index + 1) + " requires admission, name, and father.";
  }

  // New-schema records must pass the same government validation as the form.
  if (Number(record.schemaVersion || 1) >= 2) {
    if (!FBISE_REG_REGEX.test(clean(record.fbiseRegistrationNumber))) {
      return "Record " + (index + 1) + " has an invalid FBISE registration number.";
    }
    if (!isGovernmentId(clean(record.studentGovernmentId))) {
      return "Record " + (index + 1) + " has an invalid student B-Form/Iqama.";
    }
    if (!isGovernmentId(clean(record.fatherGovernmentId))) {
      return "Record " + (index + 1) + " has an invalid father's CNIC/Iqama.";
    }
    if (!isValidDateOfBirth(clean(record.dateOfBirth))) {
      return "Record " + (index + 1) + " has an invalid date of birth.";
    }
  }
  return "";
}

// ============================ LOGIN AND NAVIGATION =============================

async function smartLogin(event) {
  event.preventDefault();
  var id = clean(byId("login-id").value);
  var pass = clean(byId("login-pass").value);
  var errorBox = byId("login-error");
  errorBox.classList.add("hidden");

  if (!id || !pass) {
    errorBox.textContent = "Please enter both credentials.";
    errorBox.classList.remove("hidden");
    return;
  }

  // Preserve the original admin credential route.
  if (id === ADMIN_USERNAME && pass === ADMIN_PASSWORD) {
    await openAdmin();
    return;
  }

  // Preserve student route: exact roll + partial, case-insensitive father's name.
  var students = await loadAllStudents();
  var found = students.find(function (student) {
    return student.admission === id &&
      student.father.toLowerCase().includes(pass.toLowerCase());
  });

  if (!found) {
    errorBox.textContent = "Invalid credentials. No matching administrator or student was found.";
    errorBox.classList.remove("hidden");
    return;
  }

  currentStudent = found;
  byId("student-result-box").innerHTML = buildRecordHTML(found);
  byId("login").classList.add("hidden");
  byId("student-app").classList.remove("hidden");
}

async function openAdmin() {
  byId("login").classList.add("hidden");
  byId("admin-app").classList.remove("hidden");
  await refreshAdminData();
  showAdminSection("overview");
}

function logout() {
  currentStudent = null;
  byId("admin-app").classList.add("hidden");
  byId("student-app").classList.add("hidden");
  byId("login").classList.remove("hidden");
  byId("login-form").reset();
  byId("login-error").classList.add("hidden");
  closeMobileMenu();
  byId("login-id").focus();
}

function showAdminSection(sectionName) {
  document.querySelectorAll(".workspace-section").forEach(function (section) {
    section.classList.toggle("hidden", section.id !== "section-" + sectionName);
  });
  document.querySelectorAll(".nav-item[data-section]").forEach(function (button) {
    button.classList.toggle("active", button.dataset.section === sectionName);
  });
  if (sectionName === "search") renderSearchResults(byId("admin-search").value);
  closeMobileMenu();
  window.scrollTo(0, 0);
}

function openMobileMenu() {
  document.querySelector(".sidebar").classList.add("open");
  byId("sidebar-scrim").classList.remove("hidden");
}

function closeMobileMenu() {
  document.querySelector(".sidebar").classList.remove("open");
  byId("sidebar-scrim").classList.add("hidden");
}

// ============================= GRADES AND RESULTS ==============================

// The original grading scale is intentionally unchanged.
function gradeCalc(percentage) {
  if (percentage >= 90) return "A+";
  if (percentage >= 80) return "A";
  if (percentage >= 70) return "B";
  if (percentage >= 60) return "C";
  if (percentage >= 50) return "D";
  return "F";
}

function isModernRecord(student) {
  return Number(student.schemaVersion || 1) >= 2 ||
    SUBJECTS.some(function (subject) {
      return Object.prototype.hasOwnProperty.call(student, subject.key);
    });
}

function getResult(student) {
  if (isModernRecord(student)) {
    var rows = SUBJECTS.map(function (subject) {
      var obtained = safeNumber(student[subject.key]);
      var percentage = subject.max ? (obtained / subject.max) * 100 : 0;
      return {
        label: subject.label,
        obtained: obtained,
        max: subject.max,
        percentage: percentage,
        grade: gradeCalc(percentage)
      };
    });
    var total = rows.reduce(function (sum, row) { return sum + row.obtained; }, 0);
    var maximum = rows.reduce(function (sum, row) { return sum + row.max; }, 0);
    return { rows: rows, total: total, maximum: maximum, percentage: maximum ? total / maximum * 100 : 0, legacy: false };
  }

  /*
   * Compatibility path for the supplied legacy JSON. Those records contain
   * five 100-mark subjects. We do not silently alter historic marks.
   */
  var legacySubjects = [
    { key: "math", label: "Mathematics" },
    { key: "physics", label: "Physics" },
    { key: "chemistry", label: "Chemistry" },
    { key: "english", label: "English" },
    { key: "urdu", label: "Urdu" }
  ];
  var legacyRows = legacySubjects.map(function (subject) {
    var obtained = safeNumber(student[subject.key]);
    return { label: subject.label, obtained: obtained, max: 100, percentage: obtained, grade: gradeCalc(obtained) };
  });
  var legacyTotal = legacyRows.reduce(function (sum, row) { return sum + row.obtained; }, 0);
  return { rows: legacyRows, total: legacyTotal, maximum: 500, percentage: legacyTotal / 5, legacy: true };
}

function detail(label, value) {
  return "<div><dt>" + escapeHTML(label) + "</dt><dd>" + escapeHTML(value || "Not recorded") + "</dd></div>";
}

function buildRecordHTML(student) {
  var result = getResult(student);
  var rows = result.rows.map(function (row) {
    return "<tr>" +
      "<td>" + escapeHTML(row.label) + "</td>" +
      "<td>" + row.obtained + "</td>" +
      "<td>" + row.max + "</td>" +
      "<td>" + row.percentage.toFixed(1) + "%</td>" +
      "<td>" + row.grade + "</td>" +
      "</tr>";
  }).join("");

  return '' +
    '<article class="result-card">' +
      '<header class="result-letterhead">' +
        '<div class="result-school"><div class="brand-mark brand-mark-small" aria-hidden="true">PN</div>' +
          '<div><h3>PISK NOVA</h3><p>Student Management System • FBISE Academic Record</p></div></div>' +
        '<p class="result-session">Academic Session 2026–27</p>' +
      '</header>' +
      '<div class="result-title"><h3>Official Result Card</h3></div>' +
      '<div class="result-body">' +
        '<dl class="identity-grid">' +
          detail("Student name", student.name) +
          detail("Roll number", student.admission) +
          detail("Father's name", student.father) +
          detail("Class / section", student.class) +
          detail("FBISE registration", student.fbiseRegistrationNumber) +
          detail("Date of birth", formatDate(student.dateOfBirth)) +
          detail("B-Form / Iqama", student.studentGovernmentId) +
          detail("Father CNIC / Iqama", student.fatherGovernmentId) +
          detail("Class incharge", student.incharge) +
          detail("Father's email", student.fatherEmail) +
        '</dl>' +
        '<div class="table-wrap"><table class="marks-table">' +
          '<thead><tr><th>Subject</th><th>Obtained</th><th>Maximum</th><th>Percentage</th><th>Grade</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
          '<tfoot><tr><td>Overall</td><td>' + result.total + '</td><td>' + result.maximum + '</td><td>' + result.percentage.toFixed(2) + '%</td><td>' + gradeCalc(result.percentage) + '</td></tr></tfoot>' +
        '</table></div>' +
        '<div class="result-summary">' +
          '<div><span>Total marks</span><strong>' + result.total + ' / ' + result.maximum + '</strong></div>' +
          '<div><span>Percentage</span><strong>' + result.percentage.toFixed(2) + '%</strong></div>' +
          '<div><span>Overall grade</span><strong>' + gradeCalc(result.percentage) + '</strong></div>' +
        '</div>' +
        (result.legacy ? '<p class="legacy-note">Legacy record: government identifiers and the original five-subject, 500-mark structure are retained as imported.</p>' : '') +
      '</div>' +
    '</article>';
}

function printStudent(student) {
  if (!student) {
    showToast("No student result is selected.", "error");
    return;
  }
  byId("print-area").innerHTML = buildRecordHTML(student);
  byId("print-area").setAttribute("aria-hidden", "false");
  window.print();
  byId("print-area").setAttribute("aria-hidden", "true");
}

// =========================== VALIDATION AND CREATION ===========================

function isGovernmentId(value) {
  return PAK_ID_REGEX.test(value) || IQAMA_REGEX.test(value);
}

function isValidDateOfBirth(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var date = new Date(value + "T00:00:00");
  if (Number.isNaN(date.getTime())) return false;
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function readMark(inputId, subjectName, maximum) {
  var value = safeNumber(byId(inputId).value);
  if (value < 0 || value > maximum) {
    showFieldError(inputId, subjectName + " must be between 0 and " + maximum + ".");
    return null;
  }
  clearFieldError(inputId);
  return value;
}

function validateStudentForm() {
  var requiredTextIds = ["sname", "sroll", "sclass", "incharge", "sfather"];
  var firstInvalid = null;
  var valid = true;

  requiredTextIds.forEach(function (id) {
    clearFieldError(id);
    if (!clean(byId(id).value)) {
      showFieldError(id, "This field is required.");
      firstInvalid = firstInvalid || byId(id);
      valid = false;
    }
  });

  var fbise = clean(byId("fbise-reg").value).toUpperCase();
  clearFieldError("fbise-reg");
  if (!FBISE_REG_REGEX.test(fbise)) {
    showFieldError("fbise-reg", "Use 6–16 digits or a valid grouped FBISE format.");
    firstInvalid = firstInvalid || byId("fbise-reg");
    valid = false;
  }

  ["student-id", "father-id"].forEach(function (id) {
    clearFieldError(id);
    if (!isGovernmentId(clean(byId(id).value))) {
      showFieldError(id, "Use 00000-0000000-0 for CNIC/B-Form or a valid 10-digit Iqama.");
      firstInvalid = firstInvalid || byId(id);
      valid = false;
    }
  });

  clearFieldError("dob");
  if (!isValidDateOfBirth(clean(byId("dob").value))) {
    showFieldError("dob", "Enter a valid date earlier than today.");
    firstInvalid = firstInvalid || byId("dob");
    valid = false;
  }

  var email = clean(byId("femail").value);
  clearFieldError("femail");
  if (email && !EMAIL_REGEX.test(email)) {
    showFieldError("femail", "Enter a valid email address.");
    firstInvalid = firstInvalid || byId("femail");
    valid = false;
  }

  var marks = {
    chemistry: readMark("chem", "Chemistry", 75),
    computerBiology: readMark("compbio", "Computer / Biology", 75),
    physics: readMark("phys", "Physics", 75),
    math: readMark("math", "Mathematics", 75),
    english: readMark("eng", "English", 75),
    urdu: readMark("urdu", "Urdu", 75),
    islamiyat: readMark("isl", "Islamiyat", 100),
    tarjumaQuran: readMark("tar", "Tarjuma-tul-Quran", 50)
  };
  Object.keys(marks).forEach(function (key) {
    if (marks[key] === null) valid = false;
  });

  if (!valid && firstInvalid) firstInvalid.focus();
  return valid ? marks : null;
}

async function saveStudent(event) {
  event.preventDefault();
  var marks = validateStudentForm();
  if (!marks) {
    showToast("Please correct the highlighted fields before saving.", "error");
    return;
  }

  var student = Object.assign({
    schemaVersion: SCHEMA_VERSION,
    admission: clean(byId("sroll").value),
    name: clean(byId("sname").value),
    father: clean(byId("sfather").value),
    fatherEmail: clean(byId("femail").value) || "N/A",
    class: clean(byId("sclass").value),
    incharge: clean(byId("incharge").value),
    fbiseRegistrationNumber: clean(byId("fbise-reg").value).toUpperCase(),
    studentGovernmentId: clean(byId("student-id").value),
    fatherGovernmentId: clean(byId("father-id").value),
    dateOfBirth: clean(byId("dob").value),
    updatedAt: new Date().toISOString()
  }, marks);

  var localStudents = getLocalStudents();
  var duplicateIndex = localStudents.findIndex(function (item) {
    return clean(item.admission).toLowerCase() === student.admission.toLowerCase();
  });

  // Ask before replacing a local record with the same roll number.
  if (duplicateIndex >= 0) {
    if (!window.confirm("A local record already uses roll number " + student.admission + ". Replace it?")) return;
    localStudents[duplicateIndex] = student;
  } else {
    localStudents.push(student);
  }

  saveLocalStudents(localStudents);
  currentStudent = student;
  byId("saved-preview-content").innerHTML = buildRecordHTML(student);
  byId("saved-preview").classList.remove("hidden");
  byId("saved-preview").scrollIntoView({ behavior: "smooth", block: "start" });
  await refreshAdminData();
  showToast(student.name + "'s result was saved successfully.", "success");
}

// ========================== ADMIN METRICS AND SEARCH ===========================

async function refreshAdminData() {
  var students = await loadAllStudents();
  var localCount = getLocalStudents().length;
  var best = null;

  students.forEach(function (student) {
    var percentage = getResult(student).percentage;
    if (!best || percentage > best.percentage) best = { student: student, percentage: percentage };
  });

  byId("metric-total").textContent = students.length;
  byId("metric-local").textContent = localCount;
  byId("metric-highest").textContent = best ? best.percentage.toFixed(2) + "%" : "0%";
  byId("metric-top-student").textContent = best ? best.student.name + " • " + best.student.admission : "No records available";
  renderSearchResults(byId("admin-search").value);
}

function renderSearchResults(query) {
  var term = clean(query).toLowerCase();
  var filtered = allStudentsCache.filter(function (student) {
    var searchable = [
      student.admission,
      student.name,
      student.father,
      student.class,
      student.fbiseRegistrationNumber
    ].join(" ").toLowerCase();
    return !term || searchable.includes(term);
  }).slice(0, 50);

  byId("search-count").textContent = filtered.length + (filtered.length === 1 ? " record" : " records");

  if (!filtered.length) {
    byId("search-results").innerHTML = '<div class="empty-state">No matching student records were found.</div>';
    return;
  }

  byId("search-results").innerHTML = filtered.map(function (student) {
    return '<article class="record-row">' +
      '<strong title="' + escapeHTML(student.name) + '">' + escapeHTML(student.name) + '</strong>' +
      '<span title="' + escapeHTML(student.admission) + '">Roll ' + escapeHTML(student.admission) + '</span>' +
      '<span title="' + escapeHTML(student.class) + '">' + escapeHTML(student.class || "No class") + '</span>' +
      '<span title="' + escapeHTML(student.father) + '">' + escapeHTML(student.father) + '</span>' +
      '<button class="button button-secondary view-record" type="button" data-roll="' + escapeHTML(student.admission) + '">View</button>' +
    '</article>';
  }).join("");
}

function openSearchRecord(rollNumber) {
  var student = allStudentsCache.find(function (item) { return item.admission === rollNumber; });
  if (!student) return;
  currentStudent = student;
  byId("saved-preview-content").innerHTML = buildRecordHTML(student);
  byId("saved-preview").classList.remove("hidden");
  showAdminSection("add-student");
  byId("saved-preview").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ============================== BACKUP / RESTORE ===============================

function exportDatabase() {
  var students = getLocalStudents();
  var backup = {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    recordCount: students.length,
    students: students
  };
  var blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var link = document.createElement("a");
  var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  link.href = url;
  link.download = "pisk-nova-backup-" + stamp + ".json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(students.length + " local record(s) exported.", "success");
}

function readImportFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showToast("Import rejected: the JSON file exceeds 5 MB.", "error");
    event.target.value = "";
    return;
  }

  var reader = new FileReader();
  reader.onload = function () {
    try {
      var parsed = JSON.parse(reader.result);
      var students = Array.isArray(parsed) ? parsed : parsed.students;
      if (!Array.isArray(students)) throw new Error("Expected an array or a backup object with a students array.");

      for (var index = 0; index < students.length; index += 1) {
        var validationError = validateImportedRecord(students[index], index);
        if (validationError) throw new Error(validationError);
      }

      pendingImport = students.map(normalizeStudent);
      byId("import-summary").textContent = file.name + " contains " + pendingImport.length +
        " valid record(s). Merge keeps existing local records; replace removes them first.";
      byId("import-review").classList.remove("hidden");
    } catch (error) {
      pendingImport = null;
      byId("import-review").classList.add("hidden");
      showToast("Import rejected: " + error.message, "error");
    }
  };
  reader.onerror = function () { showToast("The selected file could not be read.", "error"); };
  reader.readAsText(file);
}

async function commitImport(mode) {
  if (!pendingImport) return;
  var imported = pendingImport.slice();

  if (mode === "merge") {
    var map = new Map();
    getLocalStudents().concat(imported).forEach(function (student) {
      map.set(clean(student.admission).toLowerCase(), student);
    });
    imported = Array.from(map.values());
  }

  saveLocalStudents(imported);
  pendingImport = null;
  byId("import-file").value = "";
  byId("import-review").classList.add("hidden");
  await refreshAdminData();
  showToast("Database " + (mode === "merge" ? "merged" : "replaced") + " successfully.", "success");
}

function cancelImport() {
  pendingImport = null;
  byId("import-file").value = "";
  byId("import-review").classList.add("hidden");
}

// =============================== EVENT WIRING ==================================

document.addEventListener("DOMContentLoaded", function () {
  byId("login-form").addEventListener("submit", smartLogin);
  byId("student-form").addEventListener("submit", saveStudent);

  byId("toggle-password").addEventListener("click", function () {
    var password = byId("login-pass");
    var show = password.type === "password";
    password.type = show ? "text" : "password";
    this.textContent = show ? "Hide" : "Show";
    this.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });

  document.querySelectorAll("[data-section], [data-go-to]").forEach(function (button) {
    button.addEventListener("click", function () {
      showAdminSection(button.dataset.section || button.dataset.goTo);
    });
  });

  byId("admin-logout").addEventListener("click", logout);
  byId("mobile-logout").addEventListener("click", logout);
  byId("student-logout").addEventListener("click", logout);
  byId("menu-toggle").addEventListener("click", openMobileMenu);
  byId("sidebar-scrim").addEventListener("click", closeMobileMenu);

  byId("admin-search").addEventListener("input", debounce(function (event) {
    renderSearchResults(event.target.value);
  }, 250));

  byId("search-results").addEventListener("click", function (event) {
    var button = event.target.closest(".view-record");
    if (button) openSearchRecord(button.dataset.roll);
  });

  byId("print-student-result").addEventListener("click", function () { printStudent(currentStudent); });
  byId("print-preview").addEventListener("click", function () { printStudent(currentStudent); });
  byId("export-database").addEventListener("click", exportDatabase);
  byId("import-file").addEventListener("change", readImportFile);
  byId("cancel-import").addEventListener("click", cancelImport);
  byId("merge-import").addEventListener("click", function () { commitImport("merge"); });
  byId("replace-import").addEventListener("click", function () {
    if (window.confirm("Replace every local record with the imported file? This cannot be undone unless you have a backup.")) {
      commitImport("replace");
    }
  });

  // Remove a validation message as soon as the user starts correcting the field.
  document.querySelectorAll("#student-form input").forEach(function (input) {
    input.addEventListener("input", function () { clearFieldError(input.id); });
  });

  byId("student-form").addEventListener("reset", function () {
    window.setTimeout(function () {
      document.querySelectorAll("#student-form input").forEach(function (input) { clearFieldError(input.id); });
      byId("saved-preview").classList.add("hidden");
    }, 0);
  });

  // Date input cannot select today or a future day.
  var yesterday = new Date(Date.now() - 86400000);
  byId("dob").max = yesterday.toISOString().slice(0, 10);
});