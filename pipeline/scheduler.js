/**
 * pipeline/scheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Scheduler principal del pipeline de informes CIEN.
 *
 * Responsabilidades:
 *   1. Ejecutar periódicamente (node-cron) para verificar aliados con
 *      proximo_envio <= NOW() en aliado_config_envio
 *   2. Por cada aliado elegible:
 *      a. Descarga el Excel desde el CMS   (download-excel.js)
 *      b. Sube el Excel al repositorio     (upload-to-repo.js)
 *      c. Genera la URL del informe        (generate-report-url.js)
 *      d. Registra el informe en NocoDB    (aliado_informes)
 *      e. Envía los correos               (send-report-email.js)
 *      f. Actualiza proximo_envio          (aliado_config_envio PATCH)
 *   3. Manejo robusto de errores — un aliado que falla no detiene a los demás
 *   4. Lock de ejecución para evitar solapamiento de tareas
 *
 * Schedulers soportados:
 *   - node-cron (por defecto) — requiere: npm install node-cron
 *   - GitHub Actions cron (workflow alternativo — no usa este script)
 *
 * Arrancar:
 *   node pipeline/scheduler.js
 *   # o con PM2:
 *   pm2 start pipeline/scheduler.js --name cien-scheduler
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const https = require('https');

// Importar módulos del pipeline
const { downloadExcel }      = require('./download-excel');
const { uploadExcel }        = require('./upload-to-repo');
const { generateReportUrl, generateUUID } = require('./generate-report-url');
const { sendReportEmail }    = require('./send-report-email');
/* Modelo de dashboard (v2 | consolidado). Espejo de _AUTO_DASHBOARDS en
   js/aliados.js: el cron y el botón del panel deben elegir el mismo HTML. */
const { modeloDashboard, baseDashboardPara, esModeloConocido } = require('./dashboard-modelo');

// ─── Configuración ───────────────────────────────────────────────────────────
const CONFIG = {
  // Intervalo de polling del scheduler (cuántas veces por hora revisa NocoDB)
  cronExpression:   process.env.SCHEDULER_CRON || '*/15 * * * *', // cada 15 min
  timezone:         process.env.SCHEDULER_TIMEZONE || 'America/Bogota',

  // NocoDB
  nocodbUrl:              process.env.NOCODB_API_URL                    || 'https://app.nocodb.com',
  nocodbToken:            process.env.NOCODB_API_TOKEN                  || 'nc_pat_CBC1DGXT50w5Bt5L-MJOk1-2EB2x8vt1XchjWgg0',
  tableAliados:           process.env.NOCODB_TABLE_ALIADOS              || 'menim7g7ba864x4',
  tableInformes:          process.env.NOCODB_TABLE_ALIADO_INFORMES      || 'm4twk0jq7wduk62',
  tableConfigEnvio:       process.env.NOCODB_TABLE_ALIADO_CONFIG_ENVIO  || 'mdkn6wr2truap7a',

  // Dashboard base URL
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || 'https://cien.app/dashboard/cien-dashboard-v2.html',

  // Lock: evitar ejecuciones paralelas
  maxConcurrentAliados: parseInt(process.env.MAX_CONCURRENT || '3'),
  jobTimeoutMs:         parseInt(process.env.JOB_TIMEOUT_MS || '120000'), // 2 min por aliado

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info', // 'debug' | 'info' | 'warn' | 'error'
};

// ─── Estado global del scheduler ─────────────────────────────────────────────
let _isRunning   = false;  // Lock para evitar solapamiento
let _runCount    = 0;
let _startedAt   = new Date();

// ─── Logger ──────────────────────────────────────────────────────────────────
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LEVELS[CONFIG.logLevel] ?? 1;

const log = {
  debug: (...a) => LOG_LEVEL <= 0 && console.debug('[SCHED]', new Date().toISOString(), ...a),
  info:  (...a) => LOG_LEVEL <= 1 && console.log  ('[SCHED]', new Date().toISOString(), ...a),
  warn:  (...a) => LOG_LEVEL <= 2 && console.warn ('[SCHED]', new Date().toISOString(), ...a),
  error: (...a) => LOG_LEVEL <= 3 && console.error('[SCHED]', new Date().toISOString(), ...a),
};

// ─── NocoDB helper ───────────────────────────────────────────────────────────
function nocoRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(CONFIG.nocodbUrl + endpoint);
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method,
      headers: {
        'xc-auth':      CONFIG.nocodbToken,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 20000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            reject(new Error(`NocoDB ${method} ${endpoint} → HTTP ${res.statusCode}: ${data.slice(0, 150)}`));
            return;
          }
          resolve(res.statusCode === 204 ? {} : (data ? JSON.parse(data) : {}));
        } catch (e) {
          reject(new Error(`NocoDB parse error: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`NocoDB timeout: ${endpoint}`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Calcular próximo envío ───────────────────────────────────────────────────

/**
 * Calcula el próximo timestamp de envío según la configuración del aliado.
 *
 * @param {object} config  Registro de aliado_config_envio
 * @returns {string}       ISO datetime del próximo envío
 */
function calcularProximoEnvio(config) {
  const now = new Date();
  const [hora, minuto] = (config.hora_envio || '07:00').split(':').map(Number);

  let next = new Date();
  next.setSeconds(0);
  next.setMilliseconds(0);
  next.setHours(hora, minuto, 0, 0);

  switch (config.frecuencia) {
    case 'diario':
      // Si la hora de hoy ya pasó, programar para mañana
      if (next <= now) next.setDate(next.getDate() + 1);
      break;

    case 'semanal': {
      const diaSemana = parseInt(config.dia_semana ?? 1); // 0=Dom, 1=Lun...6=Sáb
      const diasHasta = (diaSemana - now.getDay() + 7) % 7 || 7;
      next.setDate(now.getDate() + diasHasta);
      if (next <= now) next.setDate(next.getDate() + 7);
      break;
    }

    case 'mensual': {
      const diaMes = parseInt(config.dia_mes ?? 1);
      next.setDate(diaMes);
      if (next <= now) {
        // Pasar al mes siguiente
        next.setMonth(next.getMonth() + 1);
        next.setDate(diaMes);
      }
      break;
    }

    case 'manual':
    default:
      // No se auto-programa → 100 años en el futuro para que nunca dispare
      next = new Date(now.getFullYear() + 100, 0, 1);
      break;
  }

  return next.toISOString();
}

// ─── Consultar aliados elegibles ──────────────────────────────────────────────

/**
 * Consulta aliado_config_envio para obtener aliados activos con
 * proximo_envio <= NOW() y frecuencia != 'manual'.
 *
 * @returns {Promise<object[]>}  Lista de registros de aliado_config_envio
 */
async function getAliadosElegibles() {
  if (!CONFIG.tableConfigEnvio) {
    log.warn('NOCODB_TABLE_ALIADO_CONFIG_ENVIO no configurado — scheduler no puede verificar aliados.');
    return [];
  }

  const ahora   = new Date().toISOString();
  const where   = encodeURIComponent(
    `(activo,eq,true)~and(frecuencia,neq,manual)~and(proximo_envio,lte,${ahora})`
  );

  const res = await nocoRequest(
    `/api/v2/tables/${CONFIG.tableConfigEnvio}/records?where=${where}&limit=50&sort=proximo_envio`
  );

  const list = res.list || res.data || [];
  log.debug(`Aliados elegibles: ${list.length}`);
  return list;
}

// ─── Pipeline completo para un aliado ────────────────────────────────────────

/**
 * Ejecuta el pipeline completo (descarga → sube → genera URL → envía) para un aliado.
 *
 * @param {object} configEnvio  Registro de aliado_config_envio
 * @returns {Promise<PipelineResult>}
 *
 * @typedef {object} PipelineResult
 * @property {boolean} success
 * @property {string}  aliadoId
 * @property {string}  aliadoNombre
 * @property {string}  [reportUuid]
 * @property {string}  [urlDashboard]
 * @property {string}  [error]
 * @property {number}  durationMs
 */
async function runPipelineForAliado(configEnvio) {
  const start       = Date.now();
  const aliadoId    = configEnvio.aliado_id;
  const cmsEndpoint = configEnvio.cms_endpoint || '';

  // Determinar la fecha del período (mes actual o el anterior según configuración)
  const now         = new Date();
  const fecha       = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const reportUuid  = generateUUID();

  let aliadoNombre  = configEnvio.aliado_nombre || aliadoId;
  let informeId     = null;

  const prefix = `[PIPELINE] ${aliadoNombre} (${aliadoId}) | ${fecha}`;
  log.info(`${prefix} → Iniciando pipeline...`);

  try {
    // ── PASO 0: Obtener nombre del aliado desde NocoDB ────────────────────
    try {
      const aliado = await nocoRequest(
        `/api/v2/tables/${CONFIG.tableAliados}/records/${aliadoId}`
      );
      aliadoNombre = aliado.nombre || aliado.Nombre || aliado.name || aliado.Name || aliadoNombre;
      log.debug(`${prefix} → Aliado: ${aliadoNombre}`);
    } catch (e) {
      log.warn(`${prefix} → No se pudo obtener nombre del aliado: ${e.message}`);
    }

    // ── PASO 1: Registrar informe en NocoDB con estado 'pendiente' ────────
    if (CONFIG.tableInformes) {
      try {
        const nuevoInforme = await nocoRequest(
          `/api/v2/tables/${CONFIG.tableInformes}/records`,
          'POST',
          {
            aliado_id:        aliadoId,
            report_uuid:      reportUuid,
            fecha_generacion: new Date().toISOString(),
            estado:           'pendiente',
            total_views:      0,
          }
        );
        informeId = nuevoInforme.Id || nuevoInforme.id || null;
        log.debug(`${prefix} → Informe creado en NocoDB: id=${informeId}`);
      } catch (e) {
        log.warn(`${prefix} → No se pudo registrar informe en NocoDB: ${e.message}`);
      }
    }

    // ── PASO 2: Descargar Excel desde CMS ────────────────────────────────
    log.info(`${prefix} → [1/5] Descargando Excel del CMS...`);
    const downloadResult = await downloadExcel({
      aliadoId,
      fecha,
      cmsEndpoint,
      aliadoNombre,
    });
    log.info(`${prefix} → Excel descargado: ${(downloadResult.byteSize / 1024).toFixed(1)} KB`);

    // ── PASO 3: Subir Excel al repositorio ────────────────────────────────
    log.info(`${prefix} → [2/5] Subiendo Excel al repositorio...`);
    const uploadResult = await uploadExcel({
      fileBuffer: downloadResult.buffer,
      aliadoId,
      fecha,
    });
    log.info(`${prefix} → Excel disponible en: ${uploadResult.cdnUrl || uploadResult.publicUrl}`);

    // ── PASO 4: Generar URL del dashboard ─────────────────────────────────
    log.info(`${prefix} → [3/5] Generando URL del informe...`);

    /* Modelo de dashboard elegido en el panel (columna `dashboard_modelo`).
       Sin dato, vacío o desconocido → 'v2', y la URL queda igual que siempre.
       DASHBOARD_BASE_URL sigue mandando: solo se cambia el nombre del archivo. */
    const modeloDef = modeloDashboard(configEnvio.dashboard_modelo);
    const dashBase  = baseDashboardPara(CONFIG.dashboardBaseUrl, configEnvio.dashboard_modelo);

    if (!esModeloConocido(configEnvio.dashboard_modelo) && configEnvio.dashboard_modelo) {
      log.warn(`${prefix} → dashboard_modelo="${configEnvio.dashboard_modelo}" no reconocido — se usa ${modeloDef.id}`);
    }
    log.info(`${prefix} → Modelo de dashboard: ${modeloDef.id} (${modeloDef.archivo})`);

    const { dashboardUrl, token } = generateReportUrl({
      aliadoId,
      aliadoName:    aliadoNombre,
      excelUrl:      uploadResult.cdnUrl || uploadResult.publicUrl,
      reportUuid,
      fecha,
      dashboardBase: dashBase,
    });
    log.info(`${prefix} → URL generada: ${dashboardUrl.slice(0, 80)}...`);

    // ── PASO 5: Actualizar informe en NocoDB con URLs ─────────────────────
    if (CONFIG.tableInformes && informeId) {
      try {
        await nocoRequest(
          `/api/v2/tables/${CONFIG.tableInformes}/records/${informeId}`,
          'PATCH',
          {
            url_excel:     uploadResult.cdnUrl || uploadResult.publicUrl,
            url_dashboard: dashboardUrl,
          }
        );
      } catch (e) {
        log.warn(`${prefix} → No se pudo actualizar URL en NocoDB: ${e.message}`);
      }
    }

    // ── PASO 6: Enviar correos ────────────────────────────────────────────
    log.info(`${prefix} → [4/5] Enviando correos por EmailJS...`);
    const sendResult = await sendReportEmail({
      aliadoId,
      aliadoNombre,
      reportUuid,
      urlDashboard: dashboardUrl,
      fecha,
      kpis:         {}, // Los KPIs se calcularán al abrir el dashboard (client-side)
      informeId,
    });

    log.info(
      `${prefix} → Correos: ${sendResult.totalEnviados} enviados · ` +
      `${sendResult.totalErrores} errores · estado=${sendResult.estado}`
    );

    // ── PASO 7: Actualizar proximo_envio en aliado_config_envio ──────────
    log.info(`${prefix} → [5/5] Actualizando próximo envío...`);
    const proximoEnvio = calcularProximoEnvio(configEnvio);

    if (CONFIG.tableConfigEnvio) {
      try {
        const configId = configEnvio.Id || configEnvio.id;
        await nocoRequest(
          `/api/v2/tables/${CONFIG.tableConfigEnvio}/records/${configId}`,
          'PATCH',
          {
            ultimo_envio:  new Date().toISOString(),
            proximo_envio: proximoEnvio,
          }
        );
        log.info(`${prefix} → Próximo envío programado: ${proximoEnvio}`);
      } catch (e) {
        log.warn(`${prefix} → No se pudo actualizar proximo_envio: ${e.message}`);
      }
    }

    const durationMs = Date.now() - start;
    log.info(`${prefix} ✅ Pipeline completado en ${(durationMs / 1000).toFixed(1)}s`);

    return {
      success:      sendResult.success,
      aliadoId,
      aliadoNombre,
      reportUuid,
      urlDashboard: dashboardUrl,
      durationMs,
    };

  } catch (err) {
    const durationMs = Date.now() - start;
    log.error(`${prefix} ❌ Pipeline FALLÓ: ${err.message}`);

    // Marcar informe como error en NocoDB
    if (CONFIG.tableInformes && informeId) {
      nocoRequest(
        `/api/v2/tables/${CONFIG.tableInformes}/records/${informeId}`,
        'PATCH',
        { estado: 'error', notas: err.message }
      ).catch(e => log.warn(`No se pudo actualizar estado de error en NocoDB: ${e.message}`));
    }

    return {
      success:      false,
      aliadoId,
      aliadoNombre,
      error:        err.message,
      durationMs,
    };
  }
}

// ─── Job principal del scheduler ─────────────────────────────────────────────

/**
 * Función que se ejecuta en cada tick del cron.
 * Consulta NocoDB, procesa aliados elegibles y actualiza el estado.
 */
async function runSchedulerJob() {
  if (_isRunning) {
    log.warn('Job anterior aún en ejecución — saltando este tick');
    return;
  }

  _isRunning = true;
  _runCount++;

  const jobStart = Date.now();
  log.info(`══ Tick #${_runCount} · ${new Date().toISOString()} ══`);

  try {
    const elegibles = await getAliadosElegibles();

    if (!elegibles.length) {
      log.debug('Sin aliados elegibles en este tick.');
      return;
    }

    log.info(`${elegibles.length} aliado(s) a procesar en este tick`);

    // Procesar con concurrencia limitada
    const resultados = [];
    const lotes = [];

    for (let i = 0; i < elegibles.length; i += CONFIG.maxConcurrentAliados) {
      lotes.push(elegibles.slice(i, i + CONFIG.maxConcurrentAliados));
    }

    for (const lote of lotes) {
      const promesas = lote.map(config =>
        Promise.race([
          runPipelineForAliado(config),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Job timeout')), CONFIG.jobTimeoutMs)
          ),
        ]).catch(err => ({
          success:      false,
          aliadoId:     config.aliado_id,
          aliadoNombre: config.aliado_nombre || config.aliado_id,
          error:        err.message,
          durationMs:   CONFIG.jobTimeoutMs,
        }))
      );

      const loteResultados = await Promise.all(promesas);
      resultados.push(...loteResultados);
    }

    // Resumen del tick
    const exitosos = resultados.filter(r => r.success).length;
    const fallidos  = resultados.filter(r => !r.success).length;
    const durationTick = ((Date.now() - jobStart) / 1000).toFixed(1);

    log.info(
      `Tick #${_runCount} completado en ${durationTick}s | ` +
      `✅ ${exitosos} exitosos · ❌ ${fallidos} fallidos`
    );

    if (fallidos > 0) {
      resultados
        .filter(r => !r.success)
        .forEach(r => log.error(`  └─ FALLO: ${r.aliadoNombre} → ${r.error}`));
    }

  } catch (err) {
    log.error(`Error crítico en scheduler tick: ${err.message}`);
  } finally {
    _isRunning = false;
  }
}

// ─── Trigger manual (para RF-06 "Generar y enviar ahora") ────────────────────

/**
 * Ejecuta el pipeline para un aliado específico de forma inmediata.
 * Llamado desde api/trigger-report.js cuando el usuario presiona el botón manual.
 *
 * @param {object} params
 * @param {string} params.aliadoId
 * @param {string} [params.aliadoNombre]
 * @param {string} [params.cmsEndpoint]
 * @param {string} [params.fecha]        'YYYY-MM' — por defecto mes actual
 * @returns {Promise<PipelineResult>}
 */
async function triggerManual({ aliadoId, aliadoNombre = '', cmsEndpoint = '', fecha = null }) {
  const now     = new Date();
  const fechaFinal = fecha || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  log.info(`[MANUAL] Trigger manual para aliado ${aliadoNombre || aliadoId} / ${fechaFinal}`);

  return runPipelineForAliado({
    aliado_id:     aliadoId,
    aliado_nombre: aliadoNombre,
    cms_endpoint:  cmsEndpoint,
    frecuencia:    'manual',
    hora_envio:    '00:00',
  });
}

// ─── Iniciar el scheduler ─────────────────────────────────────────────────────

/**
 * Inicia el scheduler con node-cron.
 * Si node-cron no está instalado, muestra las instrucciones y sale.
 */
function startScheduler() {
  // Verificar que node-cron esté disponible
  let cron;
  try {
    cron = require('node-cron');
  } catch (e) {
    log.error('node-cron no está instalado. Instalar con: npm install node-cron');
    log.error('Alternativamente, usar GitHub Actions (ver README-automatizacion.md)');
    process.exit(1);
  }

  // Validar expresión cron
  if (!cron.validate(CONFIG.cronExpression)) {
    log.error(`Expresión cron inválida: "${CONFIG.cronExpression}"`);
    process.exit(1);
  }

  log.info('═══════════════════════════════════════════════════════════');
  log.info('  CIEN Report Pipeline Scheduler');
  log.info('═══════════════════════════════════════════════════════════');
  log.info(`  Cron:      ${CONFIG.cronExpression}`);
  log.info(`  Timezone:  ${CONFIG.timezone}`);
  log.info(`  NocoDB:    ${CONFIG.nocodbUrl}`);
  log.info(`  Dashboard: ${CONFIG.dashboardBaseUrl}`);
  log.info(`  Iniciado:  ${_startedAt.toISOString()}`);
  log.info('═══════════════════════════════════════════════════════════');

  // Ejecutar inmediatamente al arrancar (opcional — comentar si no se desea)
  if (process.env.RUN_ON_START === 'true') {
    log.info('RUN_ON_START=true → ejecutando primer check inmediatamente...');
    runSchedulerJob().catch(e => log.error('Error en RUN_ON_START:', e.message));
  }

  // Programar el cron
  cron.schedule(CONFIG.cronExpression, runSchedulerJob, {
    timezone: CONFIG.timezone,
  });

  log.info(`Scheduler activo. Próxima ejecución según: ${CONFIG.cronExpression}`);

  // Health check endpoint simple (opcional)
  if (process.env.HEALTH_CHECK_PORT) {
    const port = parseInt(process.env.HEALTH_CHECK_PORT);
    const { createServer } = require('http');
    createServer((req, res) => {
      const status = {
        ok:         true,
        uptime:     Math.round((Date.now() - _startedAt.getTime()) / 1000),
        runCount:   _runCount,
        isRunning:  _isRunning,
        startedAt:  _startedAt.toISOString(),
        cron:       CONFIG.cronExpression,
        timezone:   CONFIG.timezone,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    }).listen(port, () => log.info(`Health check en http://localhost:${port}`));
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  runSchedulerJob,
  runPipelineForAliado,
  triggerManual,
  calcularProximoEnvio,
  getAliadosElegibles,
  CONFIG,
};

// ─── Punto de entrada ─────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  // Modo trigger manual: node scheduler.js --trigger --aliado=ID [--fecha=YYYY-MM]
  if (args.includes('--trigger')) {
    const argMap = Object.fromEntries(
      args.filter(a => a.startsWith('--')).map(a => {
        const [k, ...rest] = a.slice(2).split('=');
        return [k, rest.join('=') || true];
      })
    );

    const { aliado, nombre, fecha, endpoint } = argMap;
    if (!aliado) {
      console.error('Uso: node scheduler.js --trigger --aliado=ID [--nombre=NOMBRE] [--fecha=YYYY-MM] [--endpoint=URL]');
      process.exit(1);
    }

    triggerManual({ aliadoId: aliado, aliadoNombre: nombre || '', cmsEndpoint: endpoint || '', fecha: fecha || null })
      .then(result => {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
      })
      .catch(err => { console.error(err.message); process.exit(1); });

  } else {
    // Modo scheduler normal
    startScheduler();
  }
}
