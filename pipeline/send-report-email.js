/**
 * pipeline/send-report-email.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Envía el correo de informe CIEN a los contactos de un aliado usando la
 * EmailJS HTTP REST API (compatible con Node.js — no requiere browser SDK).
 *
 * Flujo:
 *   1. Recibe los datos del informe (uuid, URL dashboard, KPIs calculados)
 *   2. Obtiene los contactos de envío del aliado desde NocoDB
 *   3. Envía un correo individual a cada contacto (loop)
 *   4. Registra el resultado de cada envío en NocoDB:
 *      - PATCH aliado_informes.estado → 'enviado' | 'enviado_parcial' | 'error'
 *      - PATCH aliado_informes.correos_enviados → array con estados individuales
 *   5. Retorna un resumen del resultado del envío
 *
 * EmailJS HTTP API:
 *   POST https://api.emailjs.com/api/v1.0/email/send
 *   Body: { service_id, template_id, template_params, user_id, accessToken }
 *   Docs: https://www.emailjs.com/docs/rest-api/send/
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https = require('https');

// ─── Configuración ───────────────────────────────────────────────────────────
const CONFIG = {
  // EmailJS — claves del proyecto (del js/config.js existente)
  emailjsApiUrl:   'https://api.emailjs.com/api/v1.0/email/send',
  serviceId:       process.env.EMAILJS_SERVICE_ID  || 'service_nndjw6q',
  templateId:      process.env.EMAILJS_TEMPLATE_ID || 'template_xx6ptyn',
  publicKey:       process.env.EMAILJS_PUBLIC_KEY  || '0jOVta13ChggBuK11',
  privateKey:      process.env.EMAILJS_PRIVATE_KEY || '',  // REQUERIDO para HTTP API

  // NocoDB
  nocodbUrl:              process.env.NOCODB_API_URL                   || 'https://app.nocodb.com',
  nocodbToken:            process.env.NOCODB_API_TOKEN                 || 'nc_pat_CBC1DGXT50w5Bt5L-MJOk1-2EB2x8vt1XchjWgg0',
  tableInformes:          process.env.NOCODB_TABLE_ALIADO_INFORMES     || 'm4twk0jq7wduk62',
  tableAliados:           process.env.NOCODB_TABLE_ALIADOS             || 'menim7g7ba864x4',
  tableContactos:         process.env.NOCODB_TABLE_CONTACTOS           || '',

  // Configuración de envío
  maxRecipientsPerReport: parseInt(process.env.MAX_RECIPIENTS || '10'),
  requestTimeoutMs:       parseInt(process.env.EMAILJS_TIMEOUT_MS || '15000'),
  retryBaseMs:            2000,
  maxRetries:             3,

  // Reply-to por defecto
  replyTo: process.env.ADMIN_EMAIL || 'informes@cien.app',
};

// ─── NocoDB HTTP helper ──────────────────────────────────────────────────────

/**
 * Realiza una petición HTTPS a NocoDB.
 * @param {string} endpoint   Ruta relativa (ej: '/api/v2/tables/abc/records')
 * @param {string} method     HTTP method
 * @param {object} [body]     Body JSON (para POST/PATCH)
 * @returns {Promise<object>}
 */
async function nocoRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(CONFIG.nocodbUrl + endpoint);
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method,
      headers: {
        'xc-token':     CONFIG.nocodbToken,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: CONFIG.requestTimeoutMs,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            reject(new Error(`NocoDB ${method} ${endpoint} → HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          resolve(res.statusCode === 204 ? {} : JSON.parse(data));
        } catch (e) {
          reject(new Error(`Error parsing NocoDB response: ${e.message} — ${data.slice(0, 100)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`NocoDB timeout: ${endpoint}`)); });
    req.on('error', reject);

    if (payload) req.write(payload);
    req.end();
  });
}

// ─── EmailJS HTTP helper ─────────────────────────────────────────────────────

/**
 * Envía un correo usando la EmailJS HTTP REST API.
 * @param {object} templateParams  Variables de la plantilla EmailJS
 * @returns {Promise<{ok:boolean, status:number, body:string}>}
 */
async function emailjsSend(templateParams) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      service_id:      CONFIG.serviceId,
      template_id:     CONFIG.templateId,
      user_id:         CONFIG.publicKey,
      accessToken:     CONFIG.privateKey, // Requerido para Node.js (no browser)
      template_params: templateParams,
    });

    const options = {
      hostname: 'api.emailjs.com',
      port:     443,
      path:     '/api/v1.0/email/send',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Origin':         'https://cien.app',
        'User-Agent':     'CIEN-Report-Pipeline/1.0',
      },
      timeout: CONFIG.requestTimeoutMs,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('EmailJS request timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Obtener contactos de envío del aliado ───────────────────────────────────

/**
 * Obtiene la lista de correos de envío del aliado desde NocoDB.
 * Busca en la tabla de contactos del aliado o en campos del aliado directamente.
 *
 * @param {string} aliadoId
 * @returns {Promise<ContactoEnvio[]>}
 *
 * @typedef {object} ContactoEnvio
 * @property {string} email
 * @property {string} nombre
 */
async function getContactosEnvio(aliadoId) {
  const contactos = [];

  // ── Estrategia 1: Tabla de contactos relacionada ──────────────────────
  if (CONFIG.tableContactos) {
    try {
      const where = encodeURIComponent(`(aliado_id,eq,${aliadoId})~and(envio_informe,eq,true)`);
      const res = await nocoRequest(
        `/api/v2/tables/${CONFIG.tableContactos}/records?where=${where}&limit=20`
      );

      const rows = res.list || res.data || [];
      rows.forEach(r => {
        const email = r.email || r.correo || r.Email || r.Correo;
        const nombre = r.nombre || r.name  || r.Nombre || r.Name || '';
        if (email && email.includes('@')) {
          contactos.push({ email: email.trim().toLowerCase(), nombre: nombre.trim() });
        }
      });
    } catch (err) {
      console.warn(`[Email] Aviso: No se pudo acceder a tabla de contactos: ${err.message}`);
    }
  }

  // ── Estrategia 2: Campos del registro del aliado ──────────────────────
  if (!contactos.length) {
    try {
      const res = await nocoRequest(
        `/api/v2/tables/${CONFIG.tableAliados}/records/${aliadoId}`
      );

      // Intentar varios campos posibles donde puedan estar los correos
      const posiblesEmails = [
        res.emails_copia, res.email_contacto, res.correo_contacto,
        res.email, res.correo, res.Email, res.Correo,
        res.email_informe, res.correos_envio,
      ].filter(Boolean);

      posiblesEmails.forEach(val => {
        const emails = String(val).split(/[,;\n]/).map(e => e.trim()).filter(e => e.includes('@'));
        emails.forEach(email => {
          if (!contactos.some(c => c.email === email.toLowerCase())) {
            contactos.push({
              email:  email.toLowerCase(),
              nombre: res.nombre || res.name || res.Nombre || res.Name || 'Aliado',
            });
          }
        });
      });
    } catch (err) {
      console.warn(`[Email] Aviso: No se pudo leer el registro del aliado: ${err.message}`);
    }
  }

  // Limitar el número de destinatarios por seguridad
  return contactos.slice(0, CONFIG.maxRecipientsPerReport);
}

// ─── Formatear KPIs para el correo ──────────────────────────────────────────

/**
 * Da formato a los valores KPI para incluirlos en el correo.
 * @param {object} kpis
 * @returns {object} KPIs formateados como strings
 */
function formatKpisForEmail(kpis = {}) {
  const fmt = (n, decimals = 0) => {
    if (n === null || n === undefined || isNaN(Number(n))) return '—';
    const num = Number(n);
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + ' M';
    if (num >= 1_000)     return num.toLocaleString('es-CO', { maximumFractionDigits: decimals });
    return num.toFixed(decimals);
  };

  // Leer valores con ambas nomenclaturas (camelCase y snake_case)
  const sesiones  = kpis.total_sesiones  ?? kpis.totalSesiones  ?? null;
  const usuarios  = kpis.usuarios_unicos ?? kpis.usuariosUnicos  ?? null;
  const kwh       = kpis.kwh_total       ?? kpis.kwhTotal        ?? null;
  const ingresos  = kpis.ingresos_netos  ?? kpis.ingresosNetos   ?? null;
  const ocupacion = kpis.tasa_ocupacion  ?? kpis.tasaOcupacion   ?? null;

  return {
    total_sesiones:  sesiones  !== null ? fmt(sesiones)            : '—',
    usuarios_unicos: usuarios  !== null ? fmt(usuarios)            : '—',
    kwh_total:       kwh       !== null ? fmt(kwh, 1) + ' kWh'    : '—',
    ingresos_netos:  ingresos  !== null ? '$' + fmt(ingresos)      : '—',
    tasa_ocupacion:  ocupacion !== null ? Number(ocupacion).toFixed(1) + '%' : 'Ver dashboard',
  };
}

/**
 * Genera la etiqueta del período cubierto.
 * @param {string} fecha  'YYYY-MM' o meses separados por coma
 * @returns {string}      Ej: 'Agosto 2026' | 'Julio – Agosto 2026'
 */
function generarPeriodoLabel(fecha) {
  const MESES = [
    'Enero','Febrero','Marzo','Abril','Mayo','Junio',
    'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'
  ];

  if (!fecha) return 'Período no especificado';

  // Si es un rango 'YYYY-MM,YYYY-MM'
  if (fecha.includes(',')) {
    const partes  = fecha.split(',').map(f => f.trim());
    const primera = partes[0].split('-');
    const ultima  = partes[partes.length - 1].split('-');
    if (primera[0] === ultima[0]) {
      return `${MESES[parseInt(primera[1]) - 1]} – ${MESES[parseInt(ultima[1]) - 1]} ${primera[0]}`;
    }
    return `${MESES[parseInt(primera[1]) - 1]} ${primera[0]} – ${MESES[parseInt(ultima[1]) - 1]} ${ultima[0]}`;
  }

  // Mes único: 'YYYY-MM'
  const [year, month] = fecha.split('-');
  return `${MESES[parseInt(month) - 1]} ${year}`;
}

// ─── Función principal de envío ──────────────────────────────────────────────

/**
 * Envía el correo de informe CIEN al aliado y registra el resultado en NocoDB.
 *
 * @param {object} params
 * @param {string}  params.aliadoId         ID del aliado en NocoDB
 * @param {string}  params.aliadoNombre      Nombre del aliado (para el correo)
 * @param {string}  params.reportUuid        UUID único del informe
 * @param {string}  params.urlDashboard      URL completa del dashboard con params
 * @param {string}  params.fecha             'YYYY-MM' del período
 * @param {object}  params.kpis             KPIs del informe (sesiones, kWh, etc.)
 * @param {string}  [params.informeId]       ID del registro en aliado_informes (para PATCH)
 * @param {ContactoEnvio[]} [params.contactos]  Lista manual de contactos (opcional)
 *
 * @returns {Promise<SendResult>}
 *
 * @typedef {object} SendResult
 * @property {boolean}  success          true si al menos 1 correo fue enviado
 * @property {string}   estado           'enviado' | 'enviado_parcial' | 'error'
 * @property {number}   totalEnviados    Número de correos enviados exitosamente
 * @property {number}   totalErrores     Número de correos con error
 * @property {object[]} detalles         Estado de cada correo individual
 * @property {string}   [notas]          Mensaje de error si estado === 'error'
 */
async function sendReportEmail({
  aliadoId,
  aliadoNombre,
  reportUuid,
  urlDashboard,
  fecha,
  kpis = {},
  informeId = null,
  contactos: contactosManuales = null,
}) {
  const logPrefix = `[Email] ${aliadoNombre || aliadoId} | ${reportUuid.slice(0, 8)}…`;
  console.log(`${logPrefix} → Iniciando envío de informe...`);

  if (!CONFIG.privateKey) {
    throw new Error(
      'EMAILJS_PRIVATE_KEY no configurado. Esta key es requerida para el envío server-side. ' +
      'Obtenerla en: https://dashboard.emailjs.com/admin/account'
    );
  }

  // ── 1. Obtener contactos ──────────────────────────────────────────────────
  // Si vienen pre-cargados desde run-once.js (ya se hizo el GET del aliado),
  // usarlos directamente sin hacer otra llamada a NocoDB (evita HTTP 429).
  let contactos = contactosManuales;
  if (!contactos || !contactos.length) {
    console.log(`${logPrefix} → Obteniendo contactos desde NocoDB...`);
    contactos = await getContactosEnvio(aliadoId);
  } else {
    console.log(`${logPrefix} → Usando ${contactos.length} contacto(s) pre-cargados (sin llamada extra a NocoDB)`);
  }

  if (!contactos.length) {
    const msg = `No se encontraron contactos de envío para el aliado ${aliadoId}`;
    console.warn(`${logPrefix} ⚠️ ${msg}`);
    await _actualizarEstadoInforme(informeId, 'error', [], msg);
    return {
      success:       false,
      estado:        'error',
      totalEnviados: 0,
      totalErrores:  0,
      detalles:      [],
      notas:         msg,
    };
  }

  console.log(`${logPrefix} → ${contactos.length} contacto(s) encontrado(s)`);

  // ── 2. Preparar datos del correo ──────────────────────────────────────────
  const kpisFormateados = formatKpisForEmail(kpis);
  const periodo         = generarPeriodoLabel(fecha);
  const fechaGeneracion = new Date().toLocaleDateString('es-CO', {
    day: '2-digit', month: 'long', year: 'numeric'
  });

  // ── 3. Enviar un correo por cada contacto ─────────────────────────────────
  const detalles = [];
  let totalEnviados = 0;
  let totalErrores  = 0;

  for (const contacto of contactos) {
    const templateParams = {
      // Datos del aliado
      aliado_name:     aliadoNombre || 'Aliado CIEN',
      to_name:         contacto.nombre || aliadoNombre || 'Equipo',
      to_email:        contacto.email,
      reply_to:        CONFIG.replyTo,

      // Datos del informe
      periodo,
      url_informe:     urlDashboard,
      fecha_generacion: fechaGeneracion,
      año_actual:      String(new Date().getFullYear()),

      // KPIs formateados
      total_sesiones:  kpisFormateados.total_sesiones,
      usuarios_unicos: kpisFormateados.usuarios_unicos,
      kwh_total:       kpisFormateados.kwh_total,
      ingresos_netos:  kpisFormateados.ingresos_netos,
      tasa_ocupacion:  kpisFormateados.tasa_ocupacion,

      // Metadata interna (para trazabilidad en EmailJS Activity)
      report_uuid:     reportUuid,
      aliado_id:       aliadoId,
    };

    // Reintentos por contacto
    let enviado = false;
    let errorMsg = '';

    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
      try {
        console.log(`${logPrefix} → Enviando a ${contacto.email} (intento ${attempt}/${CONFIG.maxRetries})...`);
        const result = await emailjsSend(templateParams);

        if (result.ok) {
          enviado = true;
          totalEnviados++;
          console.log(`${logPrefix} ✅ Enviado a ${contacto.email}`);
          break;
        } else {
          errorMsg = `EmailJS HTTP ${result.status}: ${result.body.slice(0, 100)}`;
          console.warn(`${logPrefix} ⚠️ Intento ${attempt} fallido para ${contacto.email}: ${errorMsg}`);
        }
      } catch (err) {
        errorMsg = err.message;
        console.warn(`${logPrefix} ⚠️ Intento ${attempt} error para ${contacto.email}: ${errorMsg}`);
      }

      if (attempt < CONFIG.maxRetries) {
        await new Promise(r => setTimeout(r, CONFIG.retryBaseMs * attempt));
      }
    }

    if (!enviado) totalErrores++;

    detalles.push({
      email:     contacto.email,
      nombre:    contacto.nombre,
      estado:    enviado ? 'enviado' : 'error',
      timestamp: new Date().toISOString(),
      error:     enviado ? null : errorMsg,
    });

    // Pequeña pausa entre envíos para no saturar la API de EmailJS
    if (contactos.length > 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // ── 4. Determinar estado global del informe ───────────────────────────────
  let estadoGlobal;
  if (totalEnviados === 0) {
    estadoGlobal = 'error';
  } else if (totalErrores > 0) {
    estadoGlobal = 'enviado_parcial';
  } else {
    estadoGlobal = 'enviado';
  }

  console.log(
    `${logPrefix} → Resultado: ${estadoGlobal} | ` +
    `✅ ${totalEnviados} enviados · ❌ ${totalErrores} errores`
  );

  // ── 5. Actualizar aliado_informes en NocoDB ───────────────────────────────
  await _actualizarEstadoInforme(
    informeId,
    estadoGlobal,
    detalles,
    totalErrores > 0
      ? `${totalErrores} correo(s) fallaron de ${contactos.length}: ${detalles.filter(d => d.error).map(d => d.email).join(', ')}`
      : null
  );

  return {
    success:       totalEnviados > 0,
    estado:        estadoGlobal,
    totalEnviados,
    totalErrores,
    detalles,
    notas:         estadoGlobal !== 'enviado'
      ? `${totalErrores}/${contactos.length} correos fallaron`
      : null,
  };
}

// ─── Actualizar estado del informe en NocoDB ─────────────────────────────────

/**
 * Actualiza el estado del informe en aliado_informes tras el envío.
 * @param {string|null} informeId
 * @param {string}      estado
 * @param {object[]}    detalles
 * @param {string|null} notas
 */
async function _actualizarEstadoInforme(informeId, estado, detalles, notas = null) {
  if (!informeId || !CONFIG.tableInformes) {
    console.warn('[Email] No se puede actualizar NocoDB: informeId o tableInformes no configurado.');
    return;
  }

  const patchData = {
    estado,
    fecha_envio:       new Date().toISOString(),
    correos_enviados:  JSON.stringify(detalles),
    ...(notas ? { notas } : {}),
  };

  try {
    // NocoDB V2 PATCH: el Id va en el body, no en la URL
    await nocoRequest(
      `/api/v2/tables/${CONFIG.tableInformes}/records`,
      'PATCH',
      { Id: Number(informeId) || informeId, ...patchData }
    );
    console.log(`[Email] NocoDB actualizado: informe ${informeId} → ${estado}`);
  } catch (err) {
    console.error(`[Email] Error al actualizar NocoDB (informe ${informeId}): ${err.message}`);
    // No relanzar — el envío ya ocurrió, no queremos que un error de BD bloquee el pipeline
  }
}

// ─── Exportar reportes de debugging ──────────────────────────────────────────

/**
 * Verifica la configuración de EmailJS haciendo un envío de prueba.
 * Útil para validar que EMAILJS_PRIVATE_KEY es válida antes del pipeline real.
 *
 * @param {string} testEmail  Correo destino para el test
 * @returns {Promise<{ok:boolean, status:number, body:string}>}
 */
async function testEmailjsConfig(testEmail) {
  if (!testEmail || !testEmail.includes('@')) {
    throw new Error('testEmail debe ser una dirección válida');
  }

  console.log(`[Email] Enviando correo de prueba a ${testEmail}...`);

  const result = await emailjsSend({
    aliado_name:      'Prueba CIEN Pipeline',
    to_name:          'Equipo Técnico',
    to_email:         testEmail,
    reply_to:         CONFIG.replyTo,
    periodo:          'Test ' + new Date().toISOString().slice(0, 7),
    url_informe:      'https://cien.app/dashboard/cien-dashboard-v2.html?test=1',
    fecha_generacion: new Date().toLocaleDateString('es-CO'),
    año_actual:       String(new Date().getFullYear()),
    total_sesiones:   '—',
    usuarios_unicos:  '—',
    kwh_total:        '—',
    ingresos_netos:   '—',
    tasa_ocupacion:   '—',
    report_uuid:      'test-' + Date.now(),
    aliado_id:        'test',
  });

  console.log(`[Email] Test ${result.ok ? '✅ OK' : '❌ FAIL'} | HTTP ${result.status}: ${result.body}`);
  return result;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  sendReportEmail,
  getContactosEnvio,
  formatKpisForEmail,
  generarPeriodoLabel,
  testEmailjsConfig,
  CONFIG,
};

// ─── CLI standalone ───────────────────────────────────────────────────────────
// node pipeline/send-report-email.js --test-email=xxx@example.com
// node pipeline/send-report-email.js --aliado=ID --nombre="Nombre Aliado" --fecha=2026-08
//                                    --url=URL_DASHBOARD --uuid=REPORT_UUID
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });

  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => {
        const [k, ...rest] = a.slice(2).split('=');
        return [k, rest.join('=') || true];
      })
  );

  if (args['test-email']) {
    testEmailjsConfig(args['test-email'])
      .then(r => { console.log(r); process.exit(r.ok ? 0 : 1); })
      .catch(err => { console.error(err.message); process.exit(1); });
    return;
  }

  const { aliado, nombre, fecha, url, uuid, 'informe-id': informeId } = args;

  if (!aliado || !url || !uuid) {
    console.error('Uso:');
    console.error('  node send-report-email.js --test-email=xxx@example.com');
    console.error('  node send-report-email.js --aliado=ID --nombre="Nombre" --fecha=YYYY-MM --url=URL --uuid=UUID [--informe-id=ID]');
    process.exit(1);
  }

  sendReportEmail({
    aliadoId:     aliado,
    aliadoNombre: nombre || '',
    reportUuid:   uuid,
    urlDashboard: url,
    fecha:        fecha || new Date().toISOString().slice(0, 7),
    kpis:         {},
    informeId:    informeId || null,
  })
    .then(result => {
      console.log('\n📧 Resultado del envío:');
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch(err => {
      console.error('\n❌ Error:', err.message);
      process.exit(1);
    });
}
