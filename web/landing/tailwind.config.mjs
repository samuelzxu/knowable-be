/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,ts,tsx,js,jsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        milo: {
          50: "#fdf3ef",
          100: "#fbe4d9",
          200: "#f6c8b2",
          300: "#f0a383",
          400: "#e8704a",
          500: "#e05528",
          600: "#d2421d",
          700: "#ae3319",
          800: "#8c2b1b",
          900: "#72261a",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "Roboto",
          '"Helvetica Neue"',
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
