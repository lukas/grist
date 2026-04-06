const path = require("path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [path.join(__dirname, "index.html"), path.join(__dirname, "src/**/*.{js,ts,tsx}")],
  theme: {
    extend: {
      colors: {
        panel: "#0f1419",
        border: "#2a3441",
        accent: "#3b82f6",
        muted: "#8b9cb3",
      },
    },
  },
  plugins: [],
};
