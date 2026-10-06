// Altorancho — envía el gasto diario por campaña de Google Ads al panel de ventas.
// Google Ads → Herramientas → Acciones masivas → Scripts → (+) → pegar → Autorizar → programar "Cada hora".
// Para cargar el histórico: poner HISTORICO = true, Ejecutar una vez y volver a false.
var ENDPOINT = 'https://web-production-71431.up.railway.app/ingest/google';
var TOKEN = 'PEGAR_TOKEN';
var HISTORICO = false;
var MESES_HISTORICO = 12;

function main() {
  var tz = AdsApp.currentAccount().getTimeZone();
  var fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  var hoy = new Date();
  if (!HISTORICO) {
    // una vez por día reenvía 30 días: Google sigue ajustando conversiones durante semanas
    var dias = hoy.getHours() === 7 ? 30 : 3;
    var desde = new Date(hoy.getTime() - dias * 86400000);
    enviar(fmt(desde), fmt(hoy));
    return;
  }
  for (var m = MESES_HISTORICO; m >= 0; m--) {
    var inicio = new Date(hoy.getFullYear(), hoy.getMonth() - m, 1);
    var fin = new Date(hoy.getFullYear(), hoy.getMonth() - m + 1, 0);
    if (fin > hoy) fin = hoy;
    enviar(fmt(inicio), fmt(fin));
  }
}

function enviar(desde, hasta) {
  var query = 'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, segments.date, '
    + 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value '
    + 'FROM campaign WHERE segments.date BETWEEN \'' + desde + '\' AND \'' + hasta + '\'';
  var it = AdsApp.search(query);
  var campanias = {};
  var filas = [];
  while (it.hasNext()) {
    var r = it.next();
    var id = String(r.campaign.id);
    campanias[id] = { id: id, name: r.campaign.name, status: r.campaign.status, channel_type: r.campaign.advertisingChannelType };
    filas.push({
      campaign_id: id, date: r.segments.date, cost_micros: Number(r.metrics.costMicros || 0),
      impressions: Number(r.metrics.impressions || 0), clicks: Number(r.metrics.clicks || 0),
      conversions: Number(r.metrics.conversions || 0), conversions_value: Number(r.metrics.conversionsValue || 0),
    });
  }
  var resp = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post', contentType: 'application/json', headers: { 'X-Ingest-Token': TOKEN }, muteHttpExceptions: true,
    payload: JSON.stringify({ campaigns: Object.keys(campanias).map(function (k) { return campanias[k]; }), rows: filas }),
  });
  Logger.log(desde + ' a ' + hasta + ': ' + filas.length + ' filas → HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200));
  if (resp.getResponseCode() >= 300) throw new Error('Falló el envío al panel');
}
