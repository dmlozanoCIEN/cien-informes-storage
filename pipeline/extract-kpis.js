/**
 * pipeline/extract-kpis.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lee un buffer de Excel (.xlsx) y extrae los KPIs de operación CIEN:
 *   - total_sesiones   → número de filas válidas (columna "#")
 *   - usuarios_unicos  → valores únicos de "MEMBER NUMBER"
 *   - kwh_total        → suma de "CONSUMPTION (KWH)"
 *   - ingresos_netos   → suma de "AMOUNT (WITH TAXES)" - "IDLING FEE (WITH TAXES)"
 *   - tasa_ocupacion   → siempre null (se calcula en el Dashboard)
 *   - ultimo_dia       → 'YYYY-MM-DD' del último día con sesiones en "STARTED AT"
 *   - kpis_ultimo_dia  → mismos KPIs pero solo de ese último día
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

let XLSX;
try {
  XLSX = require('xlsx');
} catch (_) {
  XLSX = null;
}

// ─── Función auxiliar: busca un valor en una fila por múltiples nombres ───────
// Normaliza las claves del objeto fila a minúsculas para comparación
// robusta independiente de cómo el Excel capitalice los encabezados.
function g(row, ...keys) {
  // Construir mapa normalizado una sola vez
  const norm = {};
  for (const k of Object.keys(row)) {
    // Normalizar: minúsculas + colapsar espacios múltiples
    const kn = k.trim().toLowerCase().replace(/\s+/g, ' ');
    norm[kn] = row[k];
  }
  for (const key of keys) {
    const kn = key.trim().toLowerCase().replace(/\s+/g, ' ');
    const v  = norm[kn];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

// ─── Parsear fecha desde celda de Excel ──────────────────────────────────────
// Maneja: Date (cellDates:true), string ISO, string MM/DD/YYYY, número Excel serial
function parseFecha(startedAt) {
  if (!startedAt) return null;
  try {
    // Si SheetJS ya lo convirtió a Date
    if (startedAt instanceof Date) {
      if (!isNaN(startedAt.getTime())) return startedAt.toISOString().slice(0, 10);
      return null;
    }
    // Si es número (Excel date serial)
    if (typeof startedAt === 'number') {
      // XLSX puede devolver número serial — convertir
      const d = XLSX ? XLSX.SSF.parse_date_code(startedAt) : null;
      if (d) {
        const dt = new Date(d.y, d.m - 1, d.d);
        return dt.toISOString().slice(0, 10);
      }
      return null;
    }
    const s = String(startedAt).trim();
    if (!s) return null;

    // ISO: 'YYYY-MM-DD' o 'YYYY-MM-DDTHH:mm...'
    const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];

    // DD/MM/YYYY HH:mm o MM/DD/YYYY HH:mm — intentar con Date
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

    return null;
  } catch (_) {
    return null;
  }
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Extrae KPIs de operación desde un buffer de Excel.
 *
 * @param {Buffer} buffer   Buffer del archivo .xlsx
 * @returns {object}
 *   {
 *     total_sesiones:   number,
 *     usuarios_unicos:  number,
 *     kwh_total:        number,
 *     ingresos_netos:   number,
 *     tasa_ocupacion:   null,
 *     error:            string|null,
 *     ultimo_dia:       string|null,   // 'YYYY-MM-DD'
 *     kpis_ultimo_dia:  object|null,   // KPIs solo del último día
 *   }
 */
function extractKpis(buffer) {
  const empty = {
    total_sesiones: 0, usuarios_unicos: 0,
    kwh_total: 0, ingresos_netos: 0, tasa_ocupacion: null, error: null,
    ultimo_dia: null, kpis_ultimo_dia: null,
  };

  if (!XLSX) {
    return { ...empty, error: 'xlsx no instalado — agrega a package.json' };
  }

  try {
    // Leer workbook desde buffer
    // cellDates:true para que SheetJS convierta fechas a objetos Date
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });

    let totalSesiones = 0;
    let totalKwh      = 0;
    let totalIngresos = 0;
    const usuariosSet = new Set();

    // Acumuladores por día { 'YYYY-MM-DD': { sesiones, kwh, ingresos, usuarios:Set } }
    const porDia = {};

    // ── Procesar cada hoja (una por mes normalmente) ──────────────────────────
    for (const sheetName of wb.SheetNames) {
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

      // ── Log de diagnóstico: columnas de la primera fila ──────────────────
      if (rows.length > 0) {
        const cols = Object.keys(rows[0]);
        console.log(`[extract-kpis] Hoja "${sheetName}" — ${rows.length} filas — columnas: ${JSON.stringify(cols)}`);

        // Mostrar valores de la primera fila para diagnóstico de nombres exactos
        const primeraFila = {};
        cols.forEach(c => {
          const v = rows[0][c];
          primeraFila[c] = v instanceof Date ? v.toISOString() : v;
        });
        console.log(`[extract-kpis] Primera fila (muestra): ${JSON.stringify(primeraFila)}`);
      } else {
        console.log(`[extract-kpis] Hoja "${sheetName}" — vacía (0 filas)`);
        continue;
      }

      let filasValidas = 0;
      let filasConFecha = 0;

      for (const row of rows) {
        // ── Filtro de fila válida: debe tener un número en la columna "#" ──
        // Esto descarta encabezados repetidos y filas vacías
        const numSesion = g(row,
          '#', 'no.', 'n°', 'num', 'number', 'nro', 'numero', 'item', 'seq',
        );
        // Aceptar tanto número como string numérico
        const numVal = numSesion !== null ? Number(numSesion) : NaN;
        if (isNaN(numVal) || numVal <= 0) continue;

        filasValidas++;
        totalSesiones++;

        // ── MEMBER NUMBER ────────────────────────────────────────────────────
        const member = String(
          g(row,
            'member number', 'member_number', 'membernumber',
            'member', 'user', 'phone', 'customer',
            'usuario', 'cliente', 'telefono',
          ) || ''
        ).trim();
        if (member) usuariosSet.add(member.toLowerCase());

        // ── CONSUMPTION (KWH) ────────────────────────────────────────────────
        const kwh = parseFloat(
          g(row,
            'consumption (kwh)', 'consumption(kwh)',
            'consumption', 'kwh', 'energy (kwh)', 'energy_kwh',
            'energia', 'energia (kwh)',
          )
        ) || 0;
        totalKwh += kwh;

        // ── AMOUNT (WITH TAXES) ──────────────────────────────────────────────
        const amount = parseFloat(
          g(row,
            'amount (with taxes)', 'amount(with taxes)',
            'amount', 'total', 'revenue', 'monto',
            'valor', 'valor total', 'total con impuestos',
          )
        ) || 0;

        // ── IDLING FEE (WITH TAXES) ──────────────────────────────────────────
        const idling = parseFloat(
          g(row,
            'idling fee (with taxes)', 'idling fee(with taxes)',
            'idling fee', 'idling_fee', 'idling',
            'cargo por espera', 'fee',
          )
        ) || 0;

        totalIngresos += (amount - idling);

        // ── STARTED AT → fecha del día ───────────────────────────────────────
        const startedAtRaw = g(row,
          'started at', 'started_at', 'start at', 'start_at',
          'start time', 'start_time', 'start date', 'start_date',
          'fecha inicio', 'fecha_inicio', 'fecha', 'inicio',
          'transaction date', 'date', 'created at', 'timestamp',
        );

        const dateStr = parseFecha(startedAtRaw);

        if (dateStr) {
          filasConFecha++;
          if (!porDia[dateStr]) {
            porDia[dateStr] = { sesiones: 0, kwh: 0, ingresos: 0, usuarios: new Set() };
          }
          porDia[dateStr].sesiones++;
          porDia[dateStr].kwh      += kwh;
          porDia[dateStr].ingresos += (amount - idling);
          if (member) porDia[dateStr].usuarios.add(member.toLowerCase());
        }
      }

      console.log(`[extract-kpis] Hoja "${sheetName}" → filas válidas: ${filasValidas} | con fecha: ${filasConFecha}`);
    }

    // ── Detectar último día de operación ─────────────────────────────────────
    const diasOrdenados = Object.keys(porDia).sort();
    const ultimoDia     = diasOrdenados.length > 0
      ? diasOrdenados[diasOrdenados.length - 1]
      : null;

    // ── KPIs del último día ───────────────────────────────────────────────────
    let kpisUltimoDia = null;
    if (ultimoDia && porDia[ultimoDia]) {
      const d = porDia[ultimoDia];
      kpisUltimoDia = {
        total_sesiones:  d.sesiones,
        usuarios_unicos: d.usuarios.size,
        kwh_total:       Math.round(d.kwh      * 100) / 100,
        ingresos_netos:  Math.round(d.ingresos * 100) / 100,
        tasa_ocupacion:  null,
      };
    }

    // ── Resumen de diagnóstico ────────────────────────────────────────────────
    console.log(`[extract-kpis] ═══ RESUMEN GLOBAL ════════════════════════════`);
    console.log(`  Hojas procesadas:  ${wb.SheetNames.length} (${wb.SheetNames.join(', ')})`);
    console.log(`  Sesiones total:    ${totalSesiones}`);
    console.log(`  Usuarios únicos:   ${usuariosSet.size}`);
    console.log(`  kWh total:         ${totalKwh.toFixed(2)}`);
    console.log(`  Ingresos netos:    ${totalIngresos.toFixed(2)}`);
    console.log(`  Días con datos:    ${diasOrdenados.length} [${diasOrdenados.slice(-5).join(', ')}${diasOrdenados.length > 5 ? '...' : ''}]`);
    console.log(`  Último día:        ${ultimoDia || 'NO DETECTADO — columna STARTED AT no encontrada o sin fechas válidas'}`);
    if (kpisUltimoDia) {
      console.log(`  KPIs último día:   sesiones=${kpisUltimoDia.total_sesiones} | usuarios=${kpisUltimoDia.usuarios_unicos} | kWh=${kpisUltimoDia.kwh_total} | ingresos=${kpisUltimoDia.ingresos_netos}`);
    } else {
      console.log(`  KPIs último día:   NO DISPONIBLES (sin fechas → correo mostrará KPIs globales)`);
    }
    console.log(`[extract-kpis] ════════════════════════════════════════════════`);

    return {
      total_sesiones:  totalSesiones,
      usuarios_unicos: usuariosSet.size,
      kwh_total:       Math.round(totalKwh      * 100) / 100,
      ingresos_netos:  Math.round(totalIngresos  * 100) / 100,
      tasa_ocupacion:  null,
      error:           null,
      ultimo_dia:      ultimoDia,
      kpis_ultimo_dia: kpisUltimoDia,
    };

  } catch (err) {
    console.error(`[extract-kpis] ❌ Error leyendo Excel: ${err.message}`);
    console.error(err.stack);
    return { ...empty, error: err.message };
  }
}

module.exports = { extractKpis };
