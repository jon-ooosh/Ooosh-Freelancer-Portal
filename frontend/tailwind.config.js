/** @type {import('tailwindcss').Config} */
// The freelancer look (`hf` / `kind` colours, DM Sans) is ONLY for the van
// screens a freelancer reaches from the portal (FreelancerBookoutShell /
// FreelancerCheckinShell, FREELANCER-PORTAL-SPEC §11). The colours are the
// portal's own, from one shared file. Staff screens never use these names.
import freelancerTokens from '../shared/design/freelancer-tokens.cjs';

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ooosh: {
          50: '#f0f7ff',
          100: '#e0effe',
          200: '#bae0fd',
          300: '#7cc8fb',
          400: '#36adf7',
          500: '#0c93e8',
          600: '#0074c6',
          700: '#015da1',
          800: '#064f85',
          900: '#0a426e',
          950: '#072a49',
          navy: '#072a49',
          blue: '#0c93e8',
        },
        hf: freelancerTokens.hf,
        kind: freelancerTokens.kind,
      },
      fontFamily: {
        // Self-hosted (@fontsource-variable/dm-sans), loaded by the freelancer theme only.
        freelancer: ['"DM Sans Variable"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
