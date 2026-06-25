import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import selfsigned from "selfsigned";
import { networkInterfaces, hostname } from "node:os";

function localAddresses(): string[] {
  const addresses: string[] = ["localhost", "127.0.0.1", hostname()];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4") addresses.push(iface.address);
    }
  }
  return addresses;
}

export async function ensureDevCertificate(certDir: string): Promise<{ keyPath: string; certPath: string }> {
  const keyPath = path.join(certDir, "dev-key.pem");
  const certPath = path.join(certDir, "dev-cert.pem");

  if (existsSync(keyPath) && existsSync(certPath)) {
    return { keyPath, certPath };
  }

  const altNames = localAddresses().map((value) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(value)
      ? { type: 7 as const, ip: value }
      : { type: 2 as const, value },
  );

  const pems = await selfsigned.generate(undefined, {
    notAfterDate: new Date(Date.now() + 825 * 24 * 60 * 60 * 1000),
    keySize: 2048,
    extensions: [{ name: "subjectAltName", altNames }],
  });

  writeFileSync(keyPath, pems.private);
  writeFileSync(certPath, pems.cert);

  return { keyPath, certPath };
}
