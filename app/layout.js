import "./globals.css";

export const metadata = {
  title: "De-Autoresearch",
  description: "Community-driven autoresearch dashboard"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

