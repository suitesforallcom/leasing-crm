// Mock data for SuitesForAll 4th floor
// Coordinates are in abstract "plan units" — rendered inside a 1400x900 viewBox

// Status semantics for property manager:
//  - vacant: empty, available to lease
//  - reserved: held, not yet signed
//  - pending-signature: lease sent, awaiting tenant signature
//  - paid: current month invoice paid
//  - due: invoice sent, not yet paid, within grace period
//  - overdue: invoice past due
//  - new: new tenant within last 30d (highlight overlay)

const SUITES = [
  // Top row (north wall) — window suites
  { id: "418", x: 60,  y: 60,  w: 90,  h: 90,  type: "window", rent: 1700, sqft: 164, tenant: "Sarah Davis/Maur", party: 5, status: "paid" },
  { id: "419", x: 150, y: 60,  w: 80,  h: 90,  type: "window", rent: 1200, sqft: 144, tenant: "—", party: 5, status: "vacant" },
  { id: "420", x: 230, y: 60,  w: 80,  h: 90,  type: "window", rent: 850,  sqft: 104, tenant: "—", party: 5, status: "vacant" },
  { id: "426", x: 310, y: 60,  w: 80,  h: 90,  type: "window", rent: 925,  sqft: 111, tenant: "William Peak", party: 5, status: "paid", newTenant: true },
  { id: "427", x: 390, y: 60,  w: 90,  h: 90,  type: "window", rent: 1000, sqft: 141, tenant: "—", party: 5, status: "reserved" },
  { id: "429", x: 480, y: 60,  w: 90,  h: 90,  type: "window", rent: 900,  sqft: 115, tenant: "Scott Harris & Gemayel Man", party: 5, status: "pending-signature" },
  { id: "431", x: 570, y: 60,  w: 80,  h: 90,  type: "window", rent: 990,  sqft: 120, tenant: "Bogdan Shoyat", party: 5, status: "paid" },
  { id: "432", x: 650, y: 60,  w: 90,  h: 90,  type: "window", rent: 1200, sqft: 165, tenant: "—", party: 5, status: "vacant" },
  { id: "433", x: 740, y: 60,  w: 110, h: 90,  type: "window", rent: 1500, sqft: 172, tenant: "Lex Wagner", party: 5, status: "due" },

  // Second row north — window suites
  { id: "416", x: 60,  y: 170, w: 90,  h: 85,  type: "window", rent: 850,  sqft: 108, tenant: "—", party: 3, status: "vacant" },
  { id: "417", x: 150, y: 170, w: 75,  h: 85,  type: "window", rent: 450,  sqft: 62,  tenant: "Suzanne Stokes", party: 3, status: "paid" },
  { id: "421", x: 225, y: 170, w: 75,  h: 85,  type: "window", rent: 400,  sqft: 72,  tenant: "—", party: 3, status: "vacant" },
  { id: "428", x: 300, y: 170, w: 80,  h: 85,  type: "window", rent: 525,  sqft: 82,  tenant: "Ava Carlie", party: 3, status: "overdue" },
  { id: "430", x: 440, y: 170, w: 110, h: 130, type: "window", rent: 2100, sqft: 285, tenant: "—", party: 9, status: "vacant" },
  { id: "434", x: 720, y: 170, w: 95,  h: 85,  type: "window", rent: 1050, sqft: 141, tenant: "—", party: 5, status: "vacant" },

  // Middle interior band
  { id: "415", x: 60,  y: 275, w: 90,  h: 75,  type: "interior", rent: 850, sqft: 98, tenant: "—", party: 3, status: "vacant" },
  { id: "414", x: 150, y: 275, w: 75,  h: 75,  type: "interior", rent: 400, sqft: 63, tenant: "Andrew Penn", party: 3, status: "paid" },
  { id: "423", x: 225, y: 275, w: 75,  h: 75,  type: "interior", rent: 450, sqft: 68, tenant: "Ben McMillan", party: 3, status: "paid" },
  { id: "425", x: 300, y: 275, w: 80,  h: 75,  type: "interior", rent: 625, sqft: 105, tenant: "—", party: 3, status: "reserved" },
  { id: "435", x: 555, y: 275, w: 140, h: 95,  type: "window", rent: 1200, sqft: 189, tenant: "—", party: 6, status: "vacant" },
  { id: "436", x: 720, y: 275, w: 95,  h: 85,  type: "window", rent: 1050, sqft: 139, tenant: "—", party: 6, status: "pending-signature" },

  // Lower-middle band (interior + atrium visible)
  { id: "412", x: 60,  y: 360, w: 90,  h: 75,  type: "interior", rent: 550, sqft: 74, tenant: "Ivy Lukasik", party: 0, status: "paid" },
  { id: "413", x: 150, y: 360, w: 90,  h: 75,  type: "interior", rent: 550, sqft: 82, tenant: "De'Asia Hill", party: 0, status: "overdue" },
  { id: "424", x: 240, y: 360, w: 60,  h: 75,  type: "interior", rent: 400, sqft: 58, tenant: "Mark Cook", party: 0, status: "paid" },

  { id: "411", x: 60,  y: 450, w: 95,  h: 75,  type: "interior", rent: 1000, sqft: 132, tenant: "Shannon Jenkins", party: 0, status: "paid" },

  { id: "452", x: 440, y: 360, w: 90,  h: 80,  type: "interior", rent: 675, sqft: 98, tenant: "Jason Dzuong", party: 0, status: "due" },
  { id: "438", x: 530, y: 360, w: 85,  h: 80,  type: "interior", rent: 450, sqft: 71, tenant: "Whitney Kyles", party: 0, status: "paid" },
  { id: "437", x: 720, y: 380, w: 95,  h: 80,  type: "window", rent: 1050, sqft: 135, tenant: "—", party: 5, status: "vacant" },

  { id: "439", x: 530, y: 450, w: 90,  h: 70,  type: "interior", rent: 550, sqft: 74, tenant: "Johnny Bardine", party: 0, status: "paid" },
  { id: "440", x: 620, y: 450, w: 75,  h: 70,  type: "window", rent: 600,  sqft: 78, tenant: "—", party: 3, status: "vacant" },
  { id: "441", x: 695, y: 450, w: 75,  h: 70,  type: "window", rent: 900,  sqft: 89, tenant: "—", party: 3, status: "reserved" },

  { id: "407", x: 60,  y: 540, w: 140, h: 80,  type: "interior", rent: 1600, sqft: 210, tenant: "Amber Smith", party: 0, status: "paid" },
  { id: "408", x: 220, y: 540, w: 90,  h: 80,  type: "interior", rent: 450, sqft: 64, tenant: "Lovana St. Louis", party: 0, status: "overdue" },
  { id: "409", x: 310, y: 540, w: 110, h: 80,  type: "interior", rent: 700, sqft: 92, tenant: "Bobby Sam/Bayleen T.", party: 0, status: "paid" },
  { id: "443", x: 600, y: 540, w: 95,  h: 80,  type: "window", rent: 525,  sqft: 74, tenant: "Nicholas Hammond", party: 3, status: "paid" },
  { id: "444", x: 695, y: 540, w: 95,  h: 80,  type: "window", rent: 800,  sqft: 92, tenant: "Nicholas Hammer", party: 3, status: "paid" },

  // Bottom row (south) — window suites
  { id: "406", x: 60,  y: 720, w: 80,  h: 90,  type: "window", rent: 1200, sqft: 131, tenant: "Omarra Gordon", party: 3, status: "paid" },
  { id: "405", x: 140, y: 720, w: 80,  h: 90,  type: "window", rent: 850,  sqft: 116, tenant: "—", party: 3, status: "vacant" },
  { id: "404", x: 220, y: 720, w: 80,  h: 90,  type: "window", rent: 1000, sqft: 119, tenant: "—", party: 4, status: "vacant" },
  { id: "403", x: 300, y: 720, w: 80,  h: 90,  type: "window", rent: 1000, sqft: 126, tenant: "Brian Halderman", party: 3, status: "overdue" },
  { id: "402", x: 380, y: 720, w: 80,  h: 90,  type: "window", rent: 1000, sqft: 121, tenant: "—", party: 3, status: "vacant" },
  { id: "401", x: 460, y: 720, w: 80,  h: 90,  type: "window", rent: 1000, sqft: 160, tenant: "—", party: 3, status: "reserved" },
  { id: "449", x: 560, y: 720, w: 80,  h: 90,  type: "window", rent: 1000, sqft: 128, tenant: "Parchell Nickolas", party: 3, status: "paid", newTenant: true },
  { id: "448", x: 640, y: 720, w: 80,  h: 90,  type: "window", rent: 1000, sqft: 111, tenant: "—", party: 3, status: "vacant" },
  { id: "447", x: 720, y: 720, w: 80,  h: 90,  type: "window", rent: 1000, sqft: 113, tenant: "—", party: 3, status: "vacant" },
  { id: "446", x: 800, y: 720, w: 80,  h: 90,  type: "window", rent: 1200, sqft: 112, tenant: "—", party: 3, status: "vacant" },
  { id: "445", x: 880, y: 720, w: 100, h: 90,  type: "window", rent: 630,  sqft: 82, tenant: "Jasmine Kennedy", party: 3, status: "paid", newTenant: true },
];

// Common / non-leasable areas (shown as gray shapes)
const COMMON_AREAS = [
  { id: "stairs-nw",  x: 390, y: 170, w: 50, h: 130, label: "STAIRS" },
  { id: "stairs-sw",  x: 300, y: 630, w: 70, h: 85,  label: "STAIRS" },
  { id: "hallway-n",  x: 60,  y: 150, w: 790, h: 20, label: "" },
  { id: "hallway-s",  x: 60,  y: 700, w: 920, h: 20, label: "" },
  { id: "atrium",     x: 310, y: 360, w: 130, h: 260, label: "ATRIUM" },
  { id: "mechanical-1", x: 60, y: 450, w: 95, h: 85, label: "MECHANICAL" },
  { id: "restroom-1",   x: 155, y: 450, w: 65, h: 85, label: "RESTROOM" },
  { id: "restroom-2",   x: 220, y: 450, w: 65, h: 85, label: "RESTROOM" },
  { id: "kitchen",      x: 285, y: 450, w: 90, h: 85, label: "KITCHEN" },
  { id: "elevator-1",   x: 440, y: 450, w: 45, h: 85, label: "ELEV." },
  { id: "elevator-2",   x: 485, y: 450, w: 45, h: 85, label: "ELEV." },
  { id: "storage-1",    x: 440, y: 540, w: 60, h: 80, label: "STORAGE" },
  { id: "storage-2",    x: 500, y: 540, w: 100, h: 80, label: "STORAGE" },
];

// Floor summary data
const FLOORS = [
  { id: 1, name: "1st Floor",  occupied: 0,  total: 0,  revenue: 0 },
  { id: 2, name: "2nd Floor",  occupied: 0,  total: 25, revenue: 0 },
  { id: 3, name: "3rd Floor",  occupied: 30, total: 66, revenue: 23050 },
  { id: 4, name: "4th Floor",  occupied: 27, total: 48, revenue: 20370, active: true },
];

window.SUITES = SUITES;
window.COMMON_AREAS = COMMON_AREAS;
window.FLOORS = FLOORS;
