// SETUP REQUIRED: Replace the placeholder values below with your Firebase project config.
// Same values as config.native.ts — Firebase uses localStorage for persistence automatically on web.

import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDgna8iG_U20yI0Blyv8uHiZIQZjDYoNV8",
  authDomain: "ayran-2f380.firebaseapp.com",
  projectId: "ayran-2f380",
  storageBucket: "ayran-2f380.firebasestorage.app",
  messagingSenderId: "880607612119",
  appId: "1:880607612119:web:20dee6fd9da6275fbc3492",
  measurementId: "G-EMGQ0XR87W",
};

const app =
  getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// On web, getAuth() defaults to localStorage persistence — no extra setup needed.
export const auth = getAuth(app);

export const db = getFirestore(app);
