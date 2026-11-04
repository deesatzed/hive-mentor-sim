import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mentor Hive",
  description: "A local simulation of one mind built from a swarm of mentor-grounded Voices.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <span className="brand">Mentor Hive</span>
          <span className="sim-label" data-testid="sim-label">
            Simulation
          </span>
        </header>
        {children}
      </body>
    </html>
  );
}
