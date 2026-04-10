import { useState } from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { auth } from '../firebase/config';

export default function GoogleSignInButton() {
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setError(null);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      setError(err.message ?? 'Sign-in failed');
    }
  }

  return (
    <>
      <TouchableOpacity style={styles.button} onPress={handleSignIn} activeOpacity={0.85}>
        <Text style={styles.text}>Sign in with Google</Text>
      </TouchableOpacity>
      {error && <Text style={styles.error}>{error}</Text>}
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#4285F4',
    paddingHorizontal: 36,
    paddingVertical: 14,
    borderRadius: 10,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  text: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  error: {
    marginTop: 16,
    color: '#E53935',
    fontSize: 14,
  },
});
