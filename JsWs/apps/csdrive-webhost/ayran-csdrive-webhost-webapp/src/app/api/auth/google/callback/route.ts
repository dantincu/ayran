import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode } from '@/lib/google-auth';
import { upsertAccount } from '@/lib/token-store';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.redirect(`${origin}/?error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return NextResponse.redirect(`${origin}/?error=missing_code`);
  }

  try {
    const data = await exchangeCode(code);
    await upsertAccount({
      id: data.id,
      email: data.email,
      displayName: data.displayName,
      provider: 'google-drive',
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: data.expiresAt,
      scope: 'https://www.googleapis.com/auth/drive',
    });
    return NextResponse.redirect(`${origin}/?connected=1`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    return NextResponse.redirect(`${origin}/?error=auth_failed`);
  }
}
