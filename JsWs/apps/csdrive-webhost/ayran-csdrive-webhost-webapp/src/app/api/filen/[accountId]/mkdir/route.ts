import { NextRequest, NextResponse } from 'next/server';
import { getFilenSDK } from '@/lib/filen-client';

type RouteContext = { params: Promise<{ accountId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const { accountId } = await context.params;
  const sdk = await getFilenSDK(accountId);
  if (!sdk) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const { name, parent } = await request.json();
  try {
    const uuid = await sdk.cloud().createDirectory({ name, parent });
    return NextResponse.json({ uuid });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create directory';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
