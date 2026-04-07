import { Redirect } from 'expo-router';
import { useSessionStore } from '../src/store/session.store';

/**
 * Root entry point — redirects based on app state:
 *  1. Legal not accepted → onboarding/legal
 *  2. No session → onboarding/storage-setup
 *  3. Otherwise → (session) (root notes explorer)
 */
export default function Index() {
  const legalAccepted = useSessionStore((s) => s.legalAccepted);
  const session = useSessionStore((s) => s.getCurrentSession());

  if (!legalAccepted) {
    return <Redirect href="/onboarding/legal" />;
  }
  if (!session) {
    return <Redirect href="/onboarding/storage-setup" />;
  }
  return <Redirect href="/(session)" />;
}
