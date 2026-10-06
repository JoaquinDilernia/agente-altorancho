// Altorancho — envía el gasto diario por campaña de Google Ads al panel de ventas.
// Google Ads → Herramientas → Acciones en bloque → Secuencias de comandos → abrir el script → pegar → Guardar.
// Para cargar el histórico: poner HISTORICO = true, Ejecutar (Vista previa) una vez y volver a false.
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
    enviar(fmt(desde), fmt(hoy), true);
    return;
  }
  for (var m = MESES_HISTORICO; m >= 0; m--) {
    var inicio = new Date(hoy.getFullYear(), hoy.getMonth() - m, 1);
    var fin = new Date(hoy.getFullYear(), hoy.getMonth() - m + 1, 0);
    if (fin > hoy) fin = hoy;
    enviar(fmt(inicio), fmt(fin), m === 0);
  }
}

function buscar(query) {
  var it = AdsApp.search(query);
  var out = [];
  while (it.hasNext()) out.push(it.next());
  return out;
}

// Grupos de anuncios y grupos de recursos con su campaña: en Performance Max el ID que viaja en el link
// de la venta (gad_campaignid) puede ser el de un grupo y no el de la campaña.
function entidades() {
  var out = [];
  buscar('SELECT ad_group.id, campaign.id FROM ad_group').forEach(function (r) {
    out.push({ id: String(r.adGroup.id), campaign_id: String(r.campaign.id), type: 'ad_group' });
  });
  buscar('SELECT asset_group.id, campaign.id FROM asset_group').forEach(function (r) {
    out.push({ id: String(r.assetGroup.id), campaign_id: String(r.campaign.id), type: 'asset_group' });
  });
  return out;
}

function enviar(desde, hasta, conEntidades) {
  var rango = 'segments.date BETWEEN \'' + desde + '\' AND \'' + hasta + '\'';
  var campanias = {};
  var filas = {};
  buscar('SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, segments.date, '
    + 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value '
    + 'FROM campaign WHERE ' + rango).forEach(function (r) {
    var id = String(r.campaign.id);
    campanias[id] = { id: id, name: r.campaign.name, status: r.campaign.status, channel_type: r.campaign.advertisingChannelType };
    filas[id + '|' + r.segments.date] = {
      campaign_id: id, date: r.segments.date, cost_micros: Number(r.metrics.costMicros || 0),
      impressions: Number(r.metrics.impressions || 0), clicks: Number(r.metrics.clicks || 0),
      conversions: Number(r.metrics.conversions || 0), conversions_value: Number(r.metrics.conversionsValue || 0),
      purchases: 0, purchases_value: 0,
    };
  });
  // Solo conversiones de categoría Compra (las totales incluyen acciones que no son ventas)
  buscar('SELECT campaign.id, segments.date, segments.conversion_action_category, metrics.conversions, metrics.conversions_value '
    + 'FROM campaign WHERE ' + rango + ' AND segments.conversion_action_category = \'PURCHASE\'').forEach(function (r) {
    var fila = filas[String(r.campaign.id) + '|' + r.segments.date];
    if (!fila) return;
    fila.purchases += Number(r.metrics.conversions || 0);
    fila.purchases_value += Number(r.metrics.conversionsValue || 0);
  });
  var payload = {
    campaigns: Object.keys(campanias).map(function (k) { return campanias[k]; }),
    rows: Object.keys(filas).map(function (k) { return filas[k]; }),
    entities: conEntidades ? entidades() : [],
  };
  var resp = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post', contentType: 'application/json', headers: { 'X-Ingest-Token': TOKEN }, muteHttpExceptions: true,
    payload: JSON.stringify(payload),
  });
  Logger.log(desde + ' a ' + hasta + ': ' + payload.rows.length + ' filas, ' + payload.entities.length + ' grupos → HTTP '
    + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200));
  if (resp.getResponseCode() >= 300) throw new Error('Falló el envío al panel');
}
