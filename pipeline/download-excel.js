/**
 * pipeline/download-excel.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Descarga el archivo Excel (.xlsx) del CMS del proyecto para un aliado dado.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https   = require('https');
const http    = require('http');
const { URL } = require('url');
const path    = require('path');
const fs      = require('fs');

const CONFIG = {
  defaultEndpoint: process.env.CMS_DEFAULT_ENDPOINT || '',
  method:          (process.env.CMS_HTTP_METHOD || 'GET').toUpperCase(),
  authToken:       process.env.CMS_AUTH_TOKEN || '',
  paramAliado:     process.env.CMS_PARAM_ALIADO || 'aliado_id',
  paramFecha:      process.env.CMS_PARAM_FECHA || 'fecha',
  fechaFormat:     process.env.CMS_FECHA_FORMAT || 'YYYY-MM',
  nocodbUrl:       process.env.NOCODB_API_URL   || 'https://app.nocodb.com',
  nocodbToken:     process.env.NOCODB_API_TOKEN || '',
  tableInformes:   process.env.NOCODB_TABLE_ALIADO_INFORMES || 'm4twk0jq7wduk62',
  timeoutMs:       parseInt(process.env.CMS_TIMEOUT_MS    || '30000'),
  maxRetries:      parseInt(process.env.CMS_MAX_RETRIES   || '3'),
  retryBaseMs:     parseInt(process.env.CMS_RETRY_BASE_MS || '2000'),
  tempDir:         process.env.TEMP_DIR || '/tmp/cien-informes',
};

const EXCEL_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
  'application/zip',
  'binary/octet-stream',
]);

function formatFecha(fecha, format = CONFIG.fechaFormat) {
  const d = fecha instanceof Date ? fecha : new Date(fecha + '-01');
  if (isNaN(d)) throw new Error(`Fecha inválida: ${fecha}`);
  switch (format) {
    case 'YYYY-MM':
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    case 'YYYY-MM-DD':
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    case 'timestamp':
      return String(d.getTime());
    default:
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
}

function buildCmsUrl(baseUrl, aliadoId, fecha) {
  if (!baseUrl) throw new Error('CMS_DEFAULT_ENDPOINT no configurado.');
  if (CONFIG.method === 'GET') {
    const url = new URL(baseUrl);
    url.searchParams.set(CONFIG.paramAliado, aliadoId);
    url.searchParams.set(CONFIG.paramFecha, fecha);
    return url.toString();
  }
  return baseUrl;
}

function buildPostBody(aliadoId, fecha) {
  const [year, month] = fecha.split('-').map(Number);
  const fechaInicio   = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay       = new Date(year, month, 0).getDate();
  const fechaFin      = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
  return JSON.stringify({
    [CONFIG.paramAliado]: aliadoId,
    [CONFIG.paramFecha]:  fecha,
    fecha_inicio: fechaInicio,
    fecha_fin:    fechaFin,
  });
}

function httpRequest(urlStr, options = {}, postBody = null) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(urlStr);
    const protocol = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  {
        'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream, */*',
        'User-Agent': 'CIEN-Report-Pipeline/1.0',
        ...(CONFIG.authToken ? { 'Authorization': `Bearer ${CONFIG.authToken}` } : {}),
        ...(options.headers || {}),
      },
      timeout: CONFIG.timeoutMs,
    };
    if (postBody) {
      reqOptions.headers['Content-Type']   = 'application/json';
      reqOptions.headers['Content-Length'] = postBody.length;
    }
    const req = protocol.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end',  () => resolve({ buffer: Buffer.concat(chunks), statusCode: res.statusCode, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout (${CONFIG.timeoutMs}ms) al descargar desde el CMS`)); });
    req.on('error', reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function validateExcelBuffer(buffer, contentType) {
  if (!buffer || buffer.length < 4) return { valid: false, reason: 'Buffer vacío o demasiado pequeño' };
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B;
  const isXls = buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0;
  if (!isZip && !isXls) {
    const preview = buffer.slice(0, 200).toString('utf8');
    return { valid: false, reason: `No parece Excel. Primeros bytes: ${preview.slice(0, 80).replace(/\n/g, ' ')}` };
  }
  return { valid: true };
}

async function downloadExcel({ aliadoId, fecha, cmsEndpoint, aliadoNombre = '' }) {
  if (!aliadoId) throw new Error('aliadoId es requerido');
  if (!fecha)    throw new Error('fecha es requerida (formato YYYY-MM)');

  const logPrefix       = `[CMS] Aliado ${aliadoNombre || aliadoId} | ${fecha}`;
  const fechaFormateada = formatFecha(fecha, CONFIG.fechaFormat);
  const endpoint        = cmsEndpoint || CONFIG.defaultEndpoint;

  if (!endpoint) {
    throw new Error(
      `No hay endpoint del CMS configurado para el aliado ${aliadoId}. ` +
      'Definir CMS_DEFAULT_ENDPOINT en .env o cms_endpoint en aliado_config_envio.'
    );
  }

  const cmsUrl   = buildCmsUrl(endpoint, aliadoId, fechaFormateada);
  const postBody = CONFIG.method === 'POST' ? Buffer.from(buildPostBody(aliadoId, fechaFormateada)) : null;

  console.log(`${logPrefix} → ${CONFIG.method} ${cmsUrl}`);

  let lastError = null;
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      console.log(`${logPrefix} → Intento ${attempt}/${CONFIG.maxRetries}...`);
      const { buffer, statusCode, headers } = await httpRequest(cmsUrl, { method: CONFIG.method }, postBody);

      if (statusCode >= 400) {
        throw new Error(`CMS devolvió HTTP ${statusCode}: ${buffer.toString('utf8').slice(0, 300)}`);
      }

      const contentType = headers['content-type'] || 'application/octet-stream';
      const validation  = validateExcelBuffer(buffer, contentType);
      if (!validation.valid) throw new Error(`Archivo no es Excel válido: ${validation.reason}`);

      const fileName = `aliado_${String(aliadoId).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,32)}_${fecha.replace(/[^0-9-]/g,'')}.xlsx`;
      console.log(`${logPrefix} ✅ Descarga exitosa: ${buffer.length} bytes · ${fileName}`);

      return { buffer, fileName, byteSize: buffer.length, contentType, aliadoId, fecha, downloadedAt: new Date().toISOString() };

    } catch (err) {
      lastError = err;
      console.error(`${logPrefix} ❌ Intento ${attempt} fallido: ${err.message}`);
      if (attempt < CONFIG.maxRetries) {
        const waitMs = CONFIG.retryBaseMs * Math.pow(2, attempt - 1);
        console.log(`${logPrefix} ⏳ Reintentando en ${waitMs / 1000}s...`);
        await sleep(waitMs);
      }
    }
  }

  throw new Error(
    `Fallo al descargar el Excel del CMS después de ${CONFIG.maxRetries} intentos. ` +
    `Último error: ${lastError?.message}`
  );
}

async function saveToDisk(buffer, fileName) {
  if (!fs.existsSync(CONFIG.tempDir)) fs.mkdirSync(CONFIG.tempDir, { recursive: true });
  const filePath = path.join(CONFIG.tempDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function testCmsConnectivity({ aliadoId, fecha, cmsEndpoint }) {
  try {
    const fechaFormateada = formatFecha(fecha, CONFIG.fechaFormat);
    const endpoint = cmsEndpoint || CONFIG.defaultEndpoint;
    const cmsUrl   = buildCmsUrl(endpoint, aliadoId, fechaFormateada);
    const postBody = CONFIG.method === 'POST' ? Buffer.from(buildPostBody(aliadoId, fechaFormateada)) : null;
    const { buffer, statusCode, headers } = await httpRequest(cmsUrl, { method: CONFIG.method }, postBody);
    const contentType = headers['content-type'] || '';
    const validation  = validateExcelBuffer(buffer, contentType);
    return { ok: statusCode < 400 && validation.valid, statusCode, byteSize: buffer.length, contentType, isValidExcel: validation.valid, reason: validation.reason || null, error: statusCode >= 400 ? `HTTP ${statusCode}` : null };
  } catch (err) {
    return { ok: false, statusCode: 0, byteSize: 0, contentType: '', error: err.message };
  }
}

module.exports = { downloadExcel, saveToDisk, testCmsConnectivity, formatFecha, buildCmsUrl, validateExcelBuffer, CONFIG };

if (require.main === module) {
  const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--'))
      .map(a => { const [k, ...rest] = a.slice(2).split('='); return [k, rest.join('=') || true]; })
  );
  const aliadoId    = args.aliado || args['aliado-id'];
  const fecha       = args.fecha  || new Date().toISOString().slice(0, 7);
  const cmsEndpoint = args.endpoint || undefined;

  if (!aliadoId) {
    console.error('Uso: node download-excel.js --aliado=<ID> [--fecha=YYYY-MM] [--endpoint=URL] [--test=true]');
    process.exit(1);
  }

  require('dotenv').config({ path: require('path').join(__dirname, '.env') });

  if (args.test === 'true' || args.test === true) {
    testCmsConnectivity({ aliadoId, fecha, cmsEndpoint })
      .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
      .catch(err => { console.error(err); process.exit(1); });
  } else {
    downloadExcel({ aliadoId, fecha, cmsEndpoint })
      .then(r => { console.log(`✅ ${r.fileName} · ${(r.byteSize/1024).toFixed(1)} KB`); process.exit(0); })
      .catch(err => { console.error('❌', err.message); process.exit(1); });
  }
}
