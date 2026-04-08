// SETUP REQUIRED: Replace the placeholder values below with your Firebase project config.
// Steps:
//   1. Go to https://console.firebase.google.com and create a project.
//   2. Enable Google Sign-In under Authentication > Sign-in method.
//   3. Add a Web App under Project Settings > Your apps.
//   4. Copy the firebaseConfig object here.
//   5. Add Firestore rules to allow authenticated users to read/write their own data:
//        match /users/{userId}/{document=**} { allow read, write: if request.auth.uid == userId; }

import { initializeApp, getApps } from "firebase/app";
import { initializeAuth, getReactNativePersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import AsyncStorage from "@react-native-async-storage/async-storage";

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

export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

export const db = getFirestore(app);
