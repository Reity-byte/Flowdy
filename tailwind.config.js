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
    },
  },
  plugins: [],
}