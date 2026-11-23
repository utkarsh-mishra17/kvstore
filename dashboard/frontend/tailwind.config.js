/** Theme tokens are CSS variables (see index.css) so the light/dark toggle is a single class switch. */
const v = (n) => `rgb(var(--${n}) / <alpha-value>)`
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: v('bg'), panel: v('panel'), raised: v('raised'), line: v('line'),
        ink: v('ink'), mute: v('mute'),
        cpu: '#f2b441', disk: '#35c4be', mem: '#a68bfa', sync: '#fb7185', net: '#6aa6ff', good: '#4ade80', bad: '#f87171',
      },
      fontFamily: { sans: ['Manrope', 'system-ui', 'sans-serif'], mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'] },
    },
  },
  plugins: [],
}
