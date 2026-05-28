/** @type {import('next').NextConfig} */
const nextConfig = {
  // Renamed from experimental.serverComponentsExternalPackages in Next 15.
  serverExternalPackages: ["@modelcontextprotocol/sdk"],
};

export default nextConfig;
