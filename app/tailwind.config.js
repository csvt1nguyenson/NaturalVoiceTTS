/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./public/index.html", "./public/app.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans"', "Segoe UI", "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "Consolas", "monospace"]
      },
      colors: {
        ink: { DEFAULT: "#E8ECF1", 2: "#AEB7C2", 3: "#7C8794" },
        line: "#2A323C",
        canvas: "#12161B",
        surface: "#1A1F26",
        raised: "#222932",
        brand: { DEFAULT: "#2FB8A6", hover: "#4CCBBA", soft: "#173B38" },
        ok: { DEFAULT: "#5FD38D", soft: "#163826" },
        warn: { DEFAULT: "#E9B04E", soft: "#3C2F12" },
        bad: { DEFAULT: "#F07C64", soft: "#42211A" }
      },
      fontSize: { xs: ["11.5px", "16px"], sm: ["12.5px", "18px"], base: ["13.5px", "20px"] }
    }
  },
  plugins: []
};
