/* global React */

/* ================================================================
   Growth Tree — visual representation of the employee's month.
   Multiple fruit types map to different bonus rule triggers.
   Decorations (lanterns, crown, bird, stars) reward streaks +
   achievements.  Attention signals (fallen leaves, buds, wilted
   leaves) flag missed callbacks, unanswered SMS, stale leads.
   ================================================================ */

/* === Leaf positions across the canopy === */
const TREE_LEAVES = [
  { x: 60,  y: 130, r: 14 }, { x: 80,  y: 110, r: 16 }, { x: 105, y: 95,  r: 18 },
  { x: 130, y: 85,  r: 18 }, { x: 155, y: 78,  r: 20 }, { x: 180, y: 80,  r: 18 },
  { x: 205, y: 90,  r: 16 }, { x: 230, y: 105, r: 16 }, { x: 250, y: 125, r: 14 },
  { x: 80,  y: 150, r: 18 }, { x: 110, y: 135, r: 20 }, { x: 140, y: 120, r: 22 },
  { x: 170, y: 120, r: 22 }, { x: 200, y: 135, r: 20 }, { x: 225, y: 155, r: 18 },
  { x: 100, y: 170, r: 22 }, { x: 130, y: 160, r: 24 }, { x: 160, y: 150, r: 24 },
  { x: 190, y: 165, r: 22 }, { x: 215, y: 175, r: 18 }, { x: 120, y: 190, r: 18 },
  { x: 150, y: 185, r: 18 }, { x: 180, y: 190, r: 18 }, { x: 200, y: 195, r: 16 },
  { x: 145, y: 65,  r: 14 }, { x: 175, y: 68,  r: 14 }, { x: 160, y: 58,  r: 12 },
  { x: 55,  y: 150, r: 12 }, { x: 260, y: 145, r: 12 }, { x: 95,  y: 120, r: 14 },
  { x: 215, y: 115, r: 14 }, { x: 125, y: 105, r: 14 }, { x: 185, y: 100, r: 14 },
  { x: 145, y: 140, r: 14 }, { x: 175, y: 145, r: 14 }, { x: 165, y: 175, r: 14 },
];

/* === Universal fruit slots (16) — fruits placed in priority order === */
const FRUIT_SLOTS = [
  { x: 90,  y: 160 }, { x: 145, y: 180 }, { x: 195, y: 165 }, { x: 220, y: 150 },
  { x: 120, y: 140 }, { x: 165, y: 155 }, { x: 75,  y: 135 }, { x: 245, y: 130 },
  { x: 135, y: 100 }, { x: 180, y: 105 }, { x: 105, y: 115 }, { x: 215, y: 115 },
  { x: 155, y: 75  }, { x: 185, y: 78  }, { x: 60,  y: 145 }, { x: 260, y: 140 },
];

const FALLEN_LEAVES = [
  { x: 95,  y: 283, r: 6, rot: -25 }, { x: 130, y: 290, r: 5, rot: 10 },
  { x: 175, y: 288, r: 7, rot: -10 }, { x: 215, y: 286, r: 6, rot: 30 },
  { x: 75,  y: 284, r: 5, rot: 45 },  { x: 235, y: 284, r: 6, rot: -15 },
];
const TREE_BUDS = [
  { x: 88,  y: 155, r: 6 }, { x: 142, y: 95,  r: 6 }, { x: 195, y: 92, r: 6 },
  { x: 233, y: 115, r: 5 }, { x: 110, y: 130, r: 6 }, { x: 170, y: 142, r: 5 },
];
const WILTED_LEAVES = [
  { x: 75,  y: 120, r: 12 }, { x: 250, y: 100, r: 12 },
  { x: 115, y: 165, r: 13 }, { x: 210, y: 168, r: 11 },
];

/* sky stars (achievements) */
const SKY_STARS = [
  { x: 25,  y: 30,  r: 2.4 }, { x: 55, y: 18, r: 1.8 }, { x: 95,  y: 28, r: 2 },
  { x: 35,  y: 52,  r: 1.6 }, { x: 70, y: 44, r: 1.5 }, { x: 110, y: 50, r: 2.2 },
  { x: 200, y: 22,  r: 1.8 }, { x: 230, y: 38, r: 2.2 }, { x: 305, y: 28, r: 1.7 },
  { x: 248, y: 60,  r: 1.5 }, { x: 285, y: 52, r: 2 },  { x: 175, y: 38, r: 1.5 },
];

/* lantern positions along a string */
const LANTERN_PATH = "M 65 175 Q 160 200 260 165";

function GrowthTree({
  leafProgress = 0,
  /* fruits: { apple, golden, plum, lemon, star, gem } */
  fruits = {},
  missedCalls = 0,
  unansweredSms = 0,
  staleLeads = 0,
  streak = 0,
  achievements = 0,
  hasBird = false,
  hasCrown = false,
  weather = "sunny",
  size = 360,
}) {
  const leafCount = Math.round(TREE_LEAVES.length * leafProgress);
  const visibleLeaves = TREE_LEAVES.slice(0, leafCount);
  const visibleFallen = FALLEN_LEAVES.slice(0, Math.min(missedCalls, FALLEN_LEAVES.length));
  const visibleBuds   = TREE_BUDS.slice(0, Math.min(unansweredSms, TREE_BUDS.length));
  const visibleWilted = WILTED_LEAVES.slice(0, Math.min(staleLeads, WILTED_LEAVES.length));

  /* Distribute fruits across slots — priority order: golden, gem, apple, plum, lemon, star */
  const fruitOrder = ["golden", "gem", "apple", "plum", "lemon", "star"];
  const placedFruits = [];
  let slotIdx = 0;
  fruitOrder.forEach(type => {
    const count = Math.max(0, Math.min(fruits[type] || 0, FRUIT_SLOTS.length - slotIdx));
    for (let i = 0; i < count; i++) {
      placedFruits.push({ type, ...FRUIT_SLOTS[slotIdx++] });
    }
  });

  /* Lanterns — show when streak > 0, scale count with streak */
  const lanternCount = Math.min(7, Math.floor(streak / 2));
  const lanterns = [];
  for (let i = 0; i < lanternCount; i++) {
    const t = (i + 1) / (lanternCount + 1);
    /* sample point along bezier */
    const start = [65, 175], ctrl = [160, 200], end = [260, 165];
    const x = (1 - t) ** 2 * start[0] + 2 * (1 - t) * t * ctrl[0] + t * t * end[0];
    const y = (1 - t) ** 2 * start[1] + 2 * (1 - t) * t * ctrl[1] + t * t * end[1];
    lanterns.push({ x, y, hue: 30 + (i * 40) % 320 });
  }

  /* sky stars — show count proportional to achievements (0-12) */
  const visibleStars = SKY_STARS.slice(0, Math.min(achievements, SKY_STARS.length));

  return (
    <svg viewBox="0 0 320 320" style={{ width: "100%", maxWidth: size, height: "auto", display: "block" }}>
      {/* === Background sky gradient === */}
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={weather === "cloudy" ? "oklch(92% 0.01 240)" : weather === "partly" ? "oklch(94% 0.02 220)" : "oklch(96% 0.04 220)"} />
          <stop offset="100%" stopColor="oklch(98% 0.01 220)" />
        </linearGradient>
        <radialGradient id="sun-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%"   stopColor="oklch(95% 0.18 80)" stopOpacity="1" />
          <stop offset="60%"  stopColor="oklch(85% 0.18 80)" stopOpacity=".4" />
          <stop offset="100%" stopColor="oklch(85% 0.18 80)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="oklch(80% 0.06 110)" />
          <stop offset="100%" stopColor="oklch(70% 0.08 100)" />
        </linearGradient>
        <linearGradient id="trunk" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="oklch(42% 0.06 50)" />
          <stop offset="50%"  stopColor="oklch(50% 0.07 50)" />
          <stop offset="100%" stopColor="oklch(42% 0.06 50)" />
        </linearGradient>
        <radialGradient id="apple-grad" cx="0.35" cy="0.35" r="0.65">
          <stop offset="0%"   stopColor="oklch(78% 0.18 25)" />
          <stop offset="100%" stopColor="oklch(50% 0.20 25)" />
        </radialGradient>
        <radialGradient id="golden-grad" cx="0.35" cy="0.35" r="0.65">
          <stop offset="0%"   stopColor="oklch(96% 0.18 90)" />
          <stop offset="100%" stopColor="oklch(70% 0.18 75)" />
        </radialGradient>
        <radialGradient id="plum-grad" cx="0.35" cy="0.35" r="0.65">
          <stop offset="0%"   stopColor="oklch(60% 0.18 310)" />
          <stop offset="100%" stopColor="oklch(38% 0.18 305)" />
        </radialGradient>
        <radialGradient id="lemon-grad" cx="0.35" cy="0.35" r="0.65">
          <stop offset="0%"   stopColor="oklch(95% 0.18 100)" />
          <stop offset="100%" stopColor="oklch(75% 0.18 95)" />
        </radialGradient>
        <radialGradient id="gem-grad" cx="0.35" cy="0.35" r="0.65">
          <stop offset="0%"   stopColor="oklch(85% 0.14 200)" />
          <stop offset="100%" stopColor="oklch(55% 0.18 230)" />
        </radialGradient>
      </defs>

      <rect x="0" y="0" width="320" height="240" fill="url(#sky)" />

      {/* === Sky stars === */}
      {visibleStars.map((s, i) => (
        <g key={"star" + i}>
          <circle cx={s.x} cy={s.y} r={s.r * 2.5} fill="oklch(85% 0.16 80)" opacity=".25" />
          <circle cx={s.x} cy={s.y} r={s.r} fill="oklch(92% 0.16 90)" />
        </g>
      ))}

      {/* === Sun / clouds === */}
      {weather !== "cloudy" && (
        <g>
          <circle cx="270" cy="50" r="40" fill="url(#sun-glow)" />
          <circle cx="270" cy="50" r="13" fill="oklch(88% 0.18 80)" />
          <circle cx="266" cy="46" r="6"  fill="oklch(95% 0.18 90)" opacity=".7" />
        </g>
      )}
      {weather === "partly" && (
        <g opacity=".7">
          <ellipse cx="220" cy="55" rx="22" ry="9"  fill="white" />
          <ellipse cx="210" cy="50" rx="14" ry="8"  fill="white" />
          <ellipse cx="232" cy="52" rx="12" ry="7"  fill="white" />
        </g>
      )}
      {weather === "cloudy" && (
        <g opacity=".85">
          <ellipse cx="240" cy="50" rx="30" ry="11" fill="oklch(82% 0.01 220)" />
          <ellipse cx="225" cy="45" rx="18" ry="9"  fill="oklch(86% 0.01 220)" />
          <ellipse cx="255" cy="48" rx="16" ry="8"  fill="oklch(86% 0.01 220)" />
          <ellipse cx="70"  cy="45" rx="24" ry="10" fill="oklch(82% 0.01 220)" />
          <ellipse cx="55"  cy="40" rx="14" ry="7"  fill="oklch(86% 0.01 220)" />
        </g>
      )}

      {/* === Hills behind === */}
      <ellipse cx="40"  cy="260" rx="120" ry="40" fill="oklch(80% 0.10 145)" opacity=".55" />
      <ellipse cx="280" cy="265" rx="100" ry="35" fill="oklch(78% 0.10 145)" opacity=".55" />

      {/* === Ground === */}
      <rect x="0" y="245" width="320" height="75" fill="url(#ground)" />
      <ellipse cx="160" cy="295" rx="135" ry="11" fill="oklch(60% 0.10 95)" opacity=".4" />

      {/* === Grass tufts === */}
      {[30, 70, 105, 245, 280, 305].map(x => (
        <path key={x} d={`M${x} 290 q3 -8 6 0 q3 -9 6 0 q3 -7 5 0`} stroke="oklch(58% 0.13 145)" strokeWidth="1.5" fill="none" />
      ))}

      {/* === Trunk === */}
      <path d="M148 295 Q146 235 154 200 L166 200 Q174 235 172 295 Z" fill="url(#trunk)" />
      <path d="M152 270 Q155 250 152 230" stroke="oklch(32% 0.05 50)" strokeWidth="1.2" fill="none" />
      <path d="M163 260 Q165 245 168 235" stroke="oklch(32% 0.05 50)" strokeWidth="1" fill="none" />

      {/* === Main branches === */}
      <path d="M158 230 Q130 215 100 190" stroke="oklch(45% 0.06 50)" strokeWidth="7" fill="none" strokeLinecap="round" />
      <path d="M162 220 Q195 205 230 185" stroke="oklch(45% 0.06 50)" strokeWidth="7" fill="none" strokeLinecap="round" />
      <path d="M160 205 Q160 175 156 145" stroke="oklch(45% 0.06 50)" strokeWidth="6" fill="none" strokeLinecap="round" />
      <path d="M155 195 Q140 180 130 165" stroke="oklch(45% 0.06 50)" strokeWidth="4" fill="none" strokeLinecap="round" />
      <path d="M167 195 Q185 185 200 173" stroke="oklch(45% 0.06 50)" strokeWidth="4" fill="none" strokeLinecap="round" />

      {/* === Bird (if achievement) === */}
      {hasBird && (
        <g transform="translate(108, 178)">
          <ellipse cx="0" cy="0" rx="9" ry="5" fill="oklch(35% 0.10 25)" />
          <circle cx="7" cy="-2" r="3.5" fill="oklch(35% 0.10 25)" />
          <path d="M-2 -2 q3 -5 7 0 q-2 3 -7 0z" fill="oklch(50% 0.14 30)" />
          <circle cx="8" cy="-3" r=".7" fill="white" />
          <path d="M10.5 -1.5 l3 -.5 l-3 1z" fill="oklch(60% 0.18 70)" />
          <path d="M-9 -1 l3 -3 l3 0 l-2 2 z" fill="oklch(30% 0.10 25)" />
        </g>
      )}

      {/* === Crown (Gold/Platinum tier) === */}
      {hasCrown && (
        <g transform="translate(160, 55)">
          <path d="M-18 0 L-10 -14 L-4 -4 L0 -16 L4 -4 L10 -14 L18 0 L18 5 L-18 5 Z" fill="oklch(75% 0.16 80)" stroke="oklch(50% 0.18 60)" strokeWidth=".8" strokeLinejoin="round" />
          <circle cx="-10" cy="-14" r="2" fill="oklch(60% 0.20 20)" />
          <circle cx="0"   cy="-16" r="2.5" fill="oklch(65% 0.18 200)" />
          <circle cx="10"  cy="-14" r="2" fill="oklch(60% 0.18 320)" />
          <rect x="-18" y="2" width="36" height="3" fill="oklch(70% 0.18 75)" />
        </g>
      )}

      {/* === Leaves — back layer (depth) === */}
      {visibleLeaves.map((l, i) => (
        <circle key={"b" + i} cx={l.x + 2} cy={l.y + 3} r={l.r} fill="oklch(38% 0.13 145)" opacity=".45" />
      ))}
      {/* === Leaves — front === */}
      {visibleLeaves.map((l, i) => (
        <circle
          key={"f" + i}
          cx={l.x}
          cy={l.y}
          r={l.r}
          fill={`oklch(${60 + (i % 5)}% 0.16 ${130 + (i % 4) * 4})`}
        />
      ))}
      {/* highlights */}
      {visibleLeaves.map((l, i) =>
        i % 3 === 0 ? <circle key={"h" + i} cx={l.x - l.r * .4} cy={l.y - l.r * .4} r={l.r * .35} fill="oklch(82% 0.13 140)" opacity=".55" /> : null
      )}

      {/* === Wilted leaves (stale leads) === */}
      {visibleWilted.map((l, i) => (
        <g key={"w" + i}>
          <circle cx={l.x + 2} cy={l.y + 3} r={l.r} fill="oklch(50% 0.10 80)" opacity=".5" />
          <circle cx={l.x} cy={l.y} r={l.r} fill="oklch(72% 0.12 80)" />
          <path d={`M${l.x - l.r * .4} ${l.y - l.r * .3} q ${l.r * .4} ${l.r * .3} ${l.r * .8} 0`} stroke="oklch(45% 0.10 50)" strokeWidth="1" fill="none" opacity=".7" />
        </g>
      ))}

      {/* === Closed buds (unanswered SMS) === */}
      {visibleBuds.map((b, i) => (
        <g key={"bd" + i}>
          <circle cx={b.x} cy={b.y} r={b.r} fill="oklch(36% 0.10 145)" />
          <ellipse cx={b.x} cy={b.y - b.r * .35} rx={b.r * .55} ry={b.r * .35} fill="oklch(26% 0.06 145)" />
          <circle cx={b.x - b.r * .3} cy={b.y - b.r * .35} r={b.r * .2} fill="oklch(48% 0.10 145)" opacity=".6" />
        </g>
      ))}

      {/* === Lantern string (streak) === */}
      {lanternCount > 0 && (
        <>
          <path d={LANTERN_PATH} stroke="oklch(45% 0.06 50)" strokeWidth=".8" fill="none" opacity=".7" />
          {lanterns.map((l, i) => (
            <g key={"lt" + i}>
              <line x1={l.x} y1={l.y - 1} x2={l.x} y2={l.y + 1} stroke="oklch(40% 0.06 50)" strokeWidth=".8" />
              <circle cx={l.x} cy={l.y + 5} r="4.5" fill={`oklch(85% 0.18 ${l.hue})`} stroke={`oklch(60% 0.20 ${l.hue})`} strokeWidth=".8" />
              <circle cx={l.x} cy={l.y + 5} r="2.5" fill={`oklch(95% 0.18 ${l.hue})`} opacity=".7" />
            </g>
          ))}
        </>
      )}

      {/* === Fruits === */}
      {placedFruits.map((f, i) => <Fruit key={"fr" + i} {...f} />)}

      {/* === Fallen leaves (missed calls) === */}
      {visibleFallen.map((f, i) => (
        <g key={"fl" + i} transform={`rotate(${f.rot} ${f.x} ${f.y})`}>
          <ellipse cx={f.x} cy={f.y} rx={f.r} ry={f.r * .5} fill="oklch(55% 0.12 50)" />
          <ellipse cx={f.x - 1} cy={f.y - 1} rx={f.r * .6} ry={f.r * .25} fill="oklch(70% 0.10 50)" opacity=".6" />
          <path d={`M${f.x - f.r} ${f.y} L${f.x + f.r} ${f.y}`} stroke="oklch(40% 0.08 50)" strokeWidth=".8" />
        </g>
      ))}
    </svg>
  );
}

/* Individual fruit renderer based on type */
function Fruit({ type, x, y }) {
  if (type === "apple") {
    return (
      <g>
        <circle cx={x} cy={y} r="7" fill="url(#apple-grad)" />
        <ellipse cx={x - 2} cy={y - 3} rx="2" ry="1.5" fill="oklch(95% 0.10 30)" opacity=".7" />
        <path d={`M${x} ${y - 7} l 0 -3.5`} stroke="oklch(35% 0.05 100)" strokeWidth="1.5" strokeLinecap="round" />
        <path d={`M${x + .5} ${y - 9} q 2.5 -1.5 4.5 -.5`} stroke="oklch(55% 0.13 145)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </g>
    );
  }
  if (type === "golden") {
    return (
      <g>
        <circle cx={x} cy={y} r="8" fill="url(#golden-grad)" />
        <ellipse cx={x - 2} cy={y - 3} rx="2.5" ry="1.5" fill="oklch(98% 0.10 90)" opacity=".7" />
        <path d={`M${x} ${y - 8} l 0 -3.5`} stroke="oklch(35% 0.05 100)" strokeWidth="1.5" strokeLinecap="round" />
        <path d={`M${x + .5} ${y - 10} q 2.5 -1.5 4.5 -.5`} stroke="oklch(55% 0.13 145)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
        {/* sparkle */}
        <g transform={`translate(${x + 6} ${y - 6})`}>
          <path d="M0 -3 L1 -1 L3 0 L1 1 L0 3 L-1 1 L-3 0 L-1 -1 Z" fill="oklch(95% 0.12 90)" opacity=".95" />
        </g>
      </g>
    );
  }
  if (type === "plum") {
    return (
      <g>
        <ellipse cx={x} cy={y} rx="6" ry="7" fill="url(#plum-grad)" />
        <ellipse cx={x - 1.5} cy={y - 2.5} rx="1.5" ry="1.2" fill="oklch(85% 0.08 310)" opacity=".55" />
        <path d={`M${x} ${y - 7} l 0 -3`} stroke="oklch(35% 0.05 100)" strokeWidth="1.5" strokeLinecap="round" />
        <path d={`M${x} ${y - 6} q 0 -2 3 -2`} stroke="oklch(55% 0.13 145)" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </g>
    );
  }
  if (type === "lemon") {
    return (
      <g transform={`rotate(20 ${x} ${y})`}>
        <ellipse cx={x} cy={y} rx="5" ry="7" fill="url(#lemon-grad)" />
        <ellipse cx={x - 1.5} cy={y - 2.5} rx="1.3" ry="1" fill="oklch(98% 0.10 95)" opacity=".7" />
        <path d={`M${x - 5} ${y - 6} l -1 -1`} stroke="oklch(40% 0.05 100)" strokeWidth="1.2" strokeLinecap="round" />
        <path d={`M${x + 5} ${y + 6} l 1 1`} stroke="oklch(40% 0.05 100)" strokeWidth="1.2" strokeLinecap="round" />
      </g>
    );
  }
  if (type === "star") {
    /* 5-point star fruit — represents 5-star review */
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const ang = (Math.PI / 5) * i - Math.PI / 2;
      const r = i % 2 === 0 ? 7 : 3;
      pts.push((x + Math.cos(ang) * r).toFixed(1) + "," + (y + Math.sin(ang) * r).toFixed(1));
    }
    return (
      <g>
        <polygon points={pts.join(" ")} fill="oklch(80% 0.18 85)" stroke="oklch(60% 0.20 75)" strokeWidth=".6" />
        <circle cx={x - 1.5} cy={y - 2} r="1.4" fill="oklch(95% 0.15 90)" opacity=".7" />
      </g>
    );
  }
  if (type === "gem") {
    /* Diamond shape — represents NPS / high-value */
    return (
      <g>
        <polygon points={`${x},${y - 8} ${x + 6},${y - 2} ${x},${y + 7} ${x - 6},${y - 2}`} fill="url(#gem-grad)" stroke="oklch(40% 0.18 230)" strokeWidth=".6" />
        <polygon points={`${x},${y - 8} ${x + 6},${y - 2} ${x},${y}`} fill="oklch(82% 0.14 200)" opacity=".55" />
        <polygon points={`${x},${y - 8} ${x - 6},${y - 2} ${x},${y}`} fill="oklch(70% 0.16 230)" opacity=".55" />
      </g>
    );
  }
  return null;
}

window.GrowthTree = GrowthTree;
