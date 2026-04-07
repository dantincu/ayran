import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_TOKEN_KEY = 'google_drive_tokens';
const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export class GoogleDriveAuth {
  private clientId: string;
  private scopes: string[];

  constructor(clientId: string) {
    this.clientId = clientId;
    this.scopes = ['https://www.googleapis.com/auth/drive'];
  }

  async authenticate(): Promise<GoogleTokens> {
    const redirectUri = AuthSession.makeRedirectUri({ scheme: 'ayran-notes' });
    const request = new AuthSession.AuthRequest({
      clientId: this.clientId,
      scopes: this.scopes,
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      extraParams: { access_type: 'offline', prompt: 'consent' },
    });
    const result = await request.promptAsync(DISCOVERY);
    if (result.type !== 'success') {
      throw new Error('Google Drive authentication failed or was cancelled');
    }

    const code = result.params.code;
    const tokens = await this.exchangeCode(code, redirectUri, request.codeVerifier);
    await this.saveTokens(tokens);
    return tokens;
  }

  private async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<GoogleTokens> {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    });

    const response = await fetch(DISCOVERY.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.clientId,
      grant_type: 'refresh_token',
    });

    const response = await fetch(DISCOVERY.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await response.json();
    const tokens: GoogleTokens = {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    await this.saveTokens(tokens);
    return tokens;
  }

  async getSavedTokens(): Promise<GoogleTokens | null> {
    const raw = await SecureStore.getItemAsync(GOOGLE_TOKEN_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as GoogleTokens;
  }

  async saveTokens(tokens: GoogleTokens): Promise<void> {
    await SecureStore.setItemAsync(GOOGLE_TOKEN_KEY, JSON.stringify(tokens));
  }

  async clearTokens(): Promise<void> {
    await SecureStore.deleteItemAsync(GOOGLE_TOKEN_KEY);
  }
}
