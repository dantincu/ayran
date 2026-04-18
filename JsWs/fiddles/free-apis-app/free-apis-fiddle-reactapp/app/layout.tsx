import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Free APIs App",
  description: "Free APIs fiddle React app",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
