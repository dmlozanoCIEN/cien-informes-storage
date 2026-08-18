/**
 * pipeline/run-once.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Versión "una sola pasada" del scheduler para GitHub Actions.
 * En lugar de un loop cron infinito, consulta NocoDB una vez,
 * procesa todos los aliados elegibles y termina con exit code 0/1.
 *
 * Variables de entorno leídas:
 *   ALIADO_ID_FILTER  — si está definido, solo procesa ese aliado_id
 *   DRY_RUN           — si es 'true', muestra qué haría pero no envía correos
 *   LOG_LEVEL         — 'debug' | 'info' | 'warn' | 'error'
 *   RUN_MODE          — 'github-actions' (ajusta formato de logs)
 *
 * Salida:
 *   exit 0 → todos los aliados procesados correctamente (o no había elegibles)
 *   exit 1 → al menos un aliado falló
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

// Cargar .env si existe (entorno local); en GitHub Actions vienen de Secrets
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch (_) {}

// ─── Importar módulos del pipeline ───────────────────────────────────────────
const { downloadExcel }               = require('./download-excel');
const { uploadExcel }                 = require('./upload-to-repo');
const { generateReportUrl, generateUUID } = require('./generate-report-url');
const { sendReportEmail }             = require('./send-report-email');
const { extractKpis }                 = require('./extract-kpis');

// ─── Configuración ───────────────────────────────────────────────────────────
const IS_GH_ACTIONS = process.env.RUN_MODE === 'github-actions';
const DRY_RUN       = process.env.DRY_RUN === 'true';
const ALIADO_FILTER = (process.env.ALIADO_ID_FILTER || '').trim();
const LOG_LEVEL_STR = process.env.LOG_LEVEL || 'info';
const LOG_LEVELS    = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL     = LOG_LEVELS[LOG_LEVEL_STR] ?? 1;

const CONFIG = {
  nocodbUrl:        process.env.NOCODB_API_URL                    || 'https://app.nocodb.com',
  nocodbToken:      process.env.NOCODB_API_TOKEN                  || 'nc_pat_CBC1DGXT50w5Bt5L-MJOk1-2EB2x8vt1XchjWgg0',
  tableAliados:     process.env.NOCODB_TABLE_ALIADOS              || 'menim7g7ba864x4',
  tableInformes:    process.env.NOCODB_TABLE_ALIADO_INFORMES      || 'm4twk0jq7wduk62',
  tableConfigEnvio: process.env.NOCODB_TABLE_ALIADO_CONFIG_ENVIO  || 'mdkn6wr2truap7a',
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL                || 'https://cien.app/dashboard/cien-dashboard-v2.html',
  jobTimeoutMs:     parseInt(process.env.JOB_TIMEOUT_MS || '120000'),
  // Delay entre aliados para evitar HTTP 429 de NocoDB (ms)
  delayEntreAliados: parseInt(process.env.DELAY_ENTRE_ALIADOS_MS || '3000'),
};

// ─── Logger ──────────────────────────────────────────────────────────────────
const LOG_LINES = []; // acumula para guardar en archivo al final

function _log(level, ...args) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return;
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${args.join(' ')}`;
  LOG_LINES.push(line);

  // GitHub Actions: usar ::notice/::warning/::error para highlight en UI
  if (IS_GH_ACTIONS) {
    if      (level === 'error') console.error(`::error::${args.join(' ')}`);
    else if (level === 'warn')  console.warn(`::warning::${args.join(' ')}`);
    else                        console.log(line);
  } else {
    console.log(line);
  }
}

const log = {
  debug: (...a) => _log('debug', ...a),
  info:  (...a) => _log('info',  ...a),
  warn:  (...a) => _log('warn',  ...a),
  error: (...a) => _log('error', ...a),
};

// ─── NocoDB helper ───────────────────────────────────────────────────────────
function nocoRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(endpoint, CONFIG.nocodbUrl);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'xc-token':     CONFIG.nocodbToken,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 30000,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            reject(new Error(`NocoDB ${method} ${endpoint} → HTTP ${res.statusCode}: ${data.slice(0,200)}`));
            return;
          }
          resolve(res.statusCode === 204 ? {} : (data ? JSON.parse(data) : {}));
        } catch (e) { reject(new Error(`NocoDB parse error: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`NocoDB timeout: ${endpoint}`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Calcular próximo envío (hora Colombia UTC-5) ────────────────────────────
function calcularProximoEnvio(config) {
  // Colombia es UTC-5 fijo (sin horario de verano)
  const COL_MS = -5 * 60 * 60 * 1000;
  const nowUtc = Date.now();
  const nowCol = new Date(nowUtc + COL_MS); // getHours() devuelve hora Colombia

  const [hora, minuto] = (config.hora_envio || '08:00').split(':').map(Number);
  const next = new Date(nowCol);
  next.setHours(hora, minuto, 0, 0);

  switch (config.frecuencia) {
    case 'diario':
      if (next <= nowCol) next.setDate(next.getDate() + 1);
      break;
    case 'semanal': {
      const target   = parseInt(config.dia_semana ?? 1);
      const diff     = (target - nowCol.getDay() + 7) % 7;
      if (diff === 0 && next <= nowCol) next.setDate(next.getDate() + 7);
      else next.setDate(next.getDate() + diff);
      break;
    }
    case 'mensual': {
      const dia = parseInt(config.dia_mes ?? 1);
      next.setDate(dia);
      if (next <= nowCol) { next.setMonth(next.getMonth() + 1); next.setDate(dia); }
      break;
    }
    default:
      return new Date(nowCol.getFullYear() + 100, 0, 1).toISOString();
  }

  // Convertir de hora-Colombia a UTC real
  return new Date(next.getTime() - COL_MS).toISOString();
}

// ─── Obtener aliados elegibles ────────────────────────────────────────────────
async function getAliadosElegibles() {
  // Nota: proximo_envio es campo de texto en NocoDB — no soporta filtros lte/gte
  // Se trae todo lo activo y se filtra en JS por fecha
  let where = `(activo,eq,true)~and(frecuencia,neq,manual)`;

  // Si se especificó un aliado concreto (ejecución manual desde workflow_dispatch)
  if (ALIADO_FILTER) {
    log.info(`Filtro de aliado activo: solo procesando aliado_id="${ALIADO_FILTER}"`);
    where = `(aliado_id,eq,${ALIADO_FILTER})`;
  }

  const res  = await nocoRequest(
    `/api/v2/tables/${CONFIG.tableConfigEnvio}/records?where=${encodeURIComponent(where)}&limit=100`
  );
  const todos = res.list || [];
  log.info(`Registros encontrados en NocoDB: ${todos.length}`);

  // Si hay filtro manual de aliado (workflow_dispatch), NO filtrar por fecha
  // El admin quiere forzar el envío independientemente del proximo_envio
  if (ALIADO_FILTER) {
    log.info(`Modo manual: omitiendo filtro de fecha para aliado_id="${ALIADO_FILTER}"`);
    todos.forEach(cfg => {
      log.info(`  → aliado_id=${cfg.aliado_id} | activo=${cfg.activo} | frecuencia=${cfg.frecuencia} | proximo_envio=${cfg.proximo_envio || '(vacío)'}`);
    });
    return todos;
  }

  // Filtrar en JS: proximo_envio <= ahora, o sin fecha (nunca enviado = elegible)
  const ahora = Date.now();
  const elegibles = todos.filter(cfg => {
    if (!cfg.proximo_envio) return true;          // nunca configurado → elegible
    const ts = new Date(cfg.proximo_envio).getTime();
    const ok = isNaN(ts) || ts <= ahora;
    if (!ok) log.debug(`  Descartado aliado_id=${cfg.aliado_id}: proximo_envio=${cfg.proximo_envio} está en el futuro`);
    return ok;
  });
  return elegibles;
}

// ─── Extraer emails de un registro de aliado ─────────────────────────────────
function _extraerEmails(registro) {
  const contactos = [];
  if (!registro) return contactos;

  // Campos donde pueden estar los emails (en orden de prioridad)
  // emails_contacto primero — es el campo replicado desde el portal al guardar config
  const camposEmail = [
    registro.emails_contacto,  // ← campo replicado desde portal (prioridad máxima)
    registro.emails_copia,
    registro.email_contacto,
    registro.correo_contacto,
    registro.email,
    registro.correo,
    registro.Email,
    registro.Correo,
    registro.email_informe,
    registro.correos_envio,
  ];

  const nombre = registro.nombre || registro.Nombre || registro.name || registro.Name || '';

  camposEmail
    .filter(Boolean)
    .forEach(val => {
      String(val)
        .split(/[,;\n]/)        // separado por comas, punto y coma, o salto de línea
        .map(e => e.trim())
        .filter(e => e.includes('@'))
        .forEach(email => {
          const emailLower = email.toLowerCase();
          if (!contactos.some(c => c.email === emailLower)) {
            contactos.push({ email: emailLower, nombre });
          }
        });
    });

  return contactos;
}

// ─── Pipeline para un aliado ─────────────────────────────────────────────────
async function runPipeline(configEnvio) {
  const aliadoId    = String(configEnvio.aliado_id);
  const cmsEndpoint = configEnvio.cms_endpoint || '';
  const claveAcceso = configEnvio.clave_acceso || '';
  const now         = new Date();
  const fecha       = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const reportUuid  = generateUUID();
  const start       = Date.now();

  let aliadoNombre = configEnvio.aliado_nombre || aliadoId;
  let informeId    = null;
  let contactos    = [];

  log.info(`── INICIO pipeline: aliado=${aliadoId} fecha=${fecha} uuid=${reportUuid}`);

  try {
    // PASO 0: Obtener datos del aliado (nombre + emails en UNA sola llamada)
    try {
      const a = await nocoRequest(`/api/v2/tables/${CONFIG.tableAliados}/records/${aliadoId}`);
      aliadoNombre = a.nombre || a.Nombre || a.name || a.Name || aliadoNombre;

      // Primero intentar contactos desde aliado_config_envio (ya los tenemos en memoria)
      contactos = _extraerEmails(configEnvio);

      // Si la config no tiene emails, tomar del registro del aliado
      if (!contactos.length) {
        contactos = _extraerEmails(a);
        if (contactos.length) {
          log.info(`Contactos desde ficha del aliado: ${contactos.map(c => c.email).join(', ')}`);
        }
      } else {
        log.info(`Contactos desde config_envio: ${contactos.map(c => c.email).join(', ')}`);
      }
    } catch (e) {
      log.warn(`No se pudo obtener datos del aliado: ${e.message}`);
      // Intentar contactos solo desde configEnvio aunque falló el GET del aliado
      contactos = _extraerEmails(configEnvio);
    }

    if (!contactos.length) {
      log.warn(`⚠️  Aliado ${aliadoId} no tiene emails configurados — se omitirá el envío de correo`);
    }

    // PASO 1: Registrar informe como 'pendiente'
    try {
      const inf = await nocoRequest(`/api/v2/tables/${CONFIG.tableInformes}/records`, 'POST', {
        aliado_id:        aliadoId,
        report_uuid:      reportUuid,
        fecha_generacion: new Date().toISOString(),
        estado:           'pendiente',
        total_views:      0,
      });
      informeId = inf.Id || inf.id || null;
      log.info(`Informe registrado en NocoDB: id=${informeId}`);
    } catch (e) { log.warn(`No se pudo registrar informe: ${e.message}`); }

    if (DRY_RUN) {
      log.info(`[DRY RUN] Se procesaría aliado ${aliadoNombre} (${aliadoId}) — sin envío real`);
      return { success: true, aliadoId, aliadoNombre, dry: true, durationMs: Date.now() - start };
    }

    // PASO 2: Descargar Excel
    log.info(`[1/5] Descargando Excel desde CMS...`);
    const dl = await downloadExcel({ aliadoId, fecha, cmsEndpoint, aliadoNombre });
    log.info(`Excel descargado: ${(dl.byteSize / 1024).toFixed(1)} KB`);

    // PASO 2b: Extraer KPIs del Excel descargado
    log.info(`Extrayendo KPIs del Excel...`);
    const kpis = extractKpis(dl.buffer);
    if (kpis.error) log.warn(`KPIs con error parcial: ${kpis.error}`);
    else log.info(`KPIs: sesiones=${kpis.total_sesiones} | usuarios=${kpis.usuarios_unicos} | kWh=${kpis.kwh_total} | ingresos=${kpis.ingresos_netos} | ocupacion=${kpis.tasa_ocupacion ?? 'N/D'}%`);

    // PASO 3: Subir Excel al repo (GitHub → CDN)
    log.info(`[2/5] Subiendo Excel al repositorio...`);
    const up = await uploadExcel({ fileBuffer: dl.buffer, aliadoId, fecha });
    const excelUrl = up.cdnUrl || up.publicUrl;
    log.info(`Excel publicado: ${excelUrl}`);

    // PASO 4: Generar URL del dashboard con clave si está configurada
    log.info(`[3/5] Generando URL del informe...`);
    const { dashboardUrl } = generateReportUrl({
      aliadoId,
      aliadoName:    aliadoNombre,
      excelUrl,
      reportUuid,
      fecha,
      dashboardBase: CONFIG.dashboardBaseUrl,
      claveAcceso,   // incluye &key= si está configurada
    });
    log.info(`URL: ${dashboardUrl.slice(0, 100)}...`);

    // PASO 5: Actualizar informe en NocoDB con URLs
    if (informeId) {
      try {
        await nocoRequest(`/api/v2/tables/${CONFIG.tableInformes}/records`, 'PATCH', {
          Id: informeId, url_excel: excelUrl, url_dashboard: dashboardUrl,
        });
      } catch (e) { log.warn(`No se pudo actualizar URLs en NocoDB: ${e.message}`); }
    }

    // PASO 6: Enviar correo con KPIs reales
    log.info(`[4/5] Enviando correo via EmailJS...`);
    const send = await sendReportEmail({
      aliadoId, aliadoNombre, reportUuid,
      urlDashboard: dashboardUrl, fecha, kpis, informeId,
      // Pasar contactos pre-cargados → send-report-email NO hace GET extra a NocoDB
      contactos: contactos.length ? contactos : null,
    });
    log.info(`Correos: ${send.totalEnviados} enviados · ${send.totalErrores} errores · estado=${send.estado}`);

    // PASO 7: Actualizar próximo_envio
    log.info(`[5/5] Actualizando próximo envío...`);
    const proximo = calcularProximoEnvio(configEnvio);
    try {
      const cfgId = configEnvio.Id || configEnvio.id;
      await nocoRequest(`/api/v2/tables/${CONFIG.tableConfigEnvio}/records`, 'PATCH', {
        Id: cfgId, ultimo_envio: new Date().toISOString(), proximo_envio: proximo,
      });
      log.info(`Próximo envío: ${proximo}`);
    } catch (e) { log.warn(`No se pudo actualizar proximo_envio: ${e.message}`); }

    log.info(`✅ Pipeline OK en ${((Date.now() - start) / 1000).toFixed(1)}s`);
    return { success: true, aliadoId, aliadoNombre, reportUuid, urlDashboard: dashboardUrl, durationMs: Date.now() - start };

  } catch (err) {
    log.error(`❌ Pipeline FALLÓ: ${err.message}`);
    if (informeId) {
      nocoRequest(`/api/v2/tables/${CONFIG.tableInformes}/records`, 'PATCH', {
        Id: informeId, estado: 'error', notas: err.message,
      }).catch(() => {});
    }
    return { success: false, aliadoId, aliadoNombre, error: err.message, durationMs: Date.now() - start };
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTotal = Date.now();
  log.info('════════════════════════════════════════');
  log.info(`CIEN Scheduler — run-once`);
  log.info(`Hora UTC:      ${new Date().toISOString()}`);
  const colHora = new Date(Date.now() + (-5*60*60*1000));
  log.info(`Hora Colombia: ${colHora.toISOString().replace('T',' ').slice(0,19)}`);
  log.info(`Modo:          ${DRY_RUN ? 'DRY RUN (sin envíos)' : 'PRODUCCIÓN'}`);
  if (ALIADO_FILTER) log.info(`Aliado filtro: ${ALIADO_FILTER}`);
  log.info('════════════════════════════════════════');

  let exitCode = 0;

  try {
    const elegibles = await getAliadosElegibles();

    if (!elegibles.length) {
      log.info('Sin aliados elegibles en este momento. Nada que hacer.');
    } else {
      log.info(`${elegibles.length} aliado(s) a procesar`);

      const resultados = [];
      // Procesar en SERIE con delay para no saturar NocoDB (evitar HTTP 429)
      for (let i = 0; i < elegibles.length; i++) {
        const cfg = elegibles[i];
        const res = await Promise.race([
          runPipeline(cfg),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('Timeout')), CONFIG.jobTimeoutMs)
          ),
        ]).catch(err => ({ success: false, aliadoId: cfg.aliado_id, error: err.message }));
        resultados.push(res);

        // Delay entre aliados para respetar el rate-limit de NocoDB
        if (i < elegibles.length - 1) {
          log.info(`⏳ Esperando ${CONFIG.delayEntreAliados / 1000}s antes del siguiente aliado...`);
          await new Promise(r => setTimeout(r, CONFIG.delayEntreAliados));
        }
      }

      const ok  = resultados.filter(r => r.success).length;
      const err = resultados.filter(r => !r.success).length;

      log.info('════════════════════════════════════════');
      log.info(`RESUMEN: ✅ ${ok} exitosos · ❌ ${err} fallidos`);
      resultados.forEach(r => {
        if (!r.success) log.error(`  FALLO: ${r.aliadoNombre || r.aliadoId} → ${r.error}`);
        else            log.info (`  OK:    ${r.aliadoNombre || r.aliadoId}${r.dry ? ' (dry run)' : ''}`);
      });
      log.info('════════════════════════════════════════');

      if (err > 0) exitCode = 1;
    }
  } catch (err) {
    log.error(`Error fatal en main: ${err.message}`);
    log.error(err.stack || '');
    exitCode = 1;
  }

  const totalSec = ((Date.now() - startTotal) / 1000).toFixed(1);
  log.info(`Tiempo total: ${totalSec}s`);

  // Guardar log en archivo (el workflow lo sube como artefacto)
  try {
    fs.writeFileSync(
      path.join(process.cwd(), 'pipeline-run.log'),
      LOG_LINES.join('\n') + '\n'
    );
  } catch (_) {}

  process.exit(exitCode);
}

main();
