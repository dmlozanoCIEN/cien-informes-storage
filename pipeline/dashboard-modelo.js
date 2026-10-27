/**
 * pipeline/dashboard-modelo.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Resuelve QUÉ HTML de dashboard debe abrir el enlace del informe.
 *
 * Es el ESPEJO de `_AUTO_DASHBOARDS` en `js/aliados.js`. Existe porque hay DOS
 * caminos que generan el enlace del informe y deben coincidir:
 *
 *   1. Navegador  → js/aliados.js · triggerManualEnvio()        (botón del panel)
 *   2. GitHub     → pipeline/run-once.js → generateReportUrl()  (Action / cron)
 *
 * Si se añade un modelo nuevo, hay que agregarlo aquí Y en js/aliados.js.
 *
 * REGLA Nº1 — NO ROMPER LO EXISTENTE:
 *   Sin `dashboard_modelo`, con cadena vacía o con un valor desconocido el
 *   resultado es el modelo por defecto y la URL queda EXACTAMENTE igual que
 *   antes de existir esta función.
 *
 * NO SE NECESITA CONOCER `DASHBOARD_BASE_URL`:
 *   El secreto de GitHub no se puede leer, así que nunca se asume su valor.
 *   Se toma la URL base que ya funciona, se conserva su origen y su carpeta, y
 *   se sustituye ÚNICAMENTE el nombre del archivo. Si la base no tiene forma de
 *   URL con archivo, se deja intacta y se avisa por log en lugar de inventar
 *   una ruta que daría 404.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

/** Modelos disponibles. `archivo` es solo el nombre del HTML, no la ruta. */
const MODELOS = [
  {
    id:      'v2',
    archivo: 'cien-dashboard-v2.html',
    nombre:  'CIEN Analytics — Dashboard v2 (actual)',
  },
  {
    id:      'consolidado',
    archivo: 'cien-analytics-consolidado.html',
    nombre:  'CIEN Analytics — Consolidado de operación',
  },
];

/** Modelo usado cuando no hay dato, está vacío o el valor no se reconoce. */
const MODELO_DEFAULT = 'v2';

/**
 * Resuelve la definición del modelo pedido. Nunca devuelve null.
 * Acepta el valor tal cual venga de NocoDB (mayúsculas, espacios, nulo…).
 *
 * @param {string} id
 * @returns {{id:string, archivo:string, nombre:string}}
 */
function modeloDashboard(id) {
  const clave = String(id == null ? '' : id).trim().toLowerCase();
  return MODELOS.find(m => m.id === clave)
      || MODELOS.find(m => m.id === MODELO_DEFAULT)
      || MODELOS[0];
}

/**
 * ¿El valor guardado se reconoce como un modelo del catálogo?
 * Sirve para avisar en el log si alguien escribió algo raro en NocoDB.
 *
 * @param {string} id
 * @returns {boolean}
 */
function esModeloConocido(id) {
  const clave = String(id == null ? '' : id).trim().toLowerCase();
  return MODELOS.some(m => m.id === clave);
}

/**
 * Devuelve la URL base del dashboard para el modelo pedido.
 *
 * · Modelo por defecto → devuelve `dashboardBase` intacto (comportamiento de
 *   siempre; el secreto DASHBOARD_BASE_URL sigue mandando sin cambios).
 * · Otro modelo        → conserva origen y carpeta, y cambia solo el archivo.
 *
 * Opciones:
 *   fallback  URL base a usar si `dashboardBase` viene vacía.
 *   override  URL explícita para este modelo (escape hatch configurable sin
 *             tener que leer ni reescribir el secreto existente).
 *
 * @param {string} dashboardBase
 * @param {string} idModelo
 * @param {{fallback?:string, override?:string}} [opciones]
 * @returns {string}
 */
function baseDashboardPara(dashboardBase, idModelo, opciones) {
  const opts = opciones || {};
  const def  = modeloDashboard(idModelo);

  // Escape hatch: URL propia para este modelo, si está configurada.
  if (def.id !== MODELO_DEFAULT && opts.override && String(opts.override).trim()) {
    return String(opts.override).trim();
  }

  const base = String(dashboardBase || opts.fallback || '').trim();

  // Modelo por defecto o base vacía → exactamente lo de siempre.
  if (!base || def.id === MODELO_DEFAULT) return base;

  // Caso normal: ".../carpeta/algo.html" → ".../carpeta/<archivo>".
  // Se conserva la query string si la hubiera.
  const conArchivo = base.match(/^(.*\/)?([^/?#]+\.html?)(\?.*)?$/i);
  if (conArchivo) {
    const prefijo = conArchivo[1] || '';
    const query   = conArchivo[3] || '';
    return `${prefijo}${def.archivo}${query}`;
  }

  // Base tipo carpeta: ".../dashboard/" → ".../dashboard/<archivo>"
  if (/\/$/.test(base)) return `${base}${def.archivo}`;

  // No se reconoce la forma. Devolver tal cual antes que inventar una ruta:
  // el enlace seguirá abriendo el dashboard de siempre y el log lo dirá.
  return base;
}

/**
 * Indica si la base resuelta realmente apunta al archivo del modelo pedido.
 * Se usa solo para avisar en el log.
 *
 * @param {string} baseResuelta
 * @param {string} idModelo
 * @returns {boolean}
 */
function baseCambioDeArchivo(baseResuelta, idModelo) {
  const def = modeloDashboard(idModelo);
  if (def.id === MODELO_DEFAULT) return true;
  return String(baseResuelta || '').indexOf(def.archivo) !== -1;
}

const API = {
  MODELOS,
  MODELO_DEFAULT,
  modeloDashboard,
  esModeloConocido,
  baseDashboardPara,
  baseCambioDeArchivo,
};

/* Exportación dual: en GitHub Actions (Node) se usa require(); en el navegador
   se expone en window para poder probar la lógica con las suites del proyecto.
   Ninguna de las dos ramas interfiere con la otra. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  window.DashboardModelo = API;
}
