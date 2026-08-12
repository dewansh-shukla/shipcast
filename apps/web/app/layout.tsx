import type { ReactNode } from "react";

export const metadata = {
  title: "AO Wrapped",
  description: "What your AI coding workforce actually accomplished.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
