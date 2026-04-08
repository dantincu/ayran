// SETUP REQUIRED: Replace the placeholder values below with your Firebase project config.
// Steps:
//   1. Go to https://console.firebase.google.com and create a project.
//   2. Enable Google Sign-In under Authentication > Sign-in method.
//   3. Add a Web App under Project Settings > Your apps.
//   4. Copy the firebaseConfig object here.
//   5. Add Firestore rules to allow authenticated users to read/write their own data:
//        match /users/{userId}/{document=**} { allow read, write: if request.auth.uid == userId; }

import { initializeApp, getApps } from 'firebase/app';
import { initializeAuth, getReactNativePersistence } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';

const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

export const db = getFirestore(app);
