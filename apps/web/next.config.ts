import type { NextConfig } from "next";

const config: NextConfig = {
  // @ao-wrapped/shared ships TypeScript source rather than a build step.
  transpilePackages: ["@ao-wrapped/shared"],
};

export default config;
