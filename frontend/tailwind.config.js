/** @type {import('tailwindcss').Config} */
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
      },
    },
  },
  plugins: [],
};
