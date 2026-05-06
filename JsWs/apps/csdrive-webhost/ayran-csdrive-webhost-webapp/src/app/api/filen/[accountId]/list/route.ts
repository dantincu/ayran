import { NextRequest, NextResponse } from 'next/server';
import { getFilenSDK } from '@/lib/filen-client';

type RouteContext = { params: Promise<{ accountId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { accountId } = await context.params;
  const sdk = await getFilenSDK(accountId);
  if (!sdk) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const parent = new URL(request.url).searchParams.get('parent') ?? sdk.config.baseFolderUUID ?? '';
  try {
    const items = await sdk.cloud().listDirectory({ uuid: parent });
    return NextResponse.json({ items, root: sdk.config.baseFolderUUID });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list directory';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
