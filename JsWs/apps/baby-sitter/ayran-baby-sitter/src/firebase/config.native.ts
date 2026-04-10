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
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

const app =
  getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

export const db = getFirestore(app);
