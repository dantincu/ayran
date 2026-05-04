import { NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/google-auth';

export async function GET() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.redirect(
      new URL('/?error=missing_env', process.env.NEXTAUTH_URL ?? 'http://localhost:3000')
    );
  }
  return NextResponse.redirect(getAuthUrl());
}
