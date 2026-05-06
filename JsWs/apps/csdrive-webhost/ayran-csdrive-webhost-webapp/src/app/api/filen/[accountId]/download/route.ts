import { NextRequest, NextResponse } from 'next/server';
import { getFilenSDK } from '@/lib/filen-client';
import type { FileEncryptionVersion } from '@filen/sdk';

type RouteContext = { params: Promise<{ accountId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const { accountId } = await context.params;
  const sdk = await getFilenSDK(accountId);
  if (!sdk) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const { uuid, bucket, region, chunks, version, key, size, mime, name } = await request.json();

  try {
    const stream = sdk.cloud().downloadFileToReadableStream({
      uuid,
      bucket,
      region,
      chunks,
      version: version as FileEncryptionVersion,
      key,
      size,
    });

    const safeName = encodeURIComponent(name ?? 'download');
    return new Response(stream as unknown as ReadableStream, {
      headers: {
        'Content-Type': mime || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${safeName}`,
        'Content-Length': String(size),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Download failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
