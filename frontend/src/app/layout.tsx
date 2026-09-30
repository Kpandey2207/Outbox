import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Outbox", template: "%s · Outbox" },
  description: "Schedule and track outbound email",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets fixed bars use env(safe-area-inset-*) on notched phones.
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
