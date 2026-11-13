import type { Config } from "tailwindcss";

const v = (n: string) => `rgb(var(--${n}) / <alpha-value>)`;

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        surface: v("surface"),
        elevated: v("elevated"),
        line: v("line"),
        fg: v("fg"),
        muted: v("muted"),
        accent: v("accent"),
        pos: v("pos"),
        neg: v("neg"),
        warn: v("warn"),
        live: v("live"),
        paper: v("paper"),
      },
      borderRadius: { xl: "14px", "2xl": "20px" },
      boxShadow: { soft: "0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px rgb(0 0 0 / 0.06)" },
      fontFamily: { sans: ["-apple-system", "SF Pro Text", "Inter", "system-ui", "sans-serif"] },
    },
  },
  plugins: [],
} satisfies Config;
