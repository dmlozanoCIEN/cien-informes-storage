/**
 * pipeline/extract-kpis.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lee un buffer de Excel (.xlsx) y extrae los KPIs de operación CIEN:
 *   - total_sesiones   → número de filas (transacciones)
 *   - usuarios_unicos  → valores únicos de columna member/phone
 *   - kwh_total        → suma de CONSUMPTION (KWH)
 *   - ingresos_netos   → suma de AMOUNT (WITH TAXES) - IDLING FEE
 *   - tasa_ocupacion   → % sesiones con tipo AC o DC (o ratio kwh/capacidad si hay datos)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

let XLSX;
try {
  XLSX = require('xlsx');
} catch (_) {
  // xlsx no está instalado — KPIs no disponibles
  XLSX = null;
}

/**
 * Busca el valor de una celda por múltiples nombres de columna posibles.
 * @param {object} row        Fila del Excel como objeto {columna: valor}
 * @param {string[]} keys     Nombres posibles de la columna (case-insensitive)
 * @returns {any}
 */
function g(row, ...keys) {
  const rowLower = {};
  for (const k of Object.keys(row)) {
    rowLower[k.trim().toLowerCase()] = row[k];
  }
  for (const key of keys) {
    const v = rowLower[key.trim().toLowerCase()];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/**
 * Extrae KPIs de operación desde un buffer de Excel.
 *
 * @param {Buffer} buffer   Buffer del archivo .xlsx
 * @returns {object}        KPIs calculados
 *   {
 *     total_sesiones:  number,
 *     usuarios_unicos: number,
 *     kwh_total:       number,
 *     ingresos_netos:  number,
 *     tasa_ocupacion:  number|null,  // % 0-100 o null si no se puede calcular
 *     error:           string|null,  // mensaje si hubo algún problema
 *   }
 */
function extractKpis(buffer) {
  const empty = {
    total_sesiones: 0, usuarios_unicos: 0,
    kwh_total: 0, ingresos_netos: 0, tasa_ocupacion: null, error: null,
  };

  if (!XLSX) {
    return { ...empty, error: 'xlsx no instalado — agrega a package.json' };
  }

  try {
    // Leer workbook desde buffer
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });

    let totalSesiones  = 0;
    let totalKwh       = 0;
    let totalIngresos  = 0;
    const usuariosSet  = new Set();

    // Procesar todas las hojas (puede haber una por mes)
    for (const sheetName of wb.SheetNames) {
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

      // Log de columnas detectadas (solo primera hoja, para diagnóstico)
      if (rows.length > 0) {
        console.log(`[extract-kpis] Hoja "${sheetName}" — columnas: ${JSON.stringify(Object.keys(rows[0]))}`);
      }

      for (const row of rows) {
        // ── total_sesiones: columna "#" ─────────────────────────────────────
        // Cada fila con un número en "#" es una sesión válida
        const numSesion = g(row, '#', 'No.', 'N°', 'NUM', 'num', 'NUMBER');
        if (numSesion === null || numSesion === '') continue; // fila vacía o encabezado

        totalSesiones++;

        // ── usuarios_unicos: columna "MEMBER NUMBER" ────────────────────────
        const member = String(
          g(row,
            'MEMBER NUMBER', 'member number',
            'MEMBER_NUMBER', 'membernumber',
            'MEMBER', 'member',
            'USER', 'user',
            'PHONE', 'phone',
            'CUSTOMER', 'customer',
          ) || ''
        ).trim();
        if (member) usuariosSet.add(member.toLowerCase());

        // ── kwh_total: columna "CONSUMPTION (KWH)" ──────────────────────────
        const kwh = parseFloat(
          g(row,
            'CONSUMPTION (KWH)', 'consumption (kwh)',
            'CONSUMPTION', 'consumption',
            'KWH', 'kwh',
            'ENERGY (KWH)', 'energy_kwh',
          )
        ) || 0;
        totalKwh += kwh;

        // ── ingresos_netos: AMOUNT (WITH TAXES) - IDLING FEE (WITH TAXES) ───
        const amount = parseFloat(
          g(row,
            'AMOUNT (WITH TAXES)', 'amount (with taxes)',
            'AMOUNT', 'amount',
            'TOTAL', 'total',
            'REVENUE', 'revenue',
            'MONTO', 'monto',
          )
        ) || 0;
        const idling = parseFloat(
          g(row,
            'IDLING FEE (WITH TAXES)', 'idling fee (with taxes)',
            'IDLING FEE', 'idling fee',
            'IDLING_FEE', 'idling_fee',
            'IDLING', 'idling',
          )
        ) || 0;
        totalIngresos += (amount - idling);
      }
    }

    // ── tasa_ocupacion: se calcula en el Dashboard (requiere capacidad instalada)
    // El pipeline no tiene ese dato → se muestra como N/D en el correo.
    // El Dashboard lo calcula client-side: kWh entregados / (kW capacidad × horas período)
    const tasaOcupacion = null;

    console.log(`[extract-kpis] ✅ KPIs calculados:`);
    console.log(`  Sesiones:        ${totalSesiones}`);
    console.log(`  Usuarios únicos: ${usuariosSet.size}`);
    console.log(`  kWh total:       ${totalKwh.toFixed(2)}`);
    console.log(`  Ingresos netos:  ${totalIngresos.toFixed(2)}`);
    console.log(`  Tasa ocupación:  N/D (se calcula en el Dashboard)`);

    return {
      total_sesiones:  totalSesiones,
      usuarios_unicos: usuariosSet.size,
      kwh_total:       Math.round(totalKwh * 100) / 100,
      ingresos_netos:  Math.round(totalIngresos * 100) / 100,
      tasa_ocupacion:  tasaOcupacion,
      error:           null,
    };

  } catch (err) {
    console.error(`[extract-kpis] ❌ Error leyendo Excel: ${err.message}`);
    return { ...empty, error: err.message };
  }
}

module.exports = { extractKpis };
