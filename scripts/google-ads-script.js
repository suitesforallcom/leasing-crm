/**
 * Google Ads Script — SuitesForAll spend ingest into Pulse.
 *
 * WHAT THIS DOES
 * --------------
 * Once an hour (set via the schedule below), this script queries the
 * Google Ads account it's installed in for the last 30 days of campaign
 * performance (cost, clicks, impressions, conversions) and POSTs the
 * data to the Pulse Cloud Function endpoint. Pulse's Marketing page
 * displays the spend joined with HubSpot lead source data to compute
 * CPL / CPT / CAC / ROAS per channel.
 *
 * INSTALLATION (one-time, ~3 minutes)
 * -----------------------------------
 * 1. Sign in to Google Ads as the account you want to track
 *    (e.g. an@kiwi-rentals.com → SuitesForAll 215-096-1449)
 * 2. Top right gear icon → Tools → Bulk actions → Scripts
 *    Or directly: https://ads.google.com/aw/bulk/scripts
 * 3. Click the (+) blue button → «New script»
 * 4. Paste this entire file (replace the «// Your code here» stub)
 * 5. Click «Authorize» (top right) → choose your Google account → Allow
 *    (the script reads campaign reports — no spend / no writes)
 * 6. Click «Preview» first to verify it works (you'll see logs + the
 *    response from Pulse). Expected: «✓ Pulse ingest OK: <N> campaigns»
 * 7. Click «Save» (give it a name like «Pulse spend ingest»)
 * 8. From the scripts list → kebab menu (⋮) on this script →
 *    «Set frequency» → «Hourly» → Save
 *
 * That's it. Pulse will see fresh spend data within an hour.
 *
 * To verify it's running: Pulse → Marketing → bottom of page
 * («Last ingest: <timestamp>»). Or check this script's «Logs» tab.
 *
 * IF NEEDED — manual run: Scripts → ⋮ → «Run»
 *
 * Last updated: 2026-05-24
 */

// ============ CONFIG ============

// Pulse ingest endpoint. Cloud Function deployed under suitesforall.
var INGEST_URL = 'https://us-central1-suitesforall.cloudfunctions.net/marketingIngest';

// Shared secret — must match the MARKETING_INGEST_SECRET secret in
// Firebase Secret Manager. Anyone with this token can post spend data
// to Pulse, so don't share or commit it elsewhere. If rotated, ping
// engineering to update both ends.
var SHARED_SECRET = 'fb0e31f26cb8e1c08f02e51c7f2a2bb69017ed0cecbd9cac1818e7a870af204d';

// How many days back to pull. 90 gives the Marketing page enough history
// for «Last 7d / 30d / 90d / Custom range» selectors without re-running
// the script. Daily-granular data (segments.date in GAQL below) lets
// Pulse aggregate to any window client-side.
var DAYS_BACK = 90;

// ============ SCRIPT ============

function main() {
  var endMs = Date.now();
  var startMs = endMs - DAYS_BACK * 86400 * 1000;
  var startDate = _fmtDate(new Date(startMs));
  var endDate = _fmtDate(new Date(endMs));

  Logger.log('Pulse spend ingest — fetching ' + startDate + ' to ' + endDate);

  // GAQL — daily per-campaign rows over the 90-day window. segments.date
  // splits each campaign into 1 row per day, which Pulse aggregates
  // client-side to support arbitrary date-range selectors (7d, 30d, 90d,
  // custom). Cost is in micros (1 unit = 1/1,000,000 USD) → convert below.
  var query =
    'SELECT ' +
      'campaign.id, ' +
      'campaign.name, ' +
      'campaign.status, ' +
      'segments.date, ' +
      'metrics.cost_micros, ' +
      'metrics.clicks, ' +
      'metrics.impressions, ' +
      'metrics.conversions ' +
    'FROM campaign ' +
    'WHERE segments.date BETWEEN "' + startDate + '" AND "' + endDate + '"';

  var report = AdsApp.report(query);
  var rows = report.rows();
  // daily — flat list of per-campaign-per-day rows. Pulse filters by date
  // window before aggregating. With 30 campaigns × 90 days = 2700 rows
  // (~210 KB serialized) — well under Firestore 1MB cap.
  var daily = [];
  // campaignsMeta — name + status lookup, indexed by id, since segments
  // duplicate name/status across days.
  var campaignsMeta = {};
  var totals = { cost: 0, clicks: 0, impressions: 0, conversions: 0 };

  while (rows.hasNext()) {
    var r = rows.next();
    var costMicros = Number(r['metrics.cost_micros']) || 0;
    var cost = costMicros / 1000000;
    var clicks = Number(r['metrics.clicks']) || 0;
    var impressions = Number(r['metrics.impressions']) || 0;
    var conversions = Number(r['metrics.conversions']) || 0;
    var id = String(r['campaign.id'] || '');
    if (!campaignsMeta[id]) {
      campaignsMeta[id] = {
        id: id,
        name: String(r['campaign.name'] || '(unnamed)'),
        status: String(r['campaign.status'] || ''),
      };
    }
    daily.push({
      id: id,
      date: String(r['segments.date'] || ''),
      cost: cost,
      clicks: clicks,
      impressions: impressions,
      conversions: conversions,
    });
    totals.cost += cost;
    totals.clicks += clicks;
    totals.impressions += impressions;
    totals.conversions += conversions;
  }

  Logger.log('  ' + daily.length + ' daily rows across ' +
             Object.keys(campaignsMeta).length + ' campaigns');
  Logger.log('  Totals (' + DAYS_BACK + 'd): $' + totals.cost.toFixed(2) +
             ' / ' + totals.clicks + ' clicks / ' + totals.impressions +
             ' impressions / ' + totals.conversions + ' conversions');

  var customerId = AdsApp.currentAccount().getCustomerId();

  // Build campaigns array (compact meta only, daily breakdown separately)
  // so the marketingIngest CF's existing «trim to 200 campaigns» logic
  // keeps working — we don't actually trim daily rows since they're not
  // user-facing 1-by-1.
  var campaigns = [];
  for (var cid in campaignsMeta) {
    if (campaignsMeta.hasOwnProperty(cid)) campaigns.push(campaignsMeta[cid]);
  }

  var payload = {
    source: 'google-ads',
    accountId: customerId,
    fetchedAt: new Date().toISOString(),
    dateRange: { start: startDate, end: endDate },
    daysBack: DAYS_BACK,
    campaigns: campaigns,    // [{id, name, status}]
    daily: daily,            // [{id, date, cost, clicks, impressions, conversions}]
    totals: totals,
  };

  var resp = UrlFetchApp.fetch(INGEST_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shared-Secret': SHARED_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();

  if (code >= 200 && code < 300) {
    Logger.log('✓ Pulse ingest OK (HTTP ' + code + '): ' + body);
  } else {
    Logger.log('✗ Pulse ingest FAILED (HTTP ' + code + '): ' + body);
    throw new Error('Pulse ingest failed with HTTP ' + code);
  }
}

function _fmtDate(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
