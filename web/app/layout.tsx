import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Suspense } from "react";
import { HealthGate } from "@/components/health";
import { Header } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "MOSAIC Atlas",
  description: "Study populations of AI agents from the inside.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <HealthGate>
          <div className="flex min-h-screen flex-col">
            <Header />
            <Suspense fallback={<p className="note p-6">Loading.</p>}>{children}</Suspense>
          </div>
        </HealthGate>
      </body>
    </html>
  );
}
