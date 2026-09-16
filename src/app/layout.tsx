import type { Metadata } from "next";
import "./globals.css";
import { LocalSessionGate } from "@/components/LocalSessionGate";
import { Toast } from "@/components/Toast";

export const metadata: Metadata = {
  title: "Node Banana - AI Image Workflow",
  description: "Node-based image annotation and generation workflow using Nano Banana Pro",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <LocalSessionGate />
        {children}
        <Toast />
      </body>
    </html>
  );
}
