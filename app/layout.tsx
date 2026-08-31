import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@shell/providers";
import { APP_NAME, APP_SHORT_NAME } from "@/shared/lib/app-version";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Premium cloud storage — fast, secure, and elegant",
  applicationName: APP_NAME,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: APP_SHORT_NAME,
    statusBarStyle: "black-translucent",
  },
  // Notes/pages sometimes contain numbers that iOS would auto-link as phone
  // numbers inside the "app" — turn that off for a cleaner native feel.
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draw into the notch / safe areas so the app can go edge-to-edge.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f9fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d14" },
  ],
};

// Resolves lite mode before first paint so a low-end device never renders the
// expensive chrome once and then drops it. Mirrors @/shared/lib/system/lite-mode.ts —
// keep the two in sync.
const LITE_MODE_BOOT = `(function(){try{
var p=localStorage.getItem('lite_mode');
var on=p==='on';
if(!on&&p!=='off'){
var c=navigator.connection||{};
var m=navigator.deviceMemory,k=navigator.hardwareConcurrency;
on=!!c.saveData
||['slow-2g','2g','3g'].indexOf(c.effectiveType)>-1
||(typeof m==='number'&&m<=2)
||(typeof m==='number'&&m<=4&&typeof k==='number'&&k<=4);
}
if(on)document.documentElement.classList.add('lite');
}catch(e){}})();`;

/**
 * Applies the stored locale to <html> before the first paint, so the CJK font
 * stack and the `lang` attribute are correct from the first frame even though
 * the text is still English until hydration finishes.
 *
 * The locale list is duplicated as literals because this runs before any
 * module is loaded. It is validated against @/shared/lib/i18n/config.ts by check:i18n.
 */
const LOCALE_BOOT = `(function(){try{
var m=/(?:^|; *)locale=([^;]*)/.exec(document.cookie);
var v=m?decodeURIComponent(m[1]):'';
if(v==='en'||v==='id'||v==='zh-CN'){
var r=document.documentElement;r.lang=v;r.setAttribute('data-locale',v);}
}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: LITE_MODE_BOOT }} />
        <script dangerouslySetInnerHTML={{ __html: LOCALE_BOOT }} />
      </head>
      <body className="min-h-full antialiased" suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
