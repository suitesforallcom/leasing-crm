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

// How many days back to pull. 30 covers month-to-date views for ops.
var DAYS_BACK = 30;

// ============ SCRIPT ============

function main() {
  var endMs = Date.now();
  var startMs = endMs - DAYS_BACK * 86400 * 1000;
  var startDate = _fmtDate(new Date(startMs));
  var endDate = _fmtDate(new Date(endMs));

  Logger.log('Pulse spend ingest — fetching ' + startDate + ' to ' + endDate);

  // GAQL — campaign-level rollup over the window. Currency = account default
  // (USD for SuitesForAll). Cost is in micros (1 unit = 1/1,000,000 USD)
  // and we convert below.
  var query =
    'SELECT ' +
      'campaign.id, ' +
      'campaign.name, ' +
      'campaign.status, ' +
      'metrics.cost_micros, ' +
      'metrics.clicks, ' +
      'metrics.impressions, ' +
      'metrics.conversions, ' +
      'metrics.ctr, ' +
      'metrics.average_cpc ' +
    'FROM campaign ' +
    'WHERE segments.date BETWEEN "' + startDate + '" AND "' + endDate + '"';

  var report = AdsApp.report(query);
  var rows = report.rows();
  var campaigns = [];
  var totals = { cost: 0, clicks: 0, impressions: 0, conversions: 0 };

  while (rows.hasNext()) {
    var r = rows.next();
    var costMicros = Number(r['metrics.cost_micros']) || 0;
    var cost = costMicros / 1000000;
    var clicks = Number(r['metrics.clicks']) || 0;
    var impressions = Number(r['metrics.impressions']) || 0;
    var conversions = Number(r['metrics.conversions']) || 0;
    var ctr = Number(r['metrics.ctr']) || 0;
    var avgCpcMicros = Number(r['metrics.average_cpc']) || 0;
    campaigns.push({
      id: String(r['campaign.id'] || ''),
      name: String(r['campaign.name'] || '(unnamed)'),
      status: String(r['campaign.status'] || ''),
      cost: cost,
      clicks: clicks,
      impressions: impressions,
      conversions: conversions,
      ctr: ctr,
      avgCpc: avgCpcMicros / 1000000,
    });
    totals.cost += cost;
    totals.clicks += clicks;
    totals.impressions += impressions;
    totals.conversions += conversions;
  }

  Logger.log('  Aggregated ' + campaigns.length + ' campaigns');
  Logger.log('  Totals: $' + totals.cost.toFixed(2) + ' / ' + totals.clicks +
             ' clicks / ' + totals.impressions + ' impressions / ' +
             totals.conversions + ' conversions');

  var customerId = AdsApp.currentAccount().getCustomerId();

  var payload = {
    source: 'google-ads',
    accountId: customerId,
    fetchedAt: new Date().toISOString(),
    dateRange: { start: startDate, end: endDate },
    campaigns: campaigns,
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
