/* global React */
/**
 * Icon library — original line-art SVGs (24x24 viewBox, stroke-based).
 * All inherit currentColor so they pick up text color / theming.
 * Usage: <Icon name="bolt" />  or  <Icon name="bolt" className="..." />
 */

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" };
const FILL_INVERT = { fill: "currentColor", stroke: "none" };

const PATHS = {
  // navigation
  home:        <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" {...STROKE}/>,
  activity:    <path d="M3 12h4l2-7 6 14 2-7h4" {...STROKE}/>,
  people:      <g {...STROKE}><circle cx="9" cy="9" r="3.2"/><path d="M3 19c.6-3 3-5 6-5s5.4 2 6 5"/><circle cx="17" cy="8" r="2.5"/><path d="M16 19c.4-2.2 1.9-3.7 4.5-3.7"/></g>,
  compare:     <g {...STROKE}><path d="M4 6h7v14"/><path d="M20 6h-7v14"/><path d="M7 10v2M7 14v2M17 10v2M17 14v2"/></g>,
  bell:        <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5 2 6H4c.5-1 2-2 2-6zM10 19a2 2 0 0 0 4 0" {...STROKE}/>,
  settings:    <g {...STROKE}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></g>,
  search:      <g {...STROKE}><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/></g>,
  filter:      <path d="M4 5h16l-6 8v6l-4-2v-4z" {...STROKE}/>,
  download:    <path d="M12 4v11m0 0 4-4m-4 4-4-4M4 19h16" {...STROKE}/>,
  share:       <g {...STROKE}><circle cx="7" cy="12" r="2.5"/><circle cx="17" cy="6" r="2.5"/><circle cx="17" cy="18" r="2.5"/><path d="m9.2 11 5.6-3.5M9.2 13l5.6 3.5"/></g>,
  more:        <g {...FILL_INVERT}><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/></g>,
  close:       <path d="m6 6 12 12M18 6 6 18" {...STROKE}/>,
  check:       <path d="m4 12 5 5L20 6" {...STROKE}/>,
  chevR:       <path d="m9 6 6 6-6 6" {...STROKE}/>,
  chevL:       <path d="m15 6-6 6 6 6" {...STROKE}/>,
  chevD:       <path d="m6 9 6 6 6-6" {...STROKE}/>,
  arrowUp:     <path d="m5 12 7-7 7 7M12 5v15" {...STROKE}/>,
  arrowDn:     <path d="m5 12 7 7 7-7M12 19V4" {...STROKE}/>,
  arrowR:      <path d="M4 12h16m-5-6 6 6-6 6" {...STROKE}/>,
  trendUp:     <path d="m4 17 6-6 4 4 6-8M14 7h6v6" {...STROKE}/>,
  trendDn:     <path d="m4 7 6 6 4-4 6 8M14 17h6v-6" {...STROKE}/>,
  bolt:        <path d="M13 2 4 14h7l-1 8 9-12h-7z" {...STROKE}/>,
  sparkle:     <path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.5 5.5l3.5 3.5M15 15l3.5 3.5M5.5 18.5 9 15M15 9l3.5-3.5" {...STROKE}/>,

  // category icons
  login:       <g {...STROKE}><path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M3 12h12m-3-3 3 3-3 3"/></g>,
  logout:      <g {...STROKE}><path d="M10 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="M21 12H9m3-3-3 3 3 3"/></g>,
  doc:         <g {...STROKE}><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M13 3v5h6M8 13h8M8 17h5"/></g>,
  docUpload:   <g {...STROKE}><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M13 3v5h6"/><path d="M12 19v-6m-3 3 3-3 3 3"/></g>,
  docOpen:     <g {...STROKE}><path d="M5 7h14v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM9 7V4h6v3M9 12h6M9 16h6"/></g>,
  docSign:     <g {...STROKE}><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M13 3v5h6"/><path d="M8 15c2-3 4-3 6 0s4 3 4 0"/></g>,
  contract:    <g {...STROKE}><path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5M8 13h8M8 17h5M8 9h3"/></g>,
  mail:        <g {...STROKE}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></g>,
  mailIn:      <g {...STROKE}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6M12 13v-7m-2.5 2.5L12 6l2.5 2.5"/></g>,
  mailOut:     <g {...STROKE}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></g>,
  phone:       <path d="M5 5c.5-.7 1.2-1 2-1h2l1.5 4-2 1.5c.7 2.3 2.7 4.3 5 5l1.5-2 4 1.5v2c0 .8-.3 1.5-1 2-7 1-15-7-13-13z" {...STROKE}/>,
  phoneIn:     <g {...STROKE}><path d="M5 5c.5-.7 1.2-1 2-1h2l1.5 4-2 1.5c.7 2.3 2.7 4.3 5 5l1.5-2 4 1.5v2c0 .8-.3 1.5-1 2-7 1-15-7-13-13z"/><path d="M16 8h5m0 0V3m0 5-5-5"/></g>,
  phoneOut:    <g {...STROKE}><path d="M5 5c.5-.7 1.2-1 2-1h2l1.5 4-2 1.5c.7 2.3 2.7 4.3 5 5l1.5-2 4 1.5v2c0 .8-.3 1.5-1 2-7 1-15-7-13-13z"/><path d="M21 3h-5m5 0v5m0-5-5 5"/></g>,
  phoneMiss:   <g {...STROKE}><path d="M5 5c.5-.7 1.2-1 2-1h2l1.5 4-2 1.5c.7 2.3 2.7 4.3 5 5l1.5-2 4 1.5v2c0 .8-.3 1.5-1 2-7 1-15-7-13-13z"/><path d="m15 3 6 6M21 3l-6 6"/></g>,
  user:        <g {...STROKE}><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></g>,
  building:    <g {...STROKE}><rect x="4" y="3" width="16" height="18" rx="1"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2M10 21v-3h4v3"/></g>,
  invoice:     <g {...STROKE}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 9h6M9 13h6M9 17h3"/></g>,
  task:        <g {...STROKE}><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/></g>,
  shield:      <path d="M12 3 4 6v6c0 4.5 3.5 8 8 9 4.5-1 8-4.5 8-9V6z" {...STROKE}/>,
  warning:     <g {...STROKE}><path d="M12 3 2 20h20zM12 10v5M12 18v.5"/></g>,
  clock:       <g {...STROKE}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></g>,
  play:        <path d="M7 4v16l13-8z" {...STROKE}/>,
  pause:       <path d="M8 5h3v14H8zM13 5h3v14h-3z" {...STROKE}/>,
  link:        <g {...STROKE}><path d="M10 14a4 4 0 0 1 0-6l3-3a4 4 0 0 1 6 6l-2 2"/><path d="M14 10a4 4 0 0 1 0 6l-3 3a4 4 0 0 1-6-6l2-2"/></g>,
  copy:        <g {...STROKE}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></g>,
  eye:         <g {...STROKE}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></g>,
  edit:        <path d="m4 20 4-1 11-11-3-3L5 16zM14 6l3 3" {...STROKE}/>,
  trash:       <g {...STROKE}><path d="M4 7h16M9 7V4h6v3M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6"/></g>,
  plus:        <path d="M12 5v14M5 12h14" {...STROKE}/>,
  minus:       <path d="M5 12h14" {...STROKE}/>,
  globe:       <g {...STROKE}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></g>,
  laptop:      <g {...STROKE}><rect x="4" y="5" width="16" height="11" rx="1"/><path d="M2 20h20"/></g>,
  mobile:      <g {...STROKE}><rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/></g>,
  ipin:        <g {...STROKE}><path d="M12 22s7-7 7-13a7 7 0 1 0-14 0c0 6 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/></g>,
  flag:        <path d="M5 3v18M5 4h12l-2 4 2 4H5" {...STROKE}/>,
  pin:         <path d="M12 12 5 19m4-12 7 7-3 2-3-1-3 1-2-3 1-3 3-3z" {...STROKE}/>,
  cal:         <g {...STROKE}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/></g>,
  refresh:     <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" {...STROKE}/>,
  star:        <path d="m12 3 2.5 5.5 6 .8-4.4 4.2 1.2 6L12 16.7 6.7 19.5l1.2-6L3.5 9.3l6-.8z" {...STROKE}/>,
  zap:         <path d="m9 2-5 12h6l-1 8 9-12h-6l2-8z" {...STROKE}/>,
  signal:      <g {...STROKE}><path d="M4 20V16M9 20v-7M14 20V9M19 20V4"/></g>,
  card:        <g {...STROKE}><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/></g>,
  pie:         <g {...STROKE}><path d="M12 4v8h8a8 8 0 1 1-8-8z"/><path d="M15 3a6 6 0 0 1 6 6h-6z"/></g>,
  bars:        <g {...STROKE}><path d="M4 20V10M10 20V4M16 20v-6M22 20v-9"/></g>,
};

window.Icon = function Icon({ name, className, style, size }) {
  const path = PATHS[name];
  if (!path) {
    return <svg className={"icon " + (className || "")} viewBox="0 0 24 24" width={size} height={size}><rect x="3" y="3" width="18" height="18" rx="3" {...STROKE}/></svg>;
  }
  return (
    <svg
      className={"icon " + (className || "")}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      style={style}
      aria-hidden="true"
    >
      {path}
    </svg>
  );
};
