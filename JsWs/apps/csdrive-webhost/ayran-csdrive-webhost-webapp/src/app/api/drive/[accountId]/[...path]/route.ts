import { NextRequest, NextResponse } from 'next/server';
import { getAccount, upsertAccount } from '@/lib/token-store';
import { refreshAccessToken } from '@/lib/google-auth';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

type RouteContext = { params: Promise<{ accountId: string; path: string[] }> };

const HEADERS_TO_FORWARD = [
  'Content-Type',
  'Content-Range',
  'X-Upload-Content-Type',
  'X-Upload-Content-Length',
  'Range',
];

const RESPONSE_HEADERS_TO_FORWARD = [
  'Content-Type',
  'Content-Disposition',
  'Content-Length',
  'Content-Range',
  'Location',
];

async function getValidAccessToken(accountId: string): Promise<string | null> {
  const account = await getAccount(accountId);
  if (!account) return null;

  const isExpired = account.expiresAt && account.expiresAt - 60_000 < Date.now();
  if (!isExpired) return account.accessToken;

  if (!account.refreshToken) return account.accessToken;

  try {
    const refreshed = await refreshAccessToken(account.refreshToken);
    await upsertAccount({ ...account, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt });
    return refreshed.accessToken;
  } catch {
    return null;
  }
}

async function proxyRequest(request: NextRequest, accountId: string, pathSegments: string[], method: string): Promise<Response> {
  const accessToken = await getValidAccessToken(accountId);
  if (!accessToken) {
    return NextResponse.json({ error: 'Account not found or token expired' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  // paths starting with "upload" go to the upload base URL
  const isUpload = pathSegments[0] === 'upload';
  const apiPath = isUpload ? pathSegments.slice(1).join('/') : pathSegments.join('/');
  const base = isUpload ? DRIVE_UPLOAD_BASE : DRIVE_API_BASE;
  const qs = searchParams.toString();
  const targetUrl = `${base}/${apiPath}${qs ? `?${qs}` : ''}`;

  const forwardHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };
  for (const header of HEADERS_TO_FORWARD) {
    const value = request.headers.get(header);
    if (value) forwardHeaders[header] = value;
  }

  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);

  const upstream = await fetch(targetUrl, {
    method,
    headers: forwardHeaders,
    body: hasBody ? await request.arrayBuffer() : undefined,
  });

  const responseHeaders: Record<string, string> = {};
  for (const header of RESPONSE_HEADERS_TO_FORWARD) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders[header] = value;
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { accountId, path } = await context.params;
  return proxyRequest(request, accountId, path, 'GET');
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { accountId, path } = await context.params;
  return proxyRequest(request, accountId, path, 'POST');
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { accountId, path } = await context.params;
  return proxyRequest(request, accountId, path, 'PUT');
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { accountId, path } = await context.params;
  return proxyRequest(request, accountId, path, 'PATCH');
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { accountId, path } = await context.params;
  return proxyRequest(request, accountId, path, 'DELETE');
}
