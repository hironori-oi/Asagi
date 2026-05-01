/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
  trailingSlash: true,
  assetPrefix: '',
  // Tauri は assets を file:// で読むため、export 形式を採用
};

export default nextConfig;
