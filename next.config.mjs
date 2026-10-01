/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["sharp", "node:sqlite", "undici"]
};

export default nextConfig;
