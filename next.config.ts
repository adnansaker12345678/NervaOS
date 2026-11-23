import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "**.run.app",
    "**.cloud.goog",
    "**.googleusercontent.com",
    "**.aistudio.google.com",
    "aistudio.google.com",
  ],
  // Playwright and its browser driver must stay outside the bundle and run in Node.
  serverExternalPackages: ["playwright", "playwright-core"],
};

export default nextConfig;
