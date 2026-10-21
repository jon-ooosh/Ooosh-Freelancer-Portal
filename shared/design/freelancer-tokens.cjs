/**
 * The freelancer look (Oct 2026 refresh, docs/design/freelancer-portal-refresh/):
 * the design's colours by name, matching the hire form and payment portal.
 *
 * ONE definition, read by two Tailwind configs: the freelancer portal
 * (tailwind.config.js at the repo root) and the staff app's freelancer van
 * screens (frontend/tailwind.config.js, used only inside the freelancer shells).
 * Change a colour here and both follow.
 */

const hf = {
  accent: '#A75390',
  'accent-pressed': '#8f4a7c',
  link: '#8c3f77',
  'link-hover': '#6e2f5d',
  tint: '#f6eaf2',
  'tint-text': '#7d3569',
  'tint-strong': '#5e2a50',
  ink: '#1d1a1c',
  body: '#3d373a',
  muted: '#6f6569',
  placeholder: '#9a9094',
  page: '#f6f4f2',
  inset: '#f8f6f4',
  track: '#f3f0ed',
  seg: '#ece8e4',
  card: '#ffffff',
  border: '#e8e3df',
  control: '#e3ddd8',
  divider: '#f0ece9',
  chevron: '#b9b0ab',
  dashed: '#cfc6c0',
  'toggle-off': '#d9d2cc',
  green: '#3f9b6b',
  'green-text': '#2a7049',
  'green-tint': '#e4f3ea',
  'green-strong': '#1f4f35',
  'amber-bg': '#fff8e6',
  'amber-border': '#f2dca6',
  'amber-text': '#8a5a10',
  'amber-tile': '#fff4dc',
  error: '#a2341f',
  disabled: '#cdbfc8',
}

// Job-kind tiles and labels (background / foreground).
const kind = {
  'backline-bg': '#f6eaf2', backline: '#8c3f77',
  'van-bg': '#e7eef4', van: '#2f5573',
  'crew-bg': '#e4f3ea', crew: '#2a7049',
  'studio-bg': '#ecebf6', studio: '#4b4790',
  'yard-bg': '#f3f0ed', yard: '#3d373a',
}

module.exports = { hf, kind }
