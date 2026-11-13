import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = { title: "OI Sniper", description: "Local-first crypto futures bot panel" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
