import Link from "next/link";
import "./globals.css";

export const metadata = {
  title: "Contact console",
  description: "The Next.js fixture UIProof builds, measures and repairs inside a container.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav aria-label="Sections">
            <Link href="/">Contact</Link>
            <Link href="/ledger">Ledger</Link>
            <Link href="/settings">Settings</Link>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
