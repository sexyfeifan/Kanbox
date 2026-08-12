import type { Metadata } from "next";
import "./globals.css";
import { AppProvider } from "./lib/store";

export const metadata: Metadata = {
  title: "Kanbox",
  description: "Xiaohongshu note collector",
  icons: { icon: '/icon.svg' },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <AppProvider>
          {children}
        </AppProvider>
      </body>
    </html>
  );
}
