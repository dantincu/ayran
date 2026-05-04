import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function getRedirectUri(): string {
  return `${process.env.NEXTAUTH_URL ?? 'http://localhost:3000'}/api/auth/google/callback`;
}

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
}

export function getAuthUrl(): string {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent select_account',
  });
}

export async function exchangeCode(code: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  email: string;
  displayName?: string;
  id: string;
}> {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();

  return {
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token ?? undefined,
    expiresAt: tokens.expiry_date ?? undefined,
    email: data.email!,
    displayName: data.name ?? undefined,
    id: data.id!,
  };
}

export async function refreshAccessToken(storedRefreshToken: string): Promise<{
  accessToken: string;
  expiresAt?: number;
}> {
  const client = createOAuth2Client();
  client.setCredentials({ refresh_token: storedRefreshToken });
  const { credentials } = await client.refreshAccessToken();
  return {
    accessToken: credentials.access_token!,
    expiresAt: credentials.expiry_date ?? undefined,
  };
}
