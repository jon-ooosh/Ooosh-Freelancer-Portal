/** @type {import('tailwindcss').Config} */

// The portal's look (Oct 2026 refresh, docs/design/freelancer-portal-refresh/):
// DM Sans, plum accent, warm neutrals, matching the hire form and payment portal.
//
// `hf` holds the design's tokens by name: use these in new code.
//
// The stock families (gray, green, amber, red, blue) are RE-POINTED at the
// same palette below, so a stock class written later still lands on-palette.
// That means `gray-500` here is the design's warm "muted", not Tailwind's grey.
// (The old `ooosh` sky blue and the `purple` remap went once no page used them.)
const hf = {
  accent: '#A75390',
  'accent-pressed': '#8f4a7c',
  link: '#8c3f77',
  'link-hover': '#6e2f5d',
  tint: '#f6eaf2',
  'tint-text': '#7d3569',
  'tint-strong': '#5e2a50',
  ink: '#1d1a1c',
  body: '#3d373a',
  muted: '#6f6569',
  placeholder: '#9a9094',
  page: '#f6f4f2',
  inset: '#f8f6f4',
  track: '#f3f0ed',
  seg: '#ece8e4',
  card: '#ffffff',
  border: '#e8e3df',
  control: '#e3ddd8',
  divider: '#f0ece9',
  chevron: '#b9b0ab',
  dashed: '#cfc6c0',
  'toggle-off': '#d9d2cc',
  green: '#3f9b6b',
  'green-text': '#2a7049',
  'green-tint': '#e4f3ea',
  'green-strong': '#1f4f35',
  'amber-bg': '#fff8e6',
  'amber-border': '#f2dca6',
  'amber-text': '#8a5a10',
  'amber-tile': '#fff4dc',
  error: '#a2341f',
  disabled: '#cdbfc8',
}

// Job-kind tiles and labels (background / foreground).
const kind = {
  'backline-bg': '#f6eaf2', backline: '#8c3f77',
  'van-bg': '#e7eef4', van: '#2f5573',
  'crew-bg': '#e4f3ea', crew: '#2a7049',
  'studio-bg': '#ecebf6', studio: '#4b4790',
  'yard-bg': '#f3f0ed', yard: '#3d373a',
}

module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        hf,
        kind,
        gray: {
          50: '#f8f6f4', 100: '#f3f0ed', 200: '#e8e3df', 300: '#d9d2cc', 400: '#9a9094',
          500: '#6f6569', 600: '#574f53', 700: '#3d373a', 800: '#2b2629', 900: '#1d1a1c', 950: '#141213',
        },
        green: {
          50: '#e4f3ea', 100: '#d3ecdd', 200: '#b4dcc5', 300: '#8cc6a5', 400: '#5fae83',
          500: '#4aa877', 600: '#3f9b6b', 700: '#2a7049', 800: '#1f4f35', 900: '#173b28', 950: '#0f2619',
        },
        amber: {
          50: '#fff8e6', 100: '#fff4dc', 200: '#f2dca6', 300: '#e9c77a', 400: '#d9a640',
          500: '#c48a1f', 600: '#a8731a', 700: '#8a5a10', 800: '#6f470c', 900: '#56370a', 950: '#3a2506',
        },
        red: {
          50: '#fbeeea', 100: '#f6dcd5', 200: '#ecbcae', 300: '#de917d', 400: '#cc6650',
          500: '#b9472f', 600: '#a2341f', 700: '#8a2b19', 800: '#6f2314', 900: '#571b10', 950: '#3b120a',
        },
        blue: {
          50: '#e7eef4', 100: '#d5e1eb', 200: '#b5c9da', 300: '#8eabc3', 400: '#5f86a6',
          500: '#41698b', 600: '#2f5573', 700: '#264660', 800: '#1e384d', 900: '#172b3b', 950: '#0f1c27',
        },
      },
      fontFamily: {
        sans: ['var(--font-dm-sans)', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
