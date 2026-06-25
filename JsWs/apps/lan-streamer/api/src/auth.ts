import { randomBytes } from "node:crypto";
import { FilenSDK } from "@filen/sdk";
import type { NextFunction, Request, Response } from "express";
import { createSession, deleteSession, getSession } from "./store.js";
import type { FilenAccount } from "./types.js";

export async function loginWithFilen(email: string, password: string, twoFactorCode?: string): Promise<FilenAccount> {
  const sdk = new FilenSDK({
    metadataCache: true,
    connectToSocket: false,
  });

  await sdk.login({ email, password, twoFactorCode });

  if (!sdk.config.userId || !sdk.config.email) {
    throw new Error("Filen login did not return an account identity");
  }

  return { userId: sdk.config.userId, email: sdk.config.email };
}

export function issueSession(account: FilenAccount): string {
  const token = randomBytes(32).toString("hex");
  createSession({ token, account, createdAt: Date.now() });
  return token;
}

export function endSession(token: string): void {
  deleteSession(token);
}

export interface AuthedRequest extends Request {
  account?: FilenAccount;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const session = token ? getSession(token) : undefined;

  if (!session) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  req.account = session.account;
  next();
}

export function accountForToken(token: string | undefined): FilenAccount | undefined {
  if (!token) return undefined;
  return getSession(token)?.account;
}
