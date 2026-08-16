/**
 * pipeline/send-report-email.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Envía el correo de informe CIEN via EmailJS HTTP REST API.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const https = require('https');

const CONFIG = {
  emailjsApiUrl:          'https://api.emailjs.com/api/v1.0/email/send',
  serviceId:              process.env.EMAILJS_SERVICE_ID  || 'service_nndjw6q',
  templateId:             process.env.EMAILJS_TEMPLATE_ID || 'template_xx6ptyn',
  publicKey:              process.env.EMAILJS_PUBLIC_KEY  || '0jOVta13ChggBuK11',
  privateKey:             process.env.EMAILJS_PRIVATE_KEY || '',
  nocodbUrl:              process.env.NOCODB_API_URL                   || 'https://app.nocodb.com',
  nocodbToken:            process.env.NOCODB_API_TOKEN                 || 'nc_pat_CBC1DGXT50w5Bt5L-MJOk1-2EB2x8vt1XchjWgg0',
  tableInformes:          process.env.NOCODB_TABLE_ALIADO_INFORMES     || 'm4twk0jq7wduk62',
  tableAliados:           process.env.NOCODB_TABLE_ALIADOS             || 'menim7g7ba864x4',
  tableContactos:         process.env.NOCODB_TABLE_CONTACTOS           || '',
  maxRecipientsPerReport: parseInt(process.env.MAX_RECIPIENTS          || '10'),
  requestTimeoutMs:       parseInt(process.env.EMAILJS_TIMEOUT_MS      || '15000'),
  retryBaseMs:            2000,
  maxRetries:             3,
  replyTo:                process.env.ADMIN_EMAIL || 'informes@cien.app',
};

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
          if (res.statusCode >= 400) { reject(new Error(`NocoDB ${method} ${endpoint} → HTTP ${res.statusCode}: ${data.slice(0,200)}`)); return; }
          resolve(res.statusCode === 204 ? {} : JSON.parse(data));
        } catch (e) { reject(new Error(`Error parsing NocoDB response: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`NocoDB timeout: ${endpoint}`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function emailjsSend(templateParams) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      service_id:      CONFIG.serviceId,
      template_id:     CONFIG.templateId,
      user_id:         CONFIG.publicKey,
      accessToken:     CONFIG.privateKey,
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

async function getContactosEnvio(aliadoId) {
  const contactos = [];

  if (CONFIG.tableContactos) {
    try {
      const where = encodeURIComponent(`(aliado_id,eq,${aliadoId})~and(envio_informe,eq,true)`);
      const res   = await nocoRequest(`/api/v2/tables/${CONFIG.tableContactos}/records?where=${where}&limit=20`);
      const rows  = res.list || res.data || [];
      rows.forEach(r => {
        const email  = r.email || r.correo || r.Email || r.Correo;
        const nombre = r.nombre || r.name  || r.Nombre || r.Name || '';
        if (email && email.includes('@')) contactos.push({ email: email.trim().toLowerCase(), nombre: nombre.trim() });
      });
    } catch (err) { console.warn(`[Email] No se pudo acceder a tabla de contactos: ${err.message}`); }
  }

  if (!contactos.length) {
    try {
      const res = await nocoRequest(`/api/v2/tables/${CONFIG.tableAliados}/records/${aliadoId}`);
      const posiblesEmails = [
        res.email_contacto, res.correo_contacto, res.email, res.correo,
        res.Email, res.Correo, res.email_informe, res.correos_envio,
      ].filter(Boolean);
      posiblesEmails.forEach(val => {
        String(val).split(/[,;\n]/).map(e => e.trim()).filter(e => e.includes('@')).forEach(email => {
          if (!contactos.some(c => c.email === email.toLowerCase())) {
            contactos.push({ email: email.toLowerCase(), nombre: res.nombre || res.name || res.Nombre || 'Aliado' });
          }
        });
      });
    } catch (err) { console.warn(`[Email] No se pudo leer registro del aliado: ${err.message}`); }
  }

  return contactos.slice(0, CONFIG.maxRecipientsPerReport);
}

function formatKpisForEmail(kpis = {}) {
  const fmt = (n, d = 0) => {
    if (n === null || n === undefined || isNaN(Number(n))) return '—';
    const num = Number(n);
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + ' M';
    if (num >= 1_000)     return num.toLocaleString('es-CO', { maximumFractionDigits: d });
    return num.toFixed(d);
  };
  return {
    total_sesiones:  fmt(kpis.totalSesiones  || kpis.total_sesiones  || 0),
    usuarios_unicos: fmt(kpis.usuariosUnicos  || kpis.usuarios_unicos || 0),
    kwh_total:       fmt(kpis.kwhTotal        || kpis.kwh_total       || 0, 1) + ' kWh',
    ingresos_netos:  '$' + fmt(kpis.ingresosNetos || kpis.ingresos_netos || 0),
    tasa_ocupacion:  (kpis.tasaOcupacion || kpis.tasa_ocupacion)
      ? Number(kpis.tasaOcupacion || kpis.tasa_ocupacion).toFixed(1) + '%' : 'N/D',
  };
}

function generarPeriodoLabel(fecha) {
  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  if (!fecha) return 'Período no especificado';
  if (fecha.includes(',')) {
    const partes  = fecha.split(',').map(f => f.trim());
    const primera = partes[0].split('-');
    const ultima  = partes[partes.length - 1].split('-');
    if (primera[0] === ultima[0])
      return `${MESES[parseInt(primera[1])-1]} – ${MESES[parseInt(ultima[1])-1]} ${primera[0]}`;
    return `${MESES[parseInt(primera[1])-1]} ${primera[0]} – ${MESES[parseInt(ultima[1])-1]} ${ultima[0]}`;
  }
  const [year, month] = fecha.split('-');
  return `${MESES[parseInt(month) - 1]} ${year}`;
}

async function _actualizarEstadoInforme(informeId, estado, detalles, notas = null) {
  if (!informeId || !CONFIG.tableInformes) return;
  try {
    await nocoRequest(`/api/v2/tables/${CONFIG.tableInformes}/records/${informeId}`, 'PATCH', {
      estado,
      fecha_envio:      new Date().toISOString(),
      correos_enviados: JSON.stringify(detalles),
      ...(notas ? { notas } : {}),
    });
    console.log(`[Email] NocoDB actualizado: informe ${informeId} → ${estado}`);
  } catch (err) {
    console.error(`[Email] Error al actualizar NocoDB: ${err.message}`);
  }
}

async function sendReportEmail({ aliadoId, aliadoNombre, reportUuid, urlDashboard, fecha, kpis = {}, informeId = null, contactos: contactosManuales = null }) {
  const logPrefix = `[Email] ${aliadoNombre || aliadoId} | ${reportUuid.slice(0, 8)}…`;
  console.log(`${logPrefix} → Iniciando envío...`);

  if (!CONFIG.privateKey) {
    throw new Error('EMAILJS_PRIVATE_KEY no configurado. Obtenerla en: https://dashboard.emailjs.com/admin/account');
  }

  let contactos = contactosManuales;
  if (!contactos || !contactos.length) {
    console.log(`${logPrefix} → Obteniendo contactos desde NocoDB...`);
    contactos = await getContactosEnvio(aliadoId);
  }

  if (!contactos.length) {
    const msg = `No se encontraron contactos de envío para el aliado ${aliadoId}`;
    console.warn(`${logPrefix} ⚠️ ${msg}`);
    await _actualizarEstadoInforme(informeId, 'error', [], msg);
    return { success: false, estado: 'error', totalEnviados: 0, totalErrores: 0, detalles: [], notas: msg };
  }

  console.log(`${logPrefix} → ${contactos.length} contacto(s)`);

  const kpisF           = formatKpisForEmail(kpis);
  const periodo         = generarPeriodoLabel(fecha);
  const fechaGeneracion = new Date().toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });

  const detalles = [];
  let totalEnviados = 0;
  let totalErrores  = 0;

  for (const contacto of contactos) {
    const templateParams = {
      aliado_name:      aliadoNombre || 'Aliado CIEN',
      to_name:          contacto.nombre || aliadoNombre || 'Equipo',
      to_email:         contacto.email,
      reply_to:         CONFIG.replyTo,
      periodo,
      url_informe:      urlDashboard,
      fecha_generacion: fechaGeneracion,
      año_actual:       String(new Date().getFullYear()),
      total_sesiones:   kpisF.total_sesiones,
      usuarios_unicos:  kpisF.usuarios_unicos,
      kwh_total:        kpisF.kwh_total,
      ingresos_netos:   kpisF.ingresos_netos,
      tasa_ocupacion:   kpisF.tasa_ocupacion,
      report_uuid:      reportUuid,
      aliado_id:        aliadoId,
    };

    let enviado = false;
    let errorMsg = '';

    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
      try {
        console.log(`${logPrefix} → Enviando a ${contacto.email} (intento ${attempt})...`);
        const result = await emailjsSend(templateParams);
        if (result.ok) { enviado = true; totalEnviados++; console.log(`${logPrefix} ✅ Enviado a ${contacto.email}`); break; }
        else { errorMsg = `EmailJS HTTP ${result.status}: ${result.body.slice(0,100)}`; }
      } catch (err) { errorMsg = err.message; }
      if (attempt < CONFIG.maxRetries) await new Promise(r => setTimeout(r, CONFIG.retryBaseMs * attempt));
    }

    if (!enviado) totalErrores++;
    detalles.push({ email: contacto.email, nombre: contacto.nombre, estado: enviado ? 'enviado' : 'error', timestamp: new Date().toISOString(), error: enviado ? null : errorMsg });
    if (contactos.length > 1) await new Promise(r => setTimeout(r, 500));
  }

  const estadoGlobal = totalEnviados === 0 ? 'error' : totalErrores > 0 ? 'enviado_parcial' : 'enviado';
  console.log(`${logPrefix} → ${estadoGlobal} | ✅ ${totalEnviados} · ❌ ${totalErrores}`);

  await _actualizarEstadoInforme(informeId, estadoGlobal, detalles,
    totalErrores > 0 ? `${totalErrores} correo(s) fallaron: ${detalles.filter(d => d.error).map(d => d.email).join(', ')}` : null
  );

  return { success: totalEnviados > 0, estado: estadoGlobal, totalEnviados, totalErrores, detalles };
}

module.exports = { sendReportEmail, getContactosEnvio, formatKpisForEmail, generarPeriodoLabel, CONFIG };

if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
  const args = Object.fromEntries(
    process.argv.slice(2).filter(a => a.startsWith('--'))
      .map(a => { const [k, ...rest] = a.slice(2).split('='); return [k, rest.join('=') || true]; })
  );
  const { aliado, nombre, fecha, url, uuid } = args;
  if (!aliado || !url || !uuid) {
    console.error('Uso: node send-report-email.js --aliado=ID --nombre="Nombre" --fecha=YYYY-MM --url=URL --uuid=UUID');
    process.exit(1);
  }
  sendReportEmail({ aliadoId: aliado, aliadoNombre: nombre || '', reportUuid: uuid, urlDashboard: url, fecha: fecha || new Date().toISOString().slice(0,7), kpis: {} })
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(r.success ? 0 : 1); })
    .catch(err => { console.error('❌', err.message); process.exit(1); });
}
