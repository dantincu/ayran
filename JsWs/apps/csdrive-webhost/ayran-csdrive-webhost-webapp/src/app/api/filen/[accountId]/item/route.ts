import { NextRequest, NextResponse } from 'next/server';
import { getFilenSDK } from '@/lib/filen-client';

type RouteContext = { params: Promise<{ accountId: string }> };

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { accountId } = await context.params;
  const sdk = await getFilenSDK(accountId);
  if (!sdk) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const uuid = searchParams.get('uuid');
  const type = searchParams.get('type');
  if (!uuid) return NextResponse.json({ error: 'Missing uuid' }, { status: 400 });

  try {
    if (type === 'directory') {
      await sdk.cloud().trashDirectory({ uuid });
    } else {
      await sdk.cloud().trashFile({ uuid });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
