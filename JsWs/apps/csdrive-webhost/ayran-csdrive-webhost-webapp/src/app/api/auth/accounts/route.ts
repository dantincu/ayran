import { NextResponse } from 'next/server';
import { listAccounts } from '@/lib/token-store';

export async function GET() {
  const accounts = await listAccounts();
  return NextResponse.json(
    accounts.map(({ id, email, displayName, provider }) => ({ id, email, displayName, provider }))
  );
}
