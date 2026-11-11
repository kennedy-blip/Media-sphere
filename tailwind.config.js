/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0B0F19",
        panel: "#111827",
        accent: "#7C5CFF",
        mint: "#34D399",
      },
    },
  },
  plugins: [],
};
