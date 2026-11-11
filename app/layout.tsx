import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MediaSphere — Extract, Trim, Transcribe",
  description: "All-in-one media extraction platform for YouTube, TikTok, Instagram, X and more.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-ink text-slate-200 antialiased">{children}</body>
    </html>
  );
}
