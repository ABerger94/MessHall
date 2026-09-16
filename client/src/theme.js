// Palette as config — the structural rule from the redesign deliberation:
// theme is data, not scattered hex codes. index.css maps these tokens to
// CSS variables per theme; components only ever touch var(--token).
export const THEMES = {
  diner: {
    label: 'Warm Diner',
    icon: '🌞',
    tokens: {
      '--bg': '#FFF8E7', // cream
      '--surface': '#FFFDF4', // warm paper for cards/rows
      '--surface-2': '#F6EBCF', // pressed-tin panels, inputs
      '--ink': '#6B4F2A', // coffee-brown body copy
      '--ink-dim': '#96754C', // muted secondary text
      '--ink-faint': '#B89B6E', // faintest metadata
      '--line': '#EAD9AE', // honey-tinted borders
      '--accent': '#D9A441', // honey — accents and borders, never body copy
      '--on-accent': '#3A2A12', // text on honey
      '--pop': '#E86A5A', // tomato-red pops
      '--upvote': '#E4572E', // dino-orange 🦖
      '--jungle': '#1E3A2B', // jungle green (404 page)
      '--leaf': '#A8D5A2',
      '--amber-glow': '#F2C14E',
      '--ok': '#2F7D4F',
      '--info': '#2B6CB0',
      '--danger': '#C0392B',
      '--shadow': '0 1px 2px rgba(107,79,42,.08)',
    },
  },
  lab: {
    label: 'Midnight Lab',
    icon: '🌙',
    tokens: {
      '--bg': '#0D1117', // near-black
      '--surface': '#131A23', // lab bench
      '--surface-2': '#1B2330', // panels, inputs
      '--ink': '#E6EDF3', // terminal phosphor
      '--ink-dim': '#9AA7B5',
      '--ink-faint': '#5C6A7A',
      '--line': '#2A3542',
      '--accent': '#58A6FF', // electric blue
      '--on-accent': '#04121F',
      '--pop': '#F778BA', // neon pink pops
      '--upvote': '#E4572E', // dino-orange still 🦖
      '--jungle': '#1E3A2B',
      '--leaf': '#A8D5A2',
      '--amber-glow': '#F2C14E',
      '--ok': '#7EE787', // terminal green
      '--info': '#58A6FF',
      '--danger': '#FF7B72',
      '--shadow': '0 1px 2px rgba(0,0,0,.4)',
    },
  },
};

const STORAGE_KEY = 'messhall_theme';

export function getInitialTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'diner' || saved === 'lab') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'lab' : 'diner';
}

export function applyTheme(name) {
  const theme = THEMES[name] || THEMES.diner;
  const root = document.documentElement;
  root.dataset.theme = name;
  for (const [token, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(token, value);
  }
  localStorage.setItem(STORAGE_KEY, name);
  // Keep the browser chrome in sync (mobile address bar, etc.)
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = theme.tokens['--bg'];
}
