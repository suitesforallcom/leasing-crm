// SuitesForAll design tokens
// Direction: minimal premium B2B SaaS (Linear/Notion-adjacent) with warm neutral surfaces
// and semantic status colors optimized for property-manager workflow.

const THEME = {
  // Surfaces — warm neutrals (slight beige) instead of pure gray
  bg:        "#FAF9F7",
  surface:   "#FFFFFF",
  surfaceAlt:"#F4F2EE",
  border:    "#E8E5DF",
  borderStrong: "#D6D2CA",
  gridLine:  "#EDEAE3",

  // Text
  ink:       "#14120F",
  inkMuted:  "#6B665C",
  inkSubtle: "#94908A",

  // Accent — single brand accent (indigo-ish, desaturated)
  accent:    "#3D3BE8",
  accentSoft:"#EEEDFC",
  accentInk: "#1F1D9E",

  // Status colors (for lease workflow)
  paid:      "#10B981",   // emerald — current
  paidSoft:  "#E3F6EE",
  paidInk:   "#065F46",

  due:       "#F59E0B",   // amber — due soon
  dueSoft:   "#FDF3E0",
  dueInk:    "#92400E",

  overdue:   "#E11D48",   // rose — alert
  overdueSoft:"#FDE7EC",
  overdueInk:"#9F1239",

  vacant:    "#FFFFFF",   // white w/ dashed border
  vacantInk: "#6B665C",

  reserved:  "#8B7FF5",   // lavender — held
  reservedSoft:"#EFEBFD",
  reservedInk:"#4C3DB8",

  pending:   "#0EA5E9",   // sky — awaiting signature
  pendingSoft:"#E0F2FE",
  pendingInk:"#075985",

  common:    "#EBE8E2",   // gray — non-leasable areas
  commonInk: "#6B665C",

  // New tenant highlight (30d)
  newStar:   "#F59E0B",

  // Shadows
  shadowSm:  "0 1px 2px rgba(20, 18, 15, 0.04)",
  shadowMd:  "0 4px 12px rgba(20, 18, 15, 0.06), 0 1px 2px rgba(20, 18, 15, 0.04)",
  shadowLg:  "0 16px 40px rgba(20, 18, 15, 0.10), 0 4px 12px rgba(20, 18, 15, 0.06)",

  // Radii
  rXs: 4, rSm: 6, rMd: 8, rLg: 12, rXl: 16,
};

// Status display metadata
const STATUS_META = {
  paid:     { label: "Paid",          dot: THEME.paid,     bg: THEME.paidSoft,     ink: THEME.paidInk },
  due:      { label: "Due",           dot: THEME.due,      bg: THEME.dueSoft,      ink: THEME.dueInk },
  overdue:  { label: "Overdue",       dot: THEME.overdue,  bg: THEME.overdueSoft,  ink: THEME.overdueInk },
  vacant:   { label: "Vacant",        dot: "#C4C0B8",      bg: "#FFFFFF",          ink: THEME.inkMuted },
  reserved: { label: "Reserved",      dot: THEME.reserved, bg: THEME.reservedSoft, ink: THEME.reservedInk },
  "pending-signature": { label: "Awaiting signature", dot: THEME.pending, bg: THEME.pendingSoft, ink: THEME.pendingInk },
};

// Currency formatter
function fmt$(n) {
  return "$" + n.toLocaleString("en-US");
}

window.THEME = THEME;
window.STATUS_META = STATUS_META;
window.fmt$ = fmt$;
