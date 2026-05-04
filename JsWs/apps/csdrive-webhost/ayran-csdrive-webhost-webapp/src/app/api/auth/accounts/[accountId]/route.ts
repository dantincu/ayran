import { NextRequest, NextResponse } from 'next/server';
import { deleteAccount } from '@/lib/token-store';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const { accountId } = await params;
  await deleteAccount(accountId);
  return NextResponse.json({ success: true });
}
