/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    "@ffmpeg-installer/ffmpeg",
    "@ffmpeg-installer/linux-x64",
    "@distube/ytdl-core",
    "youtubei.js",
  ],
  outputFileTracingIncludes: {
    "/api/v1/jobs": ["./node_modules/@ffmpeg-installer/**/*"],
    "/api/v1/batch": ["./node_modules/@ffmpeg-installer/**/*"],
    "/api/v1/jobs/[id]": ["./node_modules/@ffmpeg-installer/**/*"],
    "/api/v1/jobs/[id]/download": ["./node_modules/@ffmpeg-installer/**/*"],
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
