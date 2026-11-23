import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright and its browser driver must stay outside the bundle and run in Node.
  serverExternalPackages: ["playwright", "playwright-core"],
};

export default nextConfig;
