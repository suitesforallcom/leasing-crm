/**
 * Google Ads Script — SuitesForAll spend ingest into Pulse.
 *
 * WHAT THIS DOES
 * --------------
 * Once an hour (set via the schedule below), this script queries the
 * Google Ads account it's installed in for the last 90 days and POSTs
 * TWO data sets to Pulse Cloud Functions:
 *
 *   1) Campaign-level rollup → marketingIngest (powers Marketing tab
 *      channel-mix KPIs: CPL / CPT / CAC / ROAS).
 *   2) Ad-level + creative → marketingAdsIngest (powers Top Ads tab
 *      alongside Meta + TikTok creative leaderboard).
 *
 * Both POSTs are independent — if one fails the other still runs.
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
 *    (the script reads campaign + ad reports — no spend / no writes)
 * 6. Click «Preview» first to verify it works (you'll see logs + the
 *    response from Pulse). Expected: «✓ Pulse ingest OK: <N> campaigns»
 *    and «✓ Pulse ads ingest OK: <N> ads»
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
 * Last updated: 2026-05-25 (added ad-level pull → Top Ads tab)
 */

// ============ CONFIG ============

// Pulse ingest endpoint. Cloud Function deployed under suitesforall.
var INGEST_URL = 'https://us-central1-suitesforall.cloudfunctions.net/marketingIngest';

// Ad-level endpoint (Phase H, 2026-05-25). Same auth (X-Shared-Secret),
// different schema — see marketingAdsIngest in functions/marketing-ingest.js.
var ADS_INGEST_URL = 'https://us-central1-suitesforall.cloudfunctions.net/marketingAdsIngest';

// Dimension-level endpoint (Phase H, 2026-05-25). Generic per-dimension
// ingest (Keywords / Search Terms / Geo / Devices). Same auth header;
// source field на payload'е разруливает таргет-коллекцию.
// См. marketingDimensionIngest в functions/marketing-ingest.js.
var DIMENSION_INGEST_URL = 'https://us-central1-suitesforall.cloudfunctions.net/marketingDimensionIngest';

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
    // Не throw — ad-level pull ниже должен попытаться даже если campaign-level
    // упал (они независимы).
    Logger.log('  (continuing to ad-level pull anyway)');
  }

  // ============ AD-LEVEL PULL (Phase H, 2026-05-25) ============
  // Отдельный POST в marketingAdsIngest с per-ad daily spend + creative
  // metadata. Питает Top Ads табу (cross-platform creative leaderboard).
  try {
    _runAdLevelIngest(customerId, startDate, endDate);
  } catch (e) {
    Logger.log('✗ Ad-level ingest threw: ' + (e && e.message ? e.message : e));
  }

  // ============ DIMENSION PULLS (Phase H, 2026-05-25) ============
  // 4 параллельных GAQL-запроса для страниц Pulse Keywords / Search Terms /
  // Geo / Devices. Каждый — независимый POST в marketingDimensionIngest;
  // одна ошибка не валит другие.
  try {
    _runDimensionIngests(customerId, startDate, endDate);
  } catch (e) {
    Logger.log('✗ Dimension ingests threw: ' + (e && e.message ? e.message : e));
  }
}

// Ad-level ingest — pulls per-ad daily metrics + creative metadata via
// GAQL against ad_group_ad resource. POSTs to marketingAdsIngest CF
// which writes into the marketing_ads subcollection alongside Meta + TikTok.
function _runAdLevelIngest(customerId, startDate, endDate) {
  Logger.log('Pulse ad-level ingest — fetching ' + startDate + ' to ' + endDate);

  // GAQL — per-ad-per-day. Fields cover: ID/name/type/status, final URLs,
  // creative content (RSA headlines/descriptions, image url, video asset),
  // ad group + campaign context, daily cost/clicks/impressions/conversions.
  // RSA headlines come back as repeated AdTextAsset structs which the
  // script's row API exposes as a JSON-ish string we'll parse on the
  // server side. Image / Video ads have simpler URL fields.
  var query =
    'SELECT ' +
      'ad_group_ad.ad.id, ' +
      'ad_group_ad.ad.name, ' +
      'ad_group_ad.ad.type, ' +
      'ad_group_ad.status, ' +
      'ad_group_ad.ad.final_urls, ' +
      'ad_group_ad.ad.responsive_search_ad.headlines, ' +
      'ad_group_ad.ad.responsive_search_ad.descriptions, ' +
      'ad_group_ad.ad.image_ad.image_url, ' +
      'ad_group_ad.ad.video_ad.video.asset, ' +
      'ad_group.id, ' +
      'ad_group.name, ' +
      'campaign.id, ' +
      'campaign.name, ' +
      'campaign.status, ' +
      'campaign.advertising_channel_type, ' +
      'segments.date, ' +
      'metrics.cost_micros, ' +
      'metrics.clicks, ' +
      'metrics.impressions, ' +
      'metrics.conversions ' +
    'FROM ad_group_ad ' +
    'WHERE segments.date BETWEEN "' + startDate + '" AND "' + endDate + '" ' +
    '  AND ad_group_ad.status != "REMOVED"';

  var report;
  try {
    report = AdsApp.report(query);
  } catch (e) {
    Logger.log('✗ Ad-level GAQL failed: ' + (e && e.message ? e.message : e));
    return;
  }
  var rows = report.rows();

  // adsMap — keyed by ad ID. Each entry accumulates daily metrics + holds
  // creative meta (copied from first row since meta is stable across days).
  var adsMap = {};
  var totals = { cost: 0, clicks: 0, impressions: 0, conversions: 0 };

  while (rows.hasNext()) {
    var r = rows.next();
    var adId = String(r['ad_group_ad.ad.id'] || '');
    if (!adId) continue;

    var costMicros = Number(r['metrics.cost_micros']) || 0;
    var cost = costMicros / 1000000;
    var clicks = Number(r['metrics.clicks']) || 0;
    var impressions = Number(r['metrics.impressions']) || 0;
    var conversions = Number(r['metrics.conversions']) || 0;
    // metrics.video_views недоступен в Google Ads Scripts GAQL для
    // ad_group_ad (UNRECOGNIZED_FIELD) — video views остаются 0.
    // Если в будущем понадобятся — придётся либо через Google Ads API
    // server-side, либо через отдельный отчёт по video_performance_view.

    if (!adsMap[adId]) {
      // Распаковка repeated fields из GAQL row. Apps Script может вернуть
      // их как stringified JSON-array, как уже-массив объектов, как один
      // объект, либо как comma-separated string — _splitGaqlArray() всё
      // нормализует к массиву строк.
      var rawHeadlines = r['ad_group_ad.ad.responsive_search_ad.headlines'];
      var headlines = _splitGaqlArray(rawHeadlines);
      var descriptions = _splitGaqlArray(r['ad_group_ad.ad.responsive_search_ad.descriptions']);
      var finalUrls = _splitGaqlArray(r['ad_group_ad.ad.final_urls']);
      // Одноразовый дебаг — на первом ad'е залогируем тип сырого поля,
      // чтобы при будущих фейлах сразу видеть формат от Apps Script.
      if (Object.keys(adsMap).length === 0) {
        var sample = rawHeadlines == null ? 'null'
                   : Array.isArray(rawHeadlines) ? 'array(len=' + rawHeadlines.length + ',first=' + JSON.stringify(rawHeadlines[0]).slice(0, 80) + ')'
                   : typeof rawHeadlines === 'object' ? 'object(' + JSON.stringify(rawHeadlines).slice(0, 80) + ')'
                   : 'string(' + String(rawHeadlines).slice(0, 80) + ')';
        Logger.log('  [debug] first RSA headlines raw = ' + sample +
                   ' → parsed ' + headlines.length + ' items');
      }
      var imageUrl = String(r['ad_group_ad.ad.image_ad.image_url'] || '');
      var videoAsset = String(r['ad_group_ad.ad.video_ad.video.asset'] || '');
      // Extract YouTube videoId from the asset resource name — last segment
      // typically holds it (or the original ID). Server enriches into
      // embed / thumb URLs.
      var youtubeVideoId = '';
      if (videoAsset) {
        var parts = videoAsset.split('/');
        youtubeVideoId = parts[parts.length - 1] || '';
      }

      adsMap[adId] = {
        adId: adId,
        adName: String(r['ad_group_ad.ad.name'] || ''),
        adType: String(r['ad_group_ad.ad.type'] || ''),
        adStatus: String(r['ad_group_ad.status'] || ''),
        finalUrls: finalUrls,
        headlines: headlines,
        descriptions: descriptions,
        imageUrl: imageUrl,
        youtubeVideoId: youtubeVideoId,
        campaignId: String(r['campaign.id'] || ''),
        campaignName: String(r['campaign.name'] || ''),
        campaignStatus: String(r['campaign.status'] || ''),
        campaignChannel: String(r['campaign.advertising_channel_type'] || ''),
        adGroupId: String(r['ad_group.id'] || ''),
        adGroupName: String(r['ad_group.name'] || ''),
        daily: [],
      };
    }

    adsMap[adId].daily.push({
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

  var ads = [];
  for (var k in adsMap) {
    if (adsMap.hasOwnProperty(k)) ads.push(adsMap[k]);
  }

  Logger.log('  ' + ads.length + ' ads found, ' +
             '$' + totals.cost.toFixed(2) + ' total spend');

  if (ads.length === 0) {
    Logger.log('  (no ads to ingest — skipping POST)');
    return;
  }

  var customerName = '';
  try {
    customerName = AdsApp.currentAccount().getName() || '';
  } catch (e) { /* optional */ }

  var currencyCode = 'USD';
  try {
    currencyCode = AdsApp.currentAccount().getCurrencyCode() || 'USD';
  } catch (e) { /* optional */ }

  var payload = {
    source: 'google-ads',
    customerId: customerId,
    customerName: customerName,
    currency: currencyCode,
    fetchedAt: new Date().toISOString(),
    dateRange: { start: startDate, end: endDate },
    daysBack: DAYS_BACK,
    ads: ads,
    totals: totals,
  };

  var resp = UrlFetchApp.fetch(ADS_INGEST_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shared-Secret': SHARED_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var code = resp.getResponseCode();
  var body = resp.getContentText();

  if (code >= 200 && code < 300) {
    Logger.log('✓ Pulse ads ingest OK (HTTP ' + code + '): ' + body);
  } else {
    Logger.log('✗ Pulse ads ingest FAILED (HTTP ' + code + '): ' + body);
  }
}

// Нормализует GAQL repeated-field к массиву строк.
// Apps Script для repeated struct-полей (RSA headlines/descriptions) может
// вернуть ЛЮБОЕ из:
//   • стрингифицированный JSON «[{"text":"Best","asset":"...",…},…]»
//   • массив объектов напрямую [{text:"Best",…},…] (для некоторых версий API)
//   • одиночный объект {text:"Best",…}
//   • обычную строку с запятыми «Best, Hot, Premium» (final_urls)
//   • «[object Object],[object Object]» — если код раньше делал String(obj)
//     наивно (мусор; фильтруем).
// Возвращает чистый массив строк; всегда без объектов и без «[object Object]».
function _splitGaqlArray(raw) {
  if (raw == null || raw === '') return [];

  // Случай 1: уже массив (Apps Script сам распаковал)
  if (Array.isArray(raw)) {
    return raw.map(_extractAssetText)
              .filter(function (x) { return x.length > 0 && x.indexOf('[object Object]') < 0; });
  }

  // Случай 2: одиночный объект
  if (typeof raw === 'object') {
    var t = _extractAssetText(raw);
    return t && t.indexOf('[object Object]') < 0 ? [t] : [];
  }

  var s = String(raw).trim();
  if (!s || s === '--') return [];

  // Случай 3: stringified JSON-массив
  if (s.charAt(0) === '[') {
    try {
      var arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return arr.map(_extractAssetText)
                  .filter(function (x) { return x.length > 0 && x.indexOf('[object Object]') < 0; });
      }
    } catch (e) { /* fall through */ }
  }

  // Случай 4: comma-separated string (final_urls обычно так)
  return s.split(',').map(function (x) { return x.trim(); })
    .filter(function (x) { return x.length > 0 && x.indexOf('[object Object]') < 0; });
}

// Извлекает текст из AdTextAsset-подобного объекта.
// Возможные ключи: text, asset, value, label.
function _extractAssetText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    return String(x.text || x.asset || x.value || x.label || '');
  }
  return String(x);
}

function _fmtDate(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// ============ DIMENSION INGESTS (Phase H, 2026-05-25) ============
//
// Каждая функция:
//   1) Запускает свой GAQL запрос (keyword_view / search_term_view /
//      geographic_view / campaign + segments.device).
//   2) Группирует строки по dimension-ключу, в каждой накапливает daily[].
//   3) POST-ит payload {source, customerId, …, rows: [...]} в
//      marketingDimensionIngest. Сервер пишет в подколлекцию, считает totals.
//
// Все 4 — независимы; одна упала — другие всё равно запускаются.

function _runDimensionIngests(customerId, startDate, endDate) {
  var customerName = '';
  try { customerName = AdsApp.currentAccount().getName() || ''; } catch (e) { /* optional */ }
  var currency = 'USD';
  try { currency = AdsApp.currentAccount().getCurrencyCode() || 'USD'; } catch (e) { /* optional */ }

  var common = {
    customerId: customerId,
    customerName: customerName,
    currency: currency,
    startDate: startDate,
    endDate: endDate,
  };

  try { _runKeywordIngest(common); }
  catch (e) { Logger.log('✗ keyword ingest threw: ' + (e && e.message ? e.message : e)); }
  try { _runSearchTermIngest(common); }
  catch (e) { Logger.log('✗ search-term ingest threw: ' + (e && e.message ? e.message : e)); }
  try { _runGeoIngest(common); }
  catch (e) { Logger.log('✗ geo ingest threw: ' + (e && e.message ? e.message : e)); }
  try { _runDeviceIngest(common); }
  catch (e) { Logger.log('✗ device ingest threw: ' + (e && e.message ? e.message : e)); }
}

// Generic POST для всех 4 dimension'ов. source-string определяет коллекцию.
function _postDimension(source, common, rowsOut) {
  if (!rowsOut || rowsOut.length === 0) {
    Logger.log('  (no rows for ' + source + ' — skipping POST)');
    return;
  }
  var payload = {
    source: source,
    customerId: common.customerId,
    customerName: common.customerName,
    currency: common.currency,
    fetchedAt: new Date().toISOString(),
    dateRange: { start: common.startDate, end: common.endDate },
    daysBack: DAYS_BACK,
    rows: rowsOut,
  };
  var resp = UrlFetchApp.fetch(DIMENSION_INGEST_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shared-Secret': SHARED_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code >= 200 && code < 300) {
    Logger.log('✓ Pulse ' + source + ' ingest OK (HTTP ' + code + '): ' + String(body).slice(0, 200));
  } else {
    Logger.log('✗ Pulse ' + source + ' ingest FAILED (HTTP ' + code + '): ' + body);
  }
}

function _runKeywordIngest(common) {
  Logger.log('Pulse keyword ingest — ' + common.startDate + ' to ' + common.endDate);
  var query =
    'SELECT ' +
      'ad_group_criterion.criterion_id, ' +
      'ad_group_criterion.keyword.text, ' +
      'ad_group_criterion.keyword.match_type, ' +
      'ad_group_criterion.status, ' +
      'ad_group_criterion.quality_info.quality_score, ' +
      'ad_group.id, ' +
      'ad_group.name, ' +
      'ad_group.status, ' +
      'campaign.id, ' +
      'campaign.name, ' +
      'campaign.status, ' +
      'segments.date, ' +
      'metrics.cost_micros, ' +
      'metrics.clicks, ' +
      'metrics.impressions, ' +
      'metrics.conversions ' +
    'FROM keyword_view ' +
    'WHERE segments.date BETWEEN "' + common.startDate + '" AND "' + common.endDate + '" ' +
    '  AND ad_group_criterion.status != "REMOVED"';

  var rowsIter;
  try { rowsIter = AdsApp.report(query).rows(); }
  catch (e) { Logger.log('✗ keyword GAQL failed: ' + (e && e.message ? e.message : e)); return; }

  var byKw = {};
  while (rowsIter.hasNext()) {
    var r = rowsIter.next();
    var cid = String(r['ad_group_criterion.criterion_id'] || '');
    if (!cid) continue;
    var key = cid + '_' + String(r['ad_group.id'] || '');
    if (!byKw[key]) {
      byKw[key] = {
        criterionId: cid,
        id: cid,
        text: String(r['ad_group_criterion.keyword.text'] || ''),
        matchType: String(r['ad_group_criterion.keyword.match_type'] || ''),
        status: String(r['ad_group_criterion.status'] || ''),
        qualityScore: Number(r['ad_group_criterion.quality_info.quality_score']) || null,
        campaignId: String(r['campaign.id'] || ''),
        campaignName: String(r['campaign.name'] || ''),
        campaignStatus: String(r['campaign.status'] || ''),
        adGroupId: String(r['ad_group.id'] || ''),
        adGroupName: String(r['ad_group.name'] || ''),
        adGroupStatus: String(r['ad_group.status'] || ''),
        daily: [],
      };
    }
    byKw[key].daily.push({
      date: String(r['segments.date'] || ''),
      cost: (Number(r['metrics.cost_micros']) || 0) / 1000000,
      clicks: Number(r['metrics.clicks']) || 0,
      impressions: Number(r['metrics.impressions']) || 0,
      conversions: Number(r['metrics.conversions']) || 0,
    });
  }

  var arr = [];
  for (var k in byKw) { if (byKw.hasOwnProperty(k)) arr.push(byKw[k]); }
  Logger.log('  ' + arr.length + ' keywords');
  _postDimension('google-ads-keywords', common, arr);
}

function _runSearchTermIngest(common) {
  Logger.log('Pulse search-term ingest — ' + common.startDate + ' to ' + common.endDate);
  var query =
    'SELECT ' +
      'search_term_view.search_term, ' +
      'search_term_view.status, ' +
      'segments.search_term_match_type, ' +
      'ad_group.id, ' +
      'ad_group.name, ' +
      'campaign.id, ' +
      'campaign.name, ' +
      'segments.date, ' +
      'metrics.cost_micros, ' +
      'metrics.clicks, ' +
      'metrics.impressions, ' +
      'metrics.conversions ' +
    'FROM search_term_view ' +
    'WHERE segments.date BETWEEN "' + common.startDate + '" AND "' + common.endDate + '"';

  var rowsIter;
  try { rowsIter = AdsApp.report(query).rows(); }
  catch (e) { Logger.log('✗ search-term GAQL failed: ' + (e && e.message ? e.message : e)); return; }

  var bySt = {};
  while (rowsIter.hasNext()) {
    var r = rowsIter.next();
    var text = String(r['search_term_view.search_term'] || '').trim();
    if (!text) continue;
    var adGroupId = String(r['ad_group.id'] || '');
    var key = adGroupId + '|' + text.toLowerCase();
    if (!bySt[key]) {
      bySt[key] = {
        text: text,
        status: String(r['search_term_view.status'] || ''),
        matchType: String(r['segments.search_term_match_type'] || ''),
        adGroupId: adGroupId,
        adGroupName: String(r['ad_group.name'] || ''),
        campaignId: String(r['campaign.id'] || ''),
        campaignName: String(r['campaign.name'] || ''),
        daily: [],
      };
    }
    bySt[key].daily.push({
      date: String(r['segments.date'] || ''),
      cost: (Number(r['metrics.cost_micros']) || 0) / 1000000,
      clicks: Number(r['metrics.clicks']) || 0,
      impressions: Number(r['metrics.impressions']) || 0,
      conversions: Number(r['metrics.conversions']) || 0,
    });
  }

  var arr = [];
  for (var k in bySt) { if (bySt.hasOwnProperty(k)) arr.push(bySt[k]); }
  Logger.log('  ' + arr.length + ' unique search terms');
  _postDimension('google-ads-search-terms', common, arr);
}

function _runGeoIngest(common) {
  Logger.log('Pulse geo ingest — ' + common.startDate + ' to ' + common.endDate);
  // Country-level breakdown через geographic_view. country_criterion_id —
  // GeoTargetConstant.id страны пользователя. Дальше делаем второй запрос
  // к geo_target_constant для перевода id'ов в имена ("United States" и т.п.).
  var query =
    'SELECT ' +
      'geographic_view.country_criterion_id, ' +
      'geographic_view.location_type, ' +
      'campaign.id, ' +
      'campaign.name, ' +
      'segments.date, ' +
      'metrics.cost_micros, ' +
      'metrics.clicks, ' +
      'metrics.impressions, ' +
      'metrics.conversions ' +
    'FROM geographic_view ' +
    'WHERE segments.date BETWEEN "' + common.startDate + '" AND "' + common.endDate + '"';

  var rowsIter;
  try { rowsIter = AdsApp.report(query).rows(); }
  catch (e) { Logger.log('✗ geo GAQL failed: ' + (e && e.message ? e.message : e)); return; }

  var byGeo = {};
  while (rowsIter.hasNext()) {
    var r = rowsIter.next();
    var countryId = String(r['geographic_view.country_criterion_id'] || '');
    if (!countryId) continue;
    var locType = String(r['geographic_view.location_type'] || '');
    var key = countryId + '|' + locType;
    if (!byGeo[key]) {
      byGeo[key] = {
        locationId: countryId,
        country: countryId,
        resolution: locType,
        daily: [],
      };
    }
    byGeo[key].daily.push({
      date: String(r['segments.date'] || ''),
      cost: (Number(r['metrics.cost_micros']) || 0) / 1000000,
      clicks: Number(r['metrics.clicks']) || 0,
      impressions: Number(r['metrics.impressions']) || 0,
      conversions: Number(r['metrics.conversions']) || 0,
    });
  }

  var rowsOut = [];
  for (var k in byGeo) { if (byGeo.hasOwnProperty(k)) rowsOut.push(byGeo[k]); }
  Logger.log('  ' + rowsOut.length + ' geo rows (country × location_type)');

  // Резолвинг location IDs в человеческие имена.
  var uniqIds = {};
  rowsOut.forEach(function (r) { uniqIds[r.locationId] = true; });
  var idList = Object.keys(uniqIds);
  if (idList.length > 0 && idList.length <= 100) {
    try {
      var nameMap = {};
      var resourceList = idList.map(function (id) { return '"geoTargetConstants/' + id + '"'; }).join(',');
      var gtq =
        'SELECT geo_target_constant.id, geo_target_constant.name, ' +
        'geo_target_constant.country_code, geo_target_constant.target_type, ' +
        'geo_target_constant.canonical_name ' +
        'FROM geo_target_constant ' +
        'WHERE geo_target_constant.resource_name IN (' + resourceList + ')';
      var gtRows = AdsApp.report(gtq).rows();
      while (gtRows.hasNext()) {
        var gr = gtRows.next();
        var gid = String(gr['geo_target_constant.id'] || '');
        nameMap[gid] = {
          name: String(gr['geo_target_constant.name'] || ''),
          countryCode: String(gr['geo_target_constant.country_code'] || ''),
          targetType: String(gr['geo_target_constant.target_type'] || ''),
          canonicalName: String(gr['geo_target_constant.canonical_name'] || ''),
        };
      }
      rowsOut.forEach(function (r) {
        var meta = nameMap[r.locationId];
        if (meta) {
          r.country = meta.canonicalName || meta.name || r.country;
          if (meta.targetType === 'City') r.city = meta.name;
          else if (meta.targetType === 'Region') r.region = meta.name;
        }
      });
      Logger.log('  resolved ' + Object.keys(nameMap).length + '/' + idList.length + ' location names');
    } catch (e) {
      Logger.log('  (geo name resolution skipped: ' + (e && e.message ? e.message : e) + ')');
    }
  }

  _postDimension('google-ads-geo', common, rowsOut);
}

function _runDeviceIngest(common) {
  Logger.log('Pulse device ingest — ' + common.startDate + ' to ' + common.endDate);
  // segments.device возвращает enum: MOBILE / DESKTOP / TABLET / CONNECTED_TV / OTHER.
  var query =
    'SELECT ' +
      'segments.device, ' +
      'campaign.id, ' +
      'campaign.name, ' +
      'segments.date, ' +
      'metrics.cost_micros, ' +
      'metrics.clicks, ' +
      'metrics.impressions, ' +
      'metrics.conversions ' +
    'FROM campaign ' +
    'WHERE segments.date BETWEEN "' + common.startDate + '" AND "' + common.endDate + '"';

  var rowsIter;
  try { rowsIter = AdsApp.report(query).rows(); }
  catch (e) { Logger.log('✗ device GAQL failed: ' + (e && e.message ? e.message : e)); return; }

  var byDev = {};
  while (rowsIter.hasNext()) {
    var r = rowsIter.next();
    var dev = String(r['segments.device'] || '').toUpperCase();
    if (!dev) continue;
    if (!byDev[dev]) {
      byDev[dev] = { device: dev, daily: [] };
    }
    byDev[dev].daily.push({
      date: String(r['segments.date'] || ''),
      cost: (Number(r['metrics.cost_micros']) || 0) / 1000000,
      clicks: Number(r['metrics.clicks']) || 0,
      impressions: Number(r['metrics.impressions']) || 0,
      conversions: Number(r['metrics.conversions']) || 0,
    });
  }

  var arr = [];
  for (var k in byDev) { if (byDev.hasOwnProperty(k)) arr.push(byDev[k]); }
  Logger.log('  ' + arr.length + ' device types');
  _postDimension('google-ads-devices', common, arr);
}
