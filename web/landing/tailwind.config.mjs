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
          400: "#E8704A",
          500: "#e05528",
          600: "#d2421d",
          700: "#ae3319",
          800: "#8c2b1b",
          900: "#72261a",
        },
        cream: {
          50: "#FEFCF9",
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
          900: "#1C1917",
          800: "#292524",
          700: "#44403C",
          600: "#57534E",
          500: "#78716C",
          400: "#A8A29E",
          300: "#D6D3D1",
          200: "#E7E5E4",
          100: "#F5F5F4",
          50: "#FAFAF9",
        },
      },
      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        display: ['"DM Serif Display"', "Georgia", "serif"],
      },
      animation: {
        "float-slow": "float 6s ease-in-out infinite",
        "pulse-soft": "pulse-soft 3s ease-in-out infinite",
        "glow-pulse": "glow-pulse 4s ease-in-out infinite",
        "fade-up": "fade-up 0.6s ease-out forwards",
        "fade-in": "fade-in 0.5s ease-out forwards",
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-10px)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
        "glow-pulse": {
          "0%, 100%": { boxShadow: "0 0 30px 10px rgba(232,112,74,0.15)" },
          "50%": { boxShadow: "0 0 60px 20px rgba(232,112,74,0.25)" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};
