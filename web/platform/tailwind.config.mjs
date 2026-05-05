/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,ts,tsx,js,jsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        knowable: {
          cream: "#FBF5EE",
          card: "#FFFBF5",
          border: "#E8D8C4",
          orange: "#E8704A",
          "orange-hover": "#D85F39",
          primary: "#1C140A",
          muted: "#78716C",
        },
        // Legacy aliases retained so existing auth pages keep building.
        milo: {
          50: "#fdf3ef",
          100: "#fbe4d9",
          200: "#f6c8b2",
          300: "#f0a383",
          400: "#E8704A",
          500: "#e05528",
          600: "#d2421d",
          700: "#ae3319",
          800: "#8c2b1b",
          900: "#72261a",
        },
        cream: {
          50: "#FBF5EE",
          100: "#FDF8F2",
          200: "#FAF0E4",
          300: "#F5E6D3",
        },
        sage: {
          50: "#f2f7f4",
          100: "#e0ede6",
          200: "#c1dace",
          300: "#8fbfa5",
          400: "#5fa07c",
          500: "#3d8260",
          600: "#2d6748",
          700: "#255338",
        },
        warm: {
          900: "#1C140A",
          800: "#292524",
          700: "#44403C",
          600: "#57534E",
          500: "#78716C",
          400: "#A8A29E",
          300: "#D6D3D1",
          200: "#E8D8C4",
          100: "#F5F5F4",
          50: "#FAFAF9",
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        display: ['"DM Serif Display"', "Georgia", "serif"],
        serif: ['"DM Serif Display"', "Georgia", "serif"],
        mono: ['"JetBrains Mono"', '"SF Mono"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
