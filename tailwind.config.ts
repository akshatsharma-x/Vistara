import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        vistara: {
          dark: "#0A0A0F",
          surface: "#13131A",
          border: "#1E1E2E",
          accent: "#6C63FF",
          green: "#00D49A",
          amber: "#F5A623",
          red: "#FF4D6D",
          text: "#E8E8F0",
          muted: "#8A8AA0",
        },
        // Single-hue ordinal ramp derived from vistara-accent.
        // Validated with dataviz validate_palette.js --ordinal --mode dark
        // --surface #13131A: monotone lightness, adjacent dL >= 0.06,
        // light-end contrast 2.10:1, hue spread 10deg. ALL CHECKS PASS.
        // Use for magnitude / ordered encodings. Never for identity.
        ramp: {
          100: "#C9C4FF",
          200: "#ADA6FF",
          300: "#9089FF",
          400: "#6C63FF",
          500: "#564EDB",
          600: "#413AA6",
        },
      },
      fontFamily: {
        sans: [
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Helvetica Neue",
          "sans-serif",
        ],
      },
      fontSize: {
        hero: ["4.25rem", { lineHeight: "1", letterSpacing: "-0.03em" }],
      },
      borderRadius: {
        card: "14px",
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "grow-x": {
          "0%": { transform: "scaleX(0)" },
          "100%": { transform: "scaleX(1)" },
        },
        // Opacity only, no rise: used where an element appears in the middle of
        // a list that is already settled (the sequentially revealed mindset
        // questions), where a translate would shove the answers below it.
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        // One beat as a processing row lights up. Applied only for the 520ms the
        // row is active, so the class mounts once per row and the animation
        // therefore runs once rather than looping.
        "dot-pulse": {
          "0%, 100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.3)" },
        },
      },
      animation: {
        "fade-up": "fade-up 380ms cubic-bezier(0.16,1,0.3,1) both",
        "grow-x": "grow-x 620ms cubic-bezier(0.16,1,0.3,1) both",
        "fade-in": "fade-in 150ms ease-out both",
        "dot-pulse": "dot-pulse 300ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
