/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "i.pravatar.cc" },
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "pbs.twimg.com" },
      { protocol: "https", hostname: "scontent.cdninstagram.com" },
    ],
  },
  async rewrites() {
    const backendUrl = (
      process.env.API_PROXY_TARGET ||
      process.env.BACKEND_URL ||
      (!process.env.VERCEL ? "http://127.0.0.1:8000" : "")
    ).replace(/\/+$/, "");

    if (!backendUrl) {
      return [];
    }

    return {
      beforeFiles: [
        { source: "/api/v1/:path*", destination: `${backendUrl}/api/v1/:path*` },
        { source: "/ws/:path*", destination: `${backendUrl}/ws/:path*` },
      ],
    };
  },
};

module.exports = nextConfig;
