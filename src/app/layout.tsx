import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PlanBrief",
  description: "Upload an RFP, RFQ or plan set. Get a narrated video that walks through every page, top down, with on-drawing highlights.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <nav className="nav">
            <a className="brand" href="/">
              <span className="dot" /> PlanBrief <small>· document to video</small>
            </a>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
