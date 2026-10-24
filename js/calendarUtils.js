import { auth, db, withSecondaryAuth } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  doc,
  setDoc,
  getDoc,
  addDoc,
  collection,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";


export async function signUp(name, email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await setDoc(doc(db, "users", cred.user.uid), {
    name,
    email,
    role: "student",
    disabled: false,
    createdAt: serverTimestamp(),
  });
  return cred.user;
}

/** Logs in, blocks disabled accounts, and records a login event. */
export async function logIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const profile = await getDoc(doc(db, "users", cred.user.uid));

  if (profile.exists() && profile.data().disabled) {
    await signOut(auth);
    const err = new Error("This account has been disabled.");
    err.code = "auth/account-disabled";
    throw err;
  }

  await logLoginEvent(cred.user.uid);
  return cred.user;
}

export async function logOut() {
  await signOut(auth);
}

/** Writes a login-history entry and bumps lastLoginAt on the profile. */
async function logLoginEvent(uid) {
  await addDoc(collection(db, "users", uid, "loginEvents"), {
    at: serverTimestamp(),
    userAgent: navigator.userAgent,
  });
  await setDoc(doc(db, "users", uid), { lastLoginAt: serverTimestamp() }, { merge: true });
}

export async function getUserRole(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  return snap.data().role || "student";
}


export async function createUserAsAdmin(name, email, password, role) {
  return withSecondaryAuth(async (secondaryAuth) => {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await setDoc(doc(db, "users", cred.user.uid), {
      name,
      email,
      role,
      disabled: false,
      createdAt: serverTimestamp(),
    });
    await signOut(secondaryAuth);
    return cred.user.uid;
  });
}

/** Admin-only: emails the user a link to set a new password themselves. */
export async function sendResetEmail(email) {
  await sendPasswordResetEmail(auth, email);
}

/** Route guard for a dashboard page. */
export function guardPage({ allowedRoles, onReady }) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "index.html";
      return;
    }
    const role = await getUserRole(user.uid);
    if (!role || !allowedRoles.includes(role)) {
      window.location.href = roleHome(role);
      return;
    }
    onReady(user, role);
  });
}

/** Where a given role's dashboard lives — now three distinct destinations. */
export function roleHome(role) {
  if (role === "admin") return "admin.html";
  if (role === "lecturer") return "lecturer.html";
  return "student.html";
}
