/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ["@napi-rs/canvas", "@anthropic-ai/sdk", "openai"],
  },
};

export default nextConfig;
