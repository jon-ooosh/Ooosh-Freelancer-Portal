/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable React strict mode for better development experience
  reactStrictMode: true,
  
  // Disable x-powered-by header for security
  poweredByHeader: false,
  
  // Configure allowed image domains if needed later
  images: {
    domains: [],
  },
}

module.exports = nextConfig
