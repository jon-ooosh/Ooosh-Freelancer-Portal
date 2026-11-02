/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable React strict mode for better development experience
  reactStrictMode: true,
  
  // Disable x-powered-by header for security
  poweredByHeader: false,
  
  // Configure allowed image domains if needed later
  images: {
    domains: [],
    // Image optimisation OFF (Nov 2026): Next 14's optimiser has open critical
    // advisories (remote code execution via crafted SVG / AVIF images) that are
    // only fixed in Next 15. The portal's only optimised image is the 64px logo,
    // so serving it as-is costs nothing. Revisit after the Next 15 upgrade.
    unoptimized: true,
  },
}

module.exports = nextConfig
