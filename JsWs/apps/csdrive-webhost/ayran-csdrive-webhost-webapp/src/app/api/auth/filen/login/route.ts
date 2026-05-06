import { NextRequest, NextResponse } from 'next/server';
import { loginFilen } from '@/lib/filen-client';

export async function POST(request: NextRequest) {
  const { email, password, twoFactorCode } = await request.json();

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
  }

  try {
    const result = await loginFilen(email, password, twoFactorCode || undefined);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Login failed';
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
