// Inline SVG icons — 16x16 viewBox, currentColor stroke
// Lightweight hand-rolled set, no external deps

const Icon = ({ name, size = 16, stroke = 1.5, className = "", style = {} }) => {
  const paths = ICONS[name];
  if (!paths) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
};

const ICONS = {
  grid:   <><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></>,
  map:    <><path d="M2 4l4-2 4 2 4-2v10l-4 2-4-2-4 2V4z"/><path d="M6 2v12M10 4v12"/></>,
  file:   <><path d="M4 2h5l3 3v9H4V2z"/><path d="M9 2v3h3"/></>,
  people: <><circle cx="6" cy="6" r="2.5"/><path d="M2 14c0-2.2 1.8-4 4-4s4 1.8 4 4"/><path d="M11 7a2 2 0 100-4M14 13c0-1.5-1-3-3-3"/></>,
  dollar: <><path d="M8 2v12M11 5c0-1.1-1.3-2-3-2s-3 .9-3 2 1.3 2 3 2 3 .9 3 2-1.3 2-3 2-3-.9-3-2"/></>,
  pulse:  <><path d="M2 8h3l2-5 2 10 2-5h3"/></>,
  printer:<><rect x="3" y="8" width="10" height="5"/><path d="M4 8V3h8v5M4 13v2h8v-2"/></>,
  trophy: <><path d="M5 2h6v4a3 3 0 01-6 0V2zM3 3H2v2a2 2 0 002 2M13 3h1v2a2 2 0 01-2 2M6 10h4l-1 4H7l-1-4z"/></>,
  search: <><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></>,
  plus:   <><path d="M8 3v10M3 8h10"/></>,
  chevronDown: <><path d="M4 6l4 4 4-4"/></>,
  chevronRight: <><path d="M6 4l4 4-4 4"/></>,
  chevronLeft: <><path d="M10 4l-4 4 4 4"/></>,
  x:      <><path d="M4 4l8 8M12 4l-8 8"/></>,
  dot:    <><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/></>,
  bell:   <><path d="M4 11V7a4 4 0 018 0v4l1 2H3l1-2zM6 13a2 2 0 004 0"/></>,
  signature: <><path d="M2 12s2-6 4-6 2 6 4 6 2-3 4-3"/><path d="M2 14h12"/></>,
  send:   <><path d="M14 2L2 7l5 2 2 5 5-12z"/></>,
  message:<><path d="M2 4h12v8H5l-3 2V4z"/></>,
  calendar:<><rect x="2" y="3" width="12" height="11" rx="1"/><path d="M2 6h12M5 2v2M11 2v2"/></>,
  window: <><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M8 3v10M2 8h12"/></>,
  wrench: <><path d="M10 2a3 3 0 00-2.8 4L2 11.2V14h2.8L10 8.8A3 3 0 1010 2z"/></>,
  layers: <><path d="M8 2l6 3-6 3-6-3 6-3z"/><path d="M2 8l6 3 6-3M2 11l6 3 6-3"/></>,
  filter: <><path d="M2 3h12l-4 6v4l-4 1V9L2 3z"/></>,
  eye:    <><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></>,
  star:   <><path d="M8 2l2 4 4 .5-3 3 .8 4L8 11.5 4.2 13.5l.8-4-3-3 4-.5L8 2z"/></>,
  sun:    <><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/></>,
  moon:   <><path d="M12 10A5 5 0 116 4a4 4 0 006 6z"/></>,
  settings: <><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></>,
  zoomIn: <><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14M7 5v4M5 7h4"/></>,
  zoomOut:<><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14M5 7h4"/></>,
  sync:   <><path d="M13 3v3h-3M3 13v-3h3"/><path d="M13 6a5 5 0 00-9-1M3 10a5 5 0 009 1"/></>,
  building: <><rect x="3" y="2" width="10" height="12"/><path d="M6 5h1M9 5h1M6 8h1M9 8h1M6 11h4"/></>,
  key:    <><circle cx="11" cy="6" r="3"/><path d="M8.5 8L3 13.5V15h2v-1.5h1.5V12H8L8.5 8z"/></>,
  trash:  <><path d="M3 5h10M6 5V3h4v2M5 5l1 9h4l1-9"/></>,
  check:  <><path d="M3 8l3 3 7-7"/></>,
  alert:  <><path d="M8 2l7 12H1L8 2z"/><path d="M8 7v3M8 12v.5"/></>,
  move:   <><path d="M8 1v14M1 8h14M5 4l3-3 3 3M5 12l3 3 3-3M4 5l-3 3 3 3M12 5l3 3-3 3"/></>,
  sink:   <><circle cx="8" cy="8" r="5"/><path d="M8 3v5l2.5 2.5"/></>,
};

window.Icon = Icon;
