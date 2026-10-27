/**
 * pipeline/ocupacion.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tasa de ocupación de los cargadores, calculada EXACTAMENTE igual que el
 * dashboard `cien-analytics-consolidado.html`, para que el número del correo y
 * el del informe coincidan siempre.
 *
 * FÓRMULA (idéntica a occupancyOf() del dashboard):
 *
 *     capacidad(cargador) = potencia_kW × 15 h × días_activo
 *     ocupación           = Σ kWh entregados ÷ Σ capacidad × 100
 *
 * · potencia_kW sale del nombre del cargador (EVSE NAME) con `extractPowerKw`,
 *   con las mismas expresiones regulares que usa el dashboard:
 *       "No. 5 DC 40KW CCS2 GEII"   → 40
 *       "No. 4 AC 7KW T2 BIMA"      → 7
 *       "N5-GEII-BOG-40KW-CCS2-1"   → 40
 * · 15 h es la jornada de operación (OCC_HOURS = 15 en el dashboard).
 * · días_activo = días entre el primer y el último registro del cargador.
 *   Para el correo (KPIs de un solo día) siempre vale 1.
 * · Los cargadores SIN potencia detectable se excluyen del numerador y del
 *   denominador, igual que el dashboard. Si ninguno tiene potencia, la tasa es
 *   null y el correo muestra su texto de respaldo en vez de un número falso.
 * · El resultado se topa a 100 %.
 *
 * HISTÓRICO: la primera versión medía ocupación por TIEMPO
 * (Σ CHARGING DURATION ÷ (nº EVSE × 900 min)). Era una métrica legítima pero
 * distinta: con los mismos datos daba 40,3 % donde el dashboard da 36,5 %.
 * Se sustituyó por el método de energía para que ambos coincidan.
 *
 * Módulo Node y también navegador (deja `window.Ocupacion` para los tests).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

/* Jornada de operación: 15 horas. Debe coincidir con OCC_HOURS del
   dashboard consolidado. Es el multiplicador de la capacidad. */
const VENTANA_OPERACION_HORAS = 15;

/* ─── extractPowerKw(): potencia del cargador a partir de su nombre ─────────
   Copia literal de la función del dashboard para que no pueda divergir. */
function extractPowerKw(name) {
  if (!name) return null;
  const s = String(name).trim();
  const m1 = s.match(/(\d+(?:[.,]\d+)?)\s*[kK][wW]/);
  if (m1) return parseFloat(m1[1].replace(',', '.'));
  const m2 = s.match(/(?:DC|AC)[\s-](\d+(?:[.,]\d+)?)/i);
  if (m2) return parseFloat(m2[1].replace(',', '.'));
  const m3 = s.match(/-(\d+(?:[.,]\d+)?)$/);
  if (m3) { const v = parseFloat(m3[1].replace(',', '.')); if (v >= 1 && v <= 400) return v; }
  return null;
}

/* ─── dayDiff(): días activos de un cargador (misma función del dashboard) ── */
function dayDiff(minDate, maxDate) {
  if (!minDate || !maxDate) return 1;
  const a = new Date(minDate + 'T00:00:00');
  const b = new Date(maxDate + 'T00:00:00');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

/* Clave de cargador: el dashboard usa EVSE ID y cae a EVSE NAME. */
function chargerKey(s) {
  return String((s && (s.evse || s.evseName)) || 'sin-evse').trim();
}

/* ─── ocupacionDeSesiones(): tasa sobre un conjunto de sesiones ──────────── */
/**
 * @param {Array<{evse?:string, evseName?:string, fecha:string, kwh:number}>} sesiones
 * @param {object} [opts]
 * @param {number} [opts.ventanaHoras=15]  Jornada operativa en horas
 * @param {number} [opts.tope=100]         Tope de la tasa en %
 * @returns {{tasa, tasaSinTope, capacidadKwh, entregadoKwh, cargadores,
 *            conPotencia, sinPotencia, detalle}}
 */
function ocupacionDeSesiones(sesiones, opts) {
  const o = Object.assign({ ventanaHoras: VENTANA_OPERACION_HORAS, tope: 100 }, opts || {});
  const lista = Array.isArray(sesiones) ? sesiones : [];

  // Agrupar por cargador
  const map = new Map();
  for (const s of lista) {
    if (!s) continue;
    const kwh = Number(s.kwh);
    if (!isFinite(kwh) || kwh <= 0) continue;

    const clave = chargerKey(s);
    if (!map.has(clave)) {
      map.set(clave, {
        key: clave,
        name: s.evseName || clave,
        power: extractPowerKw(s.evseName),
        kwh: 0,
        sesiones: 0,
        first: null,
        last: null,
      });
    }
    const c = map.get(clave);
    c.kwh += kwh;
    c.sesiones++;
    // Si una fila no trae potencia pero otra del mismo cargador sí, se hereda
    if (!c.power && s.evseName) c.power = extractPowerKw(s.evseName);
    if (s.fecha) {
      if (!c.first || s.fecha < c.first) c.first = s.fecha;
      if (!c.last || s.fecha > c.last) c.last = s.fecha;
    }
  }

  const cargadores = [...map.values()].map(c => {
    const dias = dayDiff(c.first, c.last);
    const cap = c.power ? c.power * o.ventanaHoras * dias : null;
    return Object.assign({}, c, {
      diasActivo: dias,
      capacidadKwh: cap,
      tasa: (cap && cap > 0) ? Math.min(o.tope, (c.kwh / cap) * 100) : null,
    });
  }).sort((a, b) => b.kwh - a.kwh);

  // Solo los cargadores con potencia entran en numerador y denominador
  const conPotencia = cargadores.filter(c => c.power);
  const capacidadKwh = conPotencia.reduce((s, c) => s + c.capacidadKwh, 0);
  const entregadoKwh = conPotencia.reduce((s, c) => s + c.kwh, 0);
  const pct = capacidadKwh > 0 ? (entregadoKwh / capacidadKwh) * 100 : null;

  return {
    tasa: pct !== null ? Math.min(o.tope, Math.round(pct * 10) / 10) : null,
    tasaSinTope: pct !== null ? Math.round(pct * 10) / 10 : null,
    capacidadKwh: Math.round(capacidadKwh * 10) / 10,
    entregadoKwh: Math.round(entregadoKwh * 10) / 10,
    cargadores: cargadores.length,
    conPotencia: conPotencia.length,
    sinPotencia: cargadores.length - conPotencia.length,
    detalle: cargadores.map(c => ({
      cargador: c.name,
      power: c.power,
      kwh: Math.round(c.kwh * 10) / 10,
      dias: c.diasActivo,
      capacidadKwh: c.capacidadKwh,
      tasa: c.tasa !== null ? Math.round(c.tasa * 10) / 10 : null,
    })),
  };
}

/* ─── calcularOcupacion(): tasa por día + tasa global ─────────────────────
   Mantiene el nombre que ya consumía extract-kpis.js, pero usa el método de
   energía. Devuelve `porDia` para el log y para el correo (que necesita la
   tasa del último día) y `porCargador` para diagnóstico. */
function calcularOcupacion(sesiones, opts) {
  const o = Object.assign({ ventanaHoras: VENTANA_OPERACION_HORAS, tope: 100 }, opts || {});
  const lista = Array.isArray(sesiones) ? sesiones : [];

  const agrupado = {};
  for (const s of lista) {
    if (!s || !s.fecha) continue;
    (agrupado[s.fecha] || (agrupado[s.fecha] = [])).push(s);
  }

  const dias = Object.keys(agrupado).sort();
  const resumenDias = [];
  const porDia = {};

  for (const fecha of dias) {
    const r = ocupacionDeSesiones(agrupado[fecha], o);
    const entrada = {
      fecha,
      tasa: r.tasa,
      tasaSinTope: r.tasaSinTope,
      capacidadKwh: r.capacidadKwh,
      entregadoKwh: r.entregadoKwh,
      cargadores: r.cargadores,
      conPotencia: r.conPotencia,
      sinPotencia: r.sinPotencia,
      sesiones: agrupado[fecha].length,
    };
    resumenDias.push(entrada);
    porDia[fecha] = entrada;
  }

  // Global: todos los días juntos, con días_activo real por cargador
  const global = ocupacionDeSesiones(lista, o);

  return {
    tasa: global.tasa,
    tasaSinTope: global.tasaSinTope,
    porDia,
    capacidadKwh: global.capacidadKwh,
    entregadoKwh: global.entregadoKwh,
    cargadores: global.cargadores,
    conPotencia: global.conPotencia,
    sinPotencia: global.sinPotencia,
    dias,
    detalle: resumenDias,
    porCargador: global.detalle,
  };
}

// ─── Export dual: Node (pipeline) y navegador (tests) ────────────────────────
const API = {
  extractPowerKw, dayDiff, chargerKey,
  ocupacionDeSesiones, calcularOcupacion,
  VENTANA_OPERACION_HORAS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.Ocupacion = API;
