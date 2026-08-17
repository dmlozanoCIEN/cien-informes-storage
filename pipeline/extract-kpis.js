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
    let totalTipos     = 0;
    let tiposAcDc      = 0;

    // Procesar todas las hojas (puede haber una por mes)
    for (const sheetName of wb.SheetNames) {
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

      for (const row of rows) {
        // Identificador único de sesión
        const txId = g(row, 'TRANSACTION ID', 'transaction_id', 'id');
        if (!txId) continue; // fila vacía o encabezado

        totalSesiones++;

        // Usuario único por member o phone
        const member = String(g(row, 'MEMBER', 'member', 'USER', 'user',
          'PHONE', 'phone', 'EMAIL', 'email', 'CUSTOMER', 'customer') || '').trim();
        if (member) usuariosSet.add(member.toLowerCase());

        // kWh
        const kwh = parseFloat(g(row,
          'CONSUMPTION (KWH)', 'CONSUMPTION', 'consumption', 'KWH', 'kwh',
          'ENERGY (KWH)', 'energy_kwh')) || 0;
        totalKwh += kwh;

        // Ingresos netos = amount - idling fee
        const amount  = parseFloat(g(row,
          'AMOUNT (WITH TAXES)', 'AMOUNT', 'amount', 'TOTAL', 'total',
          'REVENUE', 'revenue', 'MONTO', 'monto')) || 0;
        const idling  = parseFloat(g(row,
          'IDLING FEE (WITH TAXES)', 'IDLING FEE', 'idling_fee',
          'IDLING_FEE', 'idling')) || 0;
        totalIngresos += (amount - idling);

        // Tasa de ocupación — basada en tipo de sesión AC/DC
        const tipo = String(g(row,
          'SESSION TYPE', 'session_type', 'TYPE', 'type',
          'CONNECTOR TYPE', 'connector_type') || '').trim().toUpperCase();
        if (tipo) {
          totalTipos++;
          if (tipo === 'AC' || tipo === 'DC' || tipo.includes('CHARGE') || tipo.includes('FAST')) {
            tiposAcDc++;
          }
        }
      }
    }

    // Calcular tasa de ocupación
    let tasaOcupacion = null;
    if (totalTipos > 0) {
      tasaOcupacion = Math.round((tiposAcDc / totalTipos) * 100);
    } else if (totalSesiones > 0) {
      // Fallback: % de sesiones con kWh > 0 (sesiones efectivas)
      tasaOcupacion = null; // no hay suficiente info
    }

    console.log(`[extract-kpis] KPIs calculados:`);
    console.log(`  Sesiones:        ${totalSesiones}`);
    console.log(`  Usuarios únicos: ${usuariosSet.size}`);
    console.log(`  kWh total:       ${totalKwh.toFixed(2)}`);
    console.log(`  Ingresos netos:  ${totalIngresos.toFixed(2)}`);
    console.log(`  Tasa ocupación:  ${tasaOcupacion !== null ? tasaOcupacion + '%' : 'N/D'}`);

    return {
      total_sesiones:  totalSesiones,
      usuarios_unicos: usuariosSet.size,
      kwh_total:       Math.round(totalKwh * 100) / 100,
      ingresos_netos:  Math.round(totalIngresos * 100) / 100,
      tasa_ocupacion:  tasaOcupacion,
      error:           null,
    };

  } catch (err) {
    console.error(`[extract-kpis] Error leyendo Excel: ${err.message}`);
    return { ...empty, error: err.message };
  }
}

module.exports = { extractKpis };
