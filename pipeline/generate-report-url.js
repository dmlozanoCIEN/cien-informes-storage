/**
 * generate-report-url.js
 * ════════════════════════════════════════════════════════════════
 * Genera la URL pública del dashboard CIEN con parámetros GET,
 * UUID único del informe y token de acceso HMAC-SHA256.
 *
 * Uso: node generate-report-url.js
 * O importar: const { generateReportUrl } = require('./generate-report-url');
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');
require('dotenv').config({ path: '.env' });

// ─── Configuración ────────────────────────────────────────────
const DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL
  || 'https://portal.cien.app/dashboard/cien-dashboard-v2.html';

const REPORT_TOKEN_SECRET = process.env.REPORT_TOKEN_SECRET || 'cien-default-secret-change-me';

// ─── Funciones ────────────────────────────────────────────────

/**
 * Genera un UUID v4 usando crypto.randomUUID() (Node ≥ 15.6)
 * con fallback manual para versiones anteriores.
 * @returns {string} UUID v4
 */
function generateUUID() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback manual
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Genera un token HMAC-SHA256 para acceso a un informe.
 * El token es determinístico: mismo aliado + fecha + secret = mismo token.
 * Esto permite regenerar la URL sin cambiar el token.
 *
 * @param {string} aliadoId  - ID único del aliado
 * @param {string} fechaStr  - Fecha del informe en formato YYYY-MM-DD
 * @param {string} secret    - Secret del proyecto (REPORT_TOKEN_SECRET)
 * @returns {string}         - Token hex de 16 caracteres (primeros 16 del HMAC)
 */
function generateAccessToken(aliadoId, fechaStr, secret) {
  const payload = `${aliadoId}:${fechaStr}:${secret}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex').slice(0, 32); // 32 chars = 128 bits
}

/**
 * Genera la URL completa del dashboard con todos los parámetros GET.
 *
 * @param {Object} options
 * @param {string} options.aliadoId    - ID del aliado en NocoDB
 * @param {string} options.aliadoName  - Nombre legible del aliado
 * @param {string} options.excelUrl    - URL pública del archivo Excel
 * @param {string} [options.reportUuid] - UUID del informe (generado si no se pasa)
 * @param {string} [options.fecha]     - Fecha del informe YYYY-MM-DD (default: hoy)
 * @param {string} [options.ultimoDia] - Último día de operación 'YYYY-MM-DD'; si se pasa,
 *                                       el dashboard abrirá pre-filtrado a ese día (&day=)
 * @returns {Object} { reportUuid, token, dashboardUrl }
 */
function generateReportUrl({ aliadoId, aliadoName, excelUrl, reportUuid, fecha, dashboardBase, claveAcceso, ultimoDia }) {
  if (!aliadoId)   throw new Error('[generateReportUrl] aliadoId es requerido');
  if (!aliadoName) throw new Error('[generateReportUrl] aliadoName es requerido');
  if (!excelUrl)   throw new Error('[generateReportUrl] excelUrl es requerido');

  const base       = dashboardBase || DASHBOARD_BASE_URL;
  const fechaStr   = fecha || new Date().toISOString().slice(0, 10);
  const uuid       = reportUuid || generateUUID();
  const token      = generateAccessToken(aliadoId, fechaStr, REPORT_TOKEN_SECRET);

  const params = new URLSearchParams({
    data:         excelUrl,
    report:       uuid,
    aliado:       aliadoId,
    aliado_name:  aliadoName,
    token:        token,
  });

  // Pre-filtrar el dashboard al último día de operación del Excel
  // Esto permite que el receptor abra directamente el día más reciente del informe.
  if (ultimoDia && /^\d{4}-\d{2}-\d{2}$/.test(ultimoDia)) {
    params.set('day', ultimoDia);
    console.log('[generate-report-url]  Día pre-filtro:', ultimoDia);
  }

  // Incluir clave de acceso si está configurada para este aliado
  if (claveAcceso) params.set('key', claveAcceso);

  const dashboardUrl = `${base}?${params.toString()}`;

  console.log('[generate-report-url] URL generada para aliado:', aliadoId);
  console.log('  UUID:  ', uuid);
  console.log('  Token: ', token);
  console.log('  Clave: ', claveAcceso ? '(configurada)' : '(sin clave)');
  console.log('  URL:   ', dashboardUrl.slice(0, 150) + (dashboardUrl.length > 150 ? '...' : ''));

  return { reportUuid: uuid, token, dashboardUrl };
}

/**
 * Valida un token de acceso recibido.
 * Útil en el endpoint /api/track-view para verificar antes de registrar.
 *
 * @param {string} aliadoId  - ID del aliado
 * @param {string} fechaStr  - Fecha en formato YYYY-MM-DD
 * @param {string} token     - Token a validar
 * @returns {boolean}
 */
function validateToken(aliadoId, fechaStr, token) {
  const expected = generateAccessToken(aliadoId, fechaStr, REPORT_TOKEN_SECRET);
  // Comparación de tiempo constante para evitar timing attacks
  if (expected.length !== token.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(token,    'utf8')
  );
}

/**
 * Genera un período legible a partir de las fechas de inicio y fin.
 * @param {string} startISO - Fecha inicio ISO
 * @param {string} endISO   - Fecha fin ISO
 * @param {string} [locale='es-CO']
 * @returns {string} - Ej: "Enero - Agosto 2026"
 */
function generatePeriodLabel(startISO, endISO, locale = 'es-CO') {
  const opts = { month: 'long', year: 'numeric' };
  const start = new Date(startISO).toLocaleDateString(locale, opts);
  const end   = new Date(endISO).toLocaleDateString(locale, opts);
  // Si mismo mes, retornar solo uno
  if (start === end) return start.charAt(0).toUpperCase() + start.slice(1);
  // Si mismo año, omitir el año del inicio
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

// ─── Exports ──────────────────────────────────────────────────
module.exports = {
  generateReportUrl,
  generateUUID,
  generateAccessToken,
  validateToken,
  generatePeriodLabel,
};

// ─── CLI demo ─────────────────────────────────────────────────
if (require.main === module) {
  const result = generateReportUrl({
    aliadoId:   'ALIADO_001',
    aliadoName: 'Empresa de Movilidad S.A.',
    excelUrl:   'https://cdn.jsdelivr.net/gh/cien/informes/ALIADO_001/2026-08-15/data.xlsx',
    fecha:      '2026-08-15',
  });
  console.log('\n✅ Resultado completo:');
  console.log(JSON.stringify(result, null, 2));

  const periodo = generatePeriodLabel('2026-01-01', '2026-08-15');
  console.log('\n📅 Período generado:', periodo);
}
