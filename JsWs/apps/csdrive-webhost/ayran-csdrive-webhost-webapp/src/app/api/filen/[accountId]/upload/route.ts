import { NextRequest, NextResponse } from 'next/server';
import { getFilenSDK } from '@/lib/filen-client';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

type RouteContext = { params: Promise<{ accountId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const { accountId } = await context.params;
  const sdk = await getFilenSDK(accountId);
  if (!sdk) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const parent =
    new URL(request.url).searchParams.get('parent') ?? sdk.config.baseFolderUUID ?? '';

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

  const tmpPath = path.join(os.tmpdir(), `filen-up-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(tmpPath, Buffer.from(await file.arrayBuffer()));
    const item = await sdk.cloud().uploadLocalFile({ source: tmpPath, parent, name: file.name });
    return NextResponse.json(item);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}
