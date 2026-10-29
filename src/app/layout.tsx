import type { Metadata } from "next";
import "./globals.css";
import LanguageProvider from "@/components/LanguageProvider";
import ReferralTracker from "@/components/ReferralTracker";

export const metadata: Metadata = {
  metadataBase: new URL("https://app.pbmreserves.xyz"),
  title: "PBMReserves",
  description: "PBMReserves — on-chain reserves and transparent Web3 infrastructure.",
  applicationName: "PBMReserves",
  alternates: { canonical: "https://app.pbmreserves.xyz" },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32", type: "image/x-icon" },
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    shortcut: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/manifest.json",
  openGraph: {
    title: "PBMReserves",
    description: "On-chain reserves and transparent Web3 infrastructure.",
    url: "https://app.pbmreserves.xyz",
    siteName: "PBMReserves",
    type: "website",
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "PBMReserves logo" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "PBMReserves",
    description: "On-chain reserves and transparent Web3 infrastructure.",
    images: ["/icon-512.png"],
  },
  appleWebApp: {
    capable: true,
    title: "PBMReserves",
    statusBarStyle: "black-translucent",
  },
};

export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="en"><body><LanguageProvider><ReferralTracker/>{children}</LanguageProvider></body></html>
}
