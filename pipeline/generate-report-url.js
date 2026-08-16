/**
 * generate-report-url.js
 * ════════════════════════════════════════════════════════════════
 * Genera la URL pública del dashboard CIEN con parámetros GET,
 * UUID único del informe y token de acceso HMAC-SHA256.
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');
require('dotenv').config({ path: '.env' });

const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL
  || 'https://portal.cien.app/dashboard/cien-dashboard-v2.html';

const REPORT_TOKEN_SECRET = process.env.REPORT_TOKEN_SECRET || 'cien-default-secret-change-me';

function generateUUID() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function generateAccessToken(aliadoId, fechaStr, secret) {
  const payload = `${aliadoId}:${fechaStr}:${secret}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex').slice(0, 32);
}

function generateReportUrl({ aliadoId, aliadoName, excelUrl, reportUuid, fecha, dashboardBase, claveAcceso }) {
  if (!aliadoId)   throw new Error('[generateReportUrl] aliadoId es requerido');
  if (!aliadoName) throw new Error('[generateReportUrl] aliadoName es requerido');
  if (!excelUrl)   throw new Error('[generateReportUrl] excelUrl es requerido');

  const base     = dashboardBase || DASHBOARD_BASE_URL;
  const fechaStr = fecha || new Date().toISOString().slice(0, 10);
  const uuid     = reportUuid || generateUUID();
  const token    = generateAccessToken(aliadoId, fechaStr, REPORT_TOKEN_SECRET);

  const params = new URLSearchParams({
    data:        excelUrl,
    report:      uuid,
    aliado:      aliadoId,
    aliado_name: aliadoName,
    token:       token,
  });

  // Incluir clave de acceso si está configurada para este aliado
  if (claveAcceso) params.set('key', claveAcceso);

  const dashboardUrl = `${base}?${params.toString()}`;

  console.log('[generate-report-url] URL generada para aliado:', aliadoId);
  console.log('  UUID:  ', uuid);
  console.log('  Token: ', token);
  console.log('  Clave: ', claveAcceso ? '(configurada)' : '(sin clave)');
  console.log('  URL:   ', dashboardUrl.slice(0, 120) + '...');

  return { reportUuid: uuid, token, dashboardUrl };
}

function validateToken(aliadoId, fechaStr, token) {
  const expected = generateAccessToken(aliadoId, fechaStr, REPORT_TOKEN_SECRET);
  if (expected.length !== token.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(token,    'utf8')
  );
}

function generatePeriodLabel(startISO, endISO, locale = 'es-CO') {
  const opts  = { month: 'long', year: 'numeric' };
  const start = new Date(startISO).toLocaleDateString(locale, opts);
  const end   = new Date(endISO).toLocaleDateString(locale, opts);
  if (start === end) return start.charAt(0).toUpperCase() + start.slice(1);
  const startDate = new Date(startISO);
  const endDate   = new Date(endISO);
  if (startDate.getFullYear() === endDate.getFullYear()) {
    const startMonth = startDate.toLocaleDateString(locale, { month: 'long' });
    const endFull    = endDate.toLocaleDateString(locale, opts);
    return (startMonth.charAt(0).toUpperCase() + startMonth.slice(1))
      + ' - ' + (endFull.charAt(0).toUpperCase() + endFull.slice(1));
  }
  return (start.charAt(0).toUpperCase() + start.slice(1))
    + ' - ' + (end.charAt(0).toUpperCase() + end.slice(1));
}

module.exports = {
  generateReportUrl,
  generateUUID,
  generateAccessToken,
  validateToken,
  generatePeriodLabel,
};

if (require.main === module) {
  const result = generateReportUrl({
    aliadoId:   'ALIADO_001',
    aliadoName: 'Empresa de Movilidad S.A.',
    excelUrl:   'https://cdn.jsdelivr.net/gh/cien/informes/ALIADO_001/2026-08-15/data.xlsx',
    fecha:      '2026-08-15',
  });
  console.log('\n✅ Resultado completo:');
  console.log(JSON.stringify(result, null, 2));
}
