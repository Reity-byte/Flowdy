/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Tímto říkáme Tailwindu, ať se vždy podívá do aktuálního tématu
        'shell-bg': 'var(--shell-bg)',
        'shell-panel': 'var(--shell-panel)',
        'shell-accent': 'var(--shell-accent)',
        'shell-border': 'var(--shell-border)',
        'shell-text': 'var(--shell-text)',
      },
      fontFamily: {
        // Self-hosted via @fontsource (see main.tsx) — no external request,
        // matches the app's offline-friendly Tauri nature. Falls through to
        // the system stack if the webfont hasn't loaded yet.
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}