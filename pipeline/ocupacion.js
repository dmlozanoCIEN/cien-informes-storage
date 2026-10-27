/**
 * pipeline/ocupacion.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cálculo de la TASA DE OCUPACIÓN de los cargadores a partir de las sesiones
 * del Excel CIEN. Antes este KPI nacía siempre `null` y el correo mostraba el
 * texto "Ver dashboard"; este módulo lo calcula de verdad.
 *
 * Definición usada (ocupación de tiempo del cargador):
 *
 *     ocupación(día) = Σ(CHARGING DURATION + IDLING DURATION) de ese día
 *                      ÷ (nº de EVSE distintos de ese día × minutos de ventana)
 *                      × 100
 *
 * · CHARGING DURATION  → tiempo entregando energía.
 * · IDLING DURATION    → tiempo conectado tras terminar la carga. El vehículo
 *                        sigue ocupando el cargador, por eso se suma (se puede
 *                        excluir con { incluirIdling: false }).
 * · VENTANA DE OPERACIÓN: 15 horas = 900 minutos. La tasa mide qué parte de la
 *   jornada operativa estuvo ocupado cada cargador, NO qué parte del día
 *   natural. Un cargador solo puede estar ocupado mientras la sede opera.
 * · EXCEPCIÓN: el ÚLTIMO día presente en el archivo se acota a la hora de la
 *   última sesión, porque el Excel se exporta a mitad de jornada. Si no se
 *   acotara, el correo del día en curso saldría artificialmente bajo.
 *
 * El resultado se topa a 100 % (una tasa superior solo puede venir de datos
 * inconsistentes, nunca se debe mostrar un 143 % en un correo).
 *
 * Es un módulo Node y también se puede cargar en el navegador: deja la API en
 * `window.Ocupacion` para poder probarlo sin Node.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

/* MIN_POR_DIA solo se usa para convertir "fracciones de día" del formato
   interno de Excel (0.05 = 1,2 h). NO es la ventana de ocupación. */
const MIN_POR_DIA = 1440;

/* Jornada de operación de las sedes CIEN: 15 horas = 900 minutos.
   Es el denominador de la tasa de ocupación: no se mide contra las 24 h del
   día natural, sino contra el tiempo en que la sede realmente opera. */
const VENTANA_OPERACION_MIN = 900;

// ─── parseDuracionMin(): "01:12:18" → 72.3 minutos ──────────────────────────
// Acepta los formatos que aparecen en el Excel CIEN y en exports similares:
//   "01:12:18"  → 72.3      (H:MM:SS)
//   "72:30"     → 72.5      (MM:SS)
//   "1h 12m"    → 72        (texto libre)
//   0.05        → 72        (fracción de día de Excel)
//   72          → 72        (minutos ya calculados)
function parseDuracionMin(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return raw.getHours() * 60 + raw.getMinutes() + raw.getSeconds() / 60;
  }

  if (typeof raw === 'number') {
    if (!isFinite(raw) || raw < 0) return null;
    if (raw < 1) return raw * MIN_POR_DIA;   // fracción de día (formato Excel)
    return raw;                               // ya son minutos
  }

  const s = String(raw).trim();
  if (!s) return null;

  // H:MM:SS  ·  H:MM  ·  MM:SS
  let m = s.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const c = m[3] !== undefined ? parseInt(m[3], 10) : null;
    if (b > 59 || (c !== null && c > 59)) return null;
    return c === null ? a + b / 60 : a * 60 + b + c / 60;
  }

  // "1h 12m 30s" / "1 h 12 m"
  m = s.match(/^(?:(\d+(?:[.,]\d+)?)\s*h)?\s*(?:(\d+(?:[.,]\d+)?)\s*m)?\s*(?:(\d+(?:[.,]\d+)?)\s*s)?$/i);
  if (m && (m[1] || m[2] || m[3])) {
    const h  = m[1] ? parseFloat(m[1].replace(',', '.')) : 0;
    const mi = m[2] ? parseFloat(m[2].replace(',', '.')) : 0;
    const se = m[3] ? parseFloat(m[3].replace(',', '.')) : 0;
    return h * 60 + mi + se / 60;
  }

  return null;
}

// ─── parseHoraMinuto(): "Oct 25, 2026, 9:20 PM" → 1280 (min desde 00:00) ────
// Solo interesa la hora del día, no la fecha: la fecha ya la resolvió
// extract-kpis con parseFecha(). Acepta 12 h y 24 h, con o sin segundos.
function parseHoraMinuto(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return raw.getHours() * 60 + raw.getMinutes() + raw.getSeconds() / 60;
  }

  if (typeof raw === 'number') {
    if (!isFinite(raw) || raw < 0) return null;
    if (raw < 1) return raw * MIN_POR_DIA;      // fracción de día (formato Excel)
    if (raw < MIN_POR_DIA) return raw;          // minutos desde medianoche
    return null;
  }

  const s = String(raw).trim();
  if (!s) return null;

  // Última aparición de H:MM[:SS] con AM/PM opcional al final de la cadena.
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\s*$/);
  if (!m) return null;

  let h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const se = m[3] !== undefined ? parseInt(m[3], 10) : 0;
  if (mi > 59 || se > 59) return null;

  if (m[4]) {                        // venía con AM/PM
    const pm = /[Pp]/.test(m[4]);
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }

  if (h < 0 || h > 23) return null;
  return h * 60 + mi + se / 60;
}

// ─── calcularOcupacion(): la tasa por día y la del período completo ──────────

/**
 * @param {Array<{evse:string, fecha:string, startMin?:number, endMin?:number, ocupadoMin:number}>} sesiones
 * @param {object} [opts]
 * @param {number} [opts.ventanaCompletaMin=900]   Jornada operativa (15 h)
 * @param {number} [opts.ventanaMinimaMin=60]      Suelo de la ventana acotada
 * @param {number} [opts.tope=100]                 Tope de la tasa en %
 * @returns {{
 *   tasa: number|null, porDia: object, ocupadoMin: number,
 *   disponiblesMin: number, evses: number, dias: string[], detalle: object[]
 * }}
 */
function calcularOcupacion(sesiones, opts) {
  const o = Object.assign({
    ventanaCompletaMin: VENTANA_OPERACION_MIN,   // 900 min = 15 h de operación
    ventanaMinimaMin:   60,
    tope:               100,
  }, opts || {});

  const lista = Array.isArray(sesiones) ? sesiones : [];
  const acum  = {};             // fecha → { evses:Set, ocupadoMin, maxEndMin, sesiones }
  const evsesGlobal = new Set();

  for (const s of lista) {
    if (!s || !s.fecha || !s.evse) continue;

    const ocupado = Number(s.ocupadoMin);
    if (!isFinite(ocupado) || ocupado <= 0) continue;

    const d = acum[s.fecha] || (acum[s.fecha] = {
      evses: new Set(), ocupadoMin: 0, maxEndMin: 0, sesiones: 0,
    });

    d.evses.add(s.evse);
    d.ocupadoMin += ocupado;
    d.sesiones++;

    const fin = Number(s.endMin);
    if (isFinite(fin) && fin > d.maxEndMin) d.maxEndMin = fin;

    evsesGlobal.add(s.evse);
  }

  const dias = Object.keys(acum).sort();

  if (!dias.length) {
    return { tasa: null, porDia: {}, ocupadoMin: 0, disponiblesMin: 0, evses: 0, dias: [], detalle: [] };
  }

  const diaCorte    = dias[dias.length - 1];   // último día del archivo
  const porDia      = {};
  const detalle     = [];
  let   ocupadoTot  = 0;
  let   dispTot     = 0;

  for (const fecha of dias) {
    const info = acum[fecha];

    // Ventana de disponibilidad = jornada operativa (15 h = 900 min).
    // Los días ya cerrados usan la jornada completa. El ÚLTIMO día del archivo
    // se acota: el Excel se exporta antes de que termine la jornada, así que se
    // estima qué fracción de la jornada había transcurrido a la hora de la
    // última sesión (suponiendo que la jornada se reparte en el día natural).
    // Sin este ajuste el correo del día en curso saldría artificialmente bajo.
    let ventana;
    if (fecha === diaCorte && info.maxEndMin > 0) {
      const fraccionDia = Math.min(1, info.maxEndMin / MIN_POR_DIA);
      ventana = Math.max(o.ventanaMinimaMin, o.ventanaCompletaMin * fraccionDia);
    } else {
      ventana = o.ventanaCompletaMin;
    }
    ventana = Math.min(o.ventanaCompletaMin, ventana);

    const disponibles = info.evses.size * ventana;
    const pct = disponibles > 0 ? (info.ocupadoMin / disponibles) * 100 : null;

    const entrada = {
      fecha,
      tasa:           pct !== null ? Math.min(o.tope, Math.round(pct * 10) / 10) : null,
      tasaSinTope:    pct !== null ? Math.round(pct * 10) / 10 : null,
      ocupadoMin:     Math.round(info.ocupadoMin),
      disponiblesMin: Math.round(disponibles),
      evses:          info.evses.size,
      ventanaMin:     Math.round(ventana),
      sesiones:       info.sesiones,
      diaCorte:       fecha === diaCorte,
    };

    porDia[fecha] = entrada;
    detalle.push(entrada);

    ocupadoTot += info.ocupadoMin;
    dispTot    += disponibles;
  }

  const pctGlobal = dispTot > 0 ? (ocupadoTot / dispTot) * 100 : null;

  return {
    tasa:           pctGlobal !== null ? Math.min(o.tope, Math.round(pctGlobal * 10) / 10) : null,
    porDia,
    ocupadoMin:     Math.round(ocupadoTot),
    disponiblesMin: Math.round(dispTot),
    evses:          evsesGlobal.size,
    dias,
    detalle,
  };
}

// ─── Export dual: Node (pipeline) y navegador (tests) ────────────────────────
const API = {
  parseDuracionMin, parseHoraMinuto, calcularOcupacion,
  MIN_POR_DIA, VENTANA_OPERACION_MIN,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.Ocupacion = API;
