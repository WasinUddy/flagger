import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteUrl = (
  process.env.NEXT_PUBLIC_SITE_URL ??
  "https://wasinuddy.github.io/flagger"
).replace(/\/$/, "");
const title = "Flagger — FLAC + Tagger for Vinyl Rips";
const description =
  "Match vinyl rips to Discogs metadata, embed your own cover, and export DAP-ready FLAC files entirely in your browser.";
const socialImage = `${siteUrl}/og.png`;

export const metadata: Metadata = {
  metadataBase: new URL(`${siteUrl}/`),
  title,
  description,
  alternates: { canonical: siteUrl },
  openGraph: {
    url: siteUrl,
    title,
    description,
    type: "website",
    images: [{ url: socialImage, width: 1730, height: 907, alt: "Flagger — files stay local" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [socialImage],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
