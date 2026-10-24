
import { initializeApp, getApps, deleteApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC60SAw4E1ukRDBWbcoQHSuTvUuTaJwIfM",
  authDomain: "campushub-f5eb5.firebaseapp.com",
  databaseURL: "https://campushub-f5eb5-default-rtdb.firebaseio.com",
  projectId: "campushub-f5eb5",
  storageBucket: "campushub-f5eb5.firebasestorage.app",
  messagingSenderId: "671410112910",
  appId: "1:671410112910:web:8991caa04800878f01bcdf",
  measurementId: "G-PTCEBYX215",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);


export async function withSecondaryAuth(fn) {
  const name = "secondary-" + Date.now();
  const secondaryApp = initializeApp(firebaseConfig, name);
  const secondaryAuth = getAuth(secondaryApp);
  try {
    return await fn(secondaryAuth);
  } finally {
    await deleteApp(secondaryApp);
  }
}
