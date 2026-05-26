/* global React */

/* ================================================================
   PageHelp — переиспользуемый «?»-tooltip рядом с заголовком
   страницы. Tony 2026-05-26: «Сделай сначала краткое ниже подробное
   описание при нажатии на ?». Workflow:
     1. Под заголовком всегда видна короткая подпись (subtitle) — её
        каждая страница рендерит сама (так как subtitle часто содержит
        динамические метрики типа «2,871 contacts in window»).
     2. Рядом с h1 — маленькая кружочная «?»-кнопка. Клик → разворачивается
        панель с детальным описанием: что показывает страница, откуда
        данные, как читать, какие фильтры доступны.
     3. Состояние «открыто/закрыто» НЕ персистентное — это reference panel,
        пользователь обычно открыл-почитал-закрыл.

   Использование:
     <h1 className="title">Marketing <PageHelp pageId="marketing" /></h1>

   Чтобы добавить описание для новой страницы — добавь запись в
   PAGE_DOCS ниже. detail может быть строкой ИЛИ JSX (для списков,
   ссылок и т.д.).
   ================================================================ */

window.PAGE_DOCS = {
  marketing: {
    title: "Channel mix",
    detail: (
      <>
        <p><b>What this page shows.</b> Single source of truth for marketing performance: how much each acquisition channel costs, how many leads it brings, and how many of those convert into signed leases.</p>
        <p><b>Where the data comes from.</b></p>
        <ul>
          <li><b>HubSpot CRM</b> — every contact's lifecycle stage (lead → MQL → SQL → opportunity → customer) and the original UTM source/medium that brought them in.</li>
          <li><b>Google Ads API</b> — daily spend, clicks, impressions, conversions per campaign (pulled by the Apps Script every hour).</li>
          <li><b>Meta Ads API</b> — same metrics for Facebook + Instagram accounts.</li>
          <li><b>TikTok Ads API</b> — same for TikTok ad accounts.</li>
          <li><b>Floor-map state</b> — actually signed leases attributed back to the channel that sourced the tenant. Drives the «Contracts» column + MRR uplift.</li>
        </ul>
        <p><b>How to read it.</b></p>
        <ul>
          <li><b>Pipeline funnel</b> (top) — HubSpot funnel: leads → qualified → opportunity → customer for the selected window.</li>
          <li><b>Channel mix table</b> (middle) — leads per channel grouped by group: paid search / paid social / organic / direct / offline.</li>
          <li><b>Ad spend × HubSpot conversions</b> (bottom) — joined view: spend + clicks from ad platforms, leads + contracts from HubSpot + floor-map. CPL = cost ÷ qualified leads; CAC = cost ÷ signed leases.</li>
        </ul>
        <p><b>Toggles you can change.</b></p>
        <ul>
          <li><b>Date window</b> — Today / Yesterday / 7d / 30d / 90d / MTD / Custom. Default = Today.</li>
          <li><b>Quality leads only (MQL+)</b> — strips junk Facebook Lead Ad submissions (recommended ON). Affects CPL.</li>
        </ul>
        <p><b>What to do with this.</b> Find the channel with the lowest CAC and highest contract count → that's your next budget bump. Channel with high spend but zero qualified leads → pause or audit creative.</p>
      </>
    ),
  },
};

window.PageHelp = function PageHelp({ pageId, inline }) {
  const [open, setOpen] = React.useState(false);
  const doc = window.PAGE_DOCS && window.PAGE_DOCS[pageId];
  if (!doc) return null;

  const buttonStyle = {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: 20, height: 20, borderRadius: 999,
    background: open ? "var(--accent)" : "var(--bg-2, #f1f5f9)",
    color: open ? "#fff" : "var(--ink-2, #475569)",
    border: "1px solid " + (open ? "var(--accent)" : "var(--border, #e2e8f0)"),
    fontSize: 11.5, fontWeight: 700, lineHeight: 1,
    cursor: "pointer", verticalAlign: "middle",
    marginLeft: 8,
    transition: "background 120ms, color 120ms, transform 120ms",
    fontFamily: "inherit",
  };

  return (
    <>
      <button
        type="button"
        title={open ? "Hide description" : "Show page description"}
        aria-expanded={open}
        aria-label={"Help for " + (doc.title || pageId)}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        style={buttonStyle}
      >
        ?
      </button>
      {open && (
        <div
          className="page-help-panel"
          style={{
            display: "block",
            marginTop: 12, marginBottom: 4,
            padding: "14px 16px",
            background: "var(--bg-2, #f8fafc)",
            border: "1px solid var(--border, #e2e8f0)",
            borderLeft: "3px solid var(--accent, #6366f1)",
            borderRadius: 8,
            fontSize: 13, lineHeight: 1.55,
            color: "var(--ink-2, #475569)",
            maxWidth: 880,
          }}
        >
          <style>{`
            .page-help-panel p { margin: 0 0 8px; }
            .page-help-panel p:last-child { margin-bottom: 0; }
            .page-help-panel ul { margin: 0 0 10px; padding-left: 20px; }
            .page-help-panel ul:last-child { margin-bottom: 0; }
            .page-help-panel li { margin-bottom: 4px; }
            .page-help-panel b { color: var(--ink-1, #18181b); font-weight: 700; }
          `}</style>
          {doc.detail}
          <div style={{
            marginTop: 12, paddingTop: 10,
            borderTop: "1px dashed var(--border, #e2e8f0)",
            display: "flex", justifyContent: "flex-end",
          }}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                fontSize: 11.5, fontWeight: 600,
                color: "var(--muted, #94a3b8)",
                background: "transparent", border: "none", cursor: "pointer",
                padding: "2px 6px",
              }}
            >
              Close ×
            </button>
          </div>
        </div>
      )}
    </>
  );
};
