// Ideiglenes diagnosztika az árforrásokhoz.
const n = (...a) => console.log('::notice::' + a.join(' ').replace(/\s+/g, ' ').slice(0, 400));
const soap11 = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://www.mnb.hu/webservices/"><soap:Body><web:GetCurrentExchangeRates/></soap:Body></soap:Envelope>`;
const soap12 = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:web="http://www.mnb.hu/webservices/"><soap12:Body><web:GetCurrentExchangeRates/></soap12:Body></soap12:Envelope>`;
async function t(name, url, opt = {}) {
  try { const r = await fetch(url, { ...opt, redirect: 'follow' }); const x = await r.text(); n(name, r.status, r.url, '|', x.slice(0, 250)); }
  catch (e) { n(name, 'ERR', e.message); }
}
await t('MNB-wsdl-https', 'https://www.mnb.hu/arfolyamok.asmx?wsdl');
await t('MNB-wsdl-http', 'http://www.mnb.hu/arfolyamok.asmx?wsdl');
await t('MNB-11', 'http://www.mnb.hu/arfolyamok.asmx', { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://www.mnb.hu/webservices/MNBArfolyamServiceSoap/GetCurrentExchangeRates"' }, body: soap11 });
await t('MNB-12', 'http://www.mnb.hu/arfolyamok.asmx', { method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' }, body: soap12 });
await t('Stooq-q', 'https://stooq.com/q/l/?s=vwce.de&f=sd2t2ohlcv&h&e=csv', { headers: { 'User-Agent': 'Mozilla/5.0' } });
await t('Stooq-d', 'https://stooq.com/q/d/l/?s=vwce.de&i=d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
