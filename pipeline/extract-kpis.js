/**
 * pipeline/extract-kpis.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lee un buffer de Excel (.xlsx) y extrae los KPIs de operación CIEN.
 *
 * Columnas reales del Excel CIEN (confirmadas por log de diagnóstico):
 *   TRANSACTION ID        → identificador de sesión (reemplaza "#")
 *   MEMBER NUMBER         → identificador del usuario
 *   CONSUMPTION (KWH)     → energía entregada
 *   AMOUNT (WITH TAXES)   → ingreso bruto
 *   IDLING FEE (WITH TAXES)→ cargo por tiempo de espera
 *   STARTED AT            → fecha/hora inicio — formato "Aug 25, 2026, 7:29 PM"
 *
 * Retorna:
 *   total_sesiones, usuarios_unicos, kwh_total, ingresos_netos,
 *   tasa_ocupacion (null), error,
 *   ultimo_dia ('YYYY-MM-DD'), kpis_ultimo_dia ({...})
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

let XLSX;
try {
  XLSX = require('xlsx');
} catch (_) {
  XLSX = null;
}

// Cálculo de la tasa de ocupación (módulo aparte para poder probarlo aislado).
const { parseDuracionMin, parseHoraMinuto, calcularOcupacion, VENTANA_OPERACION_MIN } = require('./ocupacion');

// ─── g(): busca un valor en una fila por múltiples nombres alternativos ───────
// Normaliza a minúsculas + colapsa espacios múltiples para máxima compatibilidad
function g(row, ...keys) {
  const norm = {};
  for (const k of Object.keys(row)) {
    norm[k.trim().toLowerCase().replace(/\s+/g, ' ')] = row[k];
  }
  for (const key of keys) {
    const kn = key.trim().toLowerCase().replace(/\s+/g, ' ');
    const v  = norm[kn];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

// ─── parseFecha(): convierte cualquier formato de fecha a 'YYYY-MM-DD' ────────
// Maneja los formatos reales del Excel CIEN:
//   "Aug 25, 2026, 7:29 PM"  → "2026-08-25"
//   "2026-08-25 19:29:00"    → "2026-08-25"
//   Date object (cellDates)  → "2026-08-25"
//   número serial Excel       → "2026-08-25"
function parseFecha(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  try {
    // Caso 1: ya es un objeto Date (SheetJS cellDates:true)
    if (raw instanceof Date) {
      if (!isNaN(raw.getTime())) return raw.toISOString().slice(0, 10);
      return null;
    }

    // Caso 2: número serial Excel (ej: 46295.81)
    if (typeof raw === 'number') {
      // Intentar con XLSX si está disponible
      if (XLSX && XLSX.SSF && XLSX.SSF.parse_date_code) {
        try {
          const d = XLSX.SSF.parse_date_code(raw);
          if (d && d.y) {
            const dt = new Date(Date.UTC(d.y, d.m - 1, d.d));
            return dt.toISOString().slice(0, 10);
          }
        } catch (_) {}
      }
      // Fallback: tratar como epoch ms si es un número grande
      if (raw > 40000 && raw < 60000) {
        // Rango de seriales Excel modernos (aprox 2009-2064)
        const epoch = (raw - 25569) * 86400 * 1000;
        const dt = new Date(epoch);
        if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
      }
      return null;
    }

    // Caso 3: string — intentar múltiples formatos
    const s = String(raw).trim();
    if (!s) return null;

    // 3a. ISO directo: "2026-08-25" o "2026-08-25T19:29:00..."
    const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];

    // 3b. Formato CIEN real: "Aug 25, 2026, 7:29 PM"
    //     Meses en inglés abreviados
    const MESES_EN = {
      jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
      jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
    };
    // Patrón: "MMM D, YYYY" o "MMM D, YYYY, H:MM AM/PM"
    const mmmMatch = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/);
    if (mmmMatch) {
      const mes = MESES_EN[mmmMatch[1].toLowerCase()];
      const dia = parseInt(mmmMatch[2], 10);
      const año = parseInt(mmmMatch[3], 10);
      if (mes && dia && año) {
        const dt = new Date(Date.UTC(año, mes - 1, dia));
        if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
      }
    }

    // 3c. Formato DD/MM/YYYY o MM/DD/YYYY
    const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
      // Intentar ambos órdenes
      const [, a, b, año] = slashMatch;
      // Si el primer número > 12 es día/mes/año
      const dia = parseInt(a, 10) > 12 ? parseInt(a, 10) : parseInt(b, 10);
      const mes = parseInt(a, 10) > 12 ? parseInt(b, 10) : parseInt(a, 10);
      if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) {
        const dt = new Date(Date.UTC(parseInt(año, 10), mes - 1, dia));
        if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
      }
    }

    // 3d. Último recurso: dejar que Date lo parsee (locale-dependent, menos fiable)
    const dt = new Date(s);
    if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);

    return null;
  } catch (_) {
    return null;
  }
}

// ─── extractKpis(): función principal ────────────────────────────────────────

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
    const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });

    let totalSesiones = 0;
    let totalKwh      = 0;
    let totalIngresos = 0;
    const usuariosSet = new Set();
    const porDia      = {}; // { 'YYYY-MM-DD': { sesiones, kwh, ingresos, usuarios:Set } }

    /* Sesiones normalizadas para el cálculo de ocupación.
       Aditivo: NO altera los totales de arriba. Se deduplican por transacción
       porque el mismo Excel puede traer hojas solapadas (Export + Sheet1) y la
       misma sesión no debe contarse dos veces en la ocupación. */
    const sesionesOcupacion = [];
    const _vistosOcupacion  = new Set();

    for (const sheetName of wb.SheetNames) {
      const ws   = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

      if (rows.length === 0) {
        console.log(`[extract-kpis] Hoja "${sheetName}" — vacía`);
        continue;
      }

      // Log de diagnóstico: columnas y primera fila
      const cols = Object.keys(rows[0]);
      console.log(`[extract-kpis] Hoja "${sheetName}" — ${rows.length} filas — columnas: ${JSON.stringify(cols)}`);
      const muestraFila = {};
      cols.forEach(c => {
        const v = rows[0][c];
        muestraFila[c] = v instanceof Date ? v.toISOString() : v;
      });
      console.log(`[extract-kpis] Primera fila: ${JSON.stringify(muestraFila)}`);

      let filasValidas  = 0;
      let filasConFecha = 0;
      let fechasFallidas = 0;

      for (const row of rows) {

        // ── FILTRO: fila válida ───────────────────────────────────────────────
        // NOTA: "Charging Session Txn Id" está vacío en el Excel CIEN real.
        // Usamos STATUS, MEMBER NUMBER o STARTED AT como indicadores de validez.
        // Si ninguno de los tres tiene valor, la fila es encabezado o basura.
        const _status    = g(row, 'status', 'estado', 'session status', 'charging status');
        const _member    = g(row, 'member number', 'member_number', 'member name', 'member_name', 'phone', 'usuario', 'user', 'customer', 'cliente');
        const _startedAt = g(row, 'started at', 'started_at', 'start at', 'start time', 'start_time', 'fecha inicio', 'date');
        const tieneStatus  = _status    !== null && String(_status).trim()    !== '' && String(_status).trim().toLowerCase()    !== 'status';
        const tieneMember  = _member    !== null && String(_member).trim()    !== '' && String(_member).trim().toLowerCase()    !== 'member number';
        const tieneStarted = _startedAt !== null && String(_startedAt).trim() !== '' && String(_startedAt).trim().toLowerCase() !== 'started at';
        if (!tieneStatus && !tieneMember && !tieneStarted) continue;

        filasValidas++;
        totalSesiones++;

        // ── MEMBER NUMBER ─────────────────────────────────────────────────────
        const member = String(
          g(row,
            'member number', 'member_number', 'membernumber',
            'member name', 'member_name',
            'member', 'user', 'phone', 'customer', 'usuario', 'cliente',
          ) || ''
        ).trim();
        if (member) usuariosSet.add(member.toLowerCase());

        // ── CONSUMPTION (KWH) ─────────────────────────────────────────────────
        const kwh = parseFloat(
          g(row,
            'consumption (kwh)', 'consumption(kwh)',
            'consumption', 'kwh', 'energy (kwh)', 'energy_kwh', 'energia',
          )
        ) || 0;
        totalKwh += kwh;

        // ── AMOUNT (WITH TAXES) ───────────────────────────────────────────────
        const amount = parseFloat(
          g(row,
            'amount (with taxes)', 'amount(with taxes)',
            'amount', 'total', 'revenue', 'monto', 'valor',
          )
        ) || 0;

        // ── IDLING FEE (WITH TAXES) ───────────────────────────────────────────
        const idling = parseFloat(
          g(row,
            'idling fee (with taxes)', 'idling fee(with taxes)',
            'idling fee', 'idling_fee', 'idling', 'cargo por espera',
          )
        ) || 0;

        totalIngresos += (amount - idling);

        // ── STARTED AT → fecha del día ────────────────────────────────────────
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
        } else if (startedAtRaw !== null) {
          fechasFallidas++;
          // Log de la primera fecha que falla para diagnóstico
          if (fechasFallidas === 1) {
            console.log(`[extract-kpis] ⚠️  Fecha no parseada (primera ocurrencia): "${startedAtRaw}" (tipo: ${typeof startedAtRaw})`);
          }
        }

        // ── OCUPACIÓN: duración de la sesión por cargador (bloque aditivo) ────
        // Se guarda lo mínimo para calcular la tasa al final: qué cargador,
        // qué día, cuánto estuvo ocupado y a qué hora terminó.
        if (dateStr) {
          const evse = String(g(row,
            'evse id', 'evse_id', 'evse name', 'evse_name',
            'cargador', 'charger', 'punto de carga',
          ) || '').trim();

          // CHARGING DURATION = entregando energía.
          // IDLING DURATION   = conectado sin cargar; el vehículo sigue ocupando
          //                     el cargador, por eso también cuenta como ocupación.
          const durCarga  = parseDuracionMin(g(row,
            'charging duration', 'charging_duration',
            'duracion de carga', 'duración de carga', 'tiempo de carga',
          ));
          const durIdling = parseDuracionMin(g(row,
            'idling duration', 'idling_duration',
            'duracion de espera', 'duración de espera', 'tiempo de espera',
          )) || 0;

          const ocupadoMin = (durCarga !== null ? durCarga : 0) + durIdling;

          if (evse && ocupadoMin > 0) {
            const txn = String(g(row,
              'charging session txn id', 'transaction id', 'txn id',
              'id de transaccion', 'id de transacción',
            ) || '').trim();

            const claveDup = txn
              ? `${dateStr}|${txn}`
              : `${dateStr}|${evse}|${startedAtRaw}|${ocupadoMin}`;

            if (!_vistosOcupacion.has(claveDup)) {
              _vistosOcupacion.add(claveDup);

              // Hora de fin: ENDED AT / PLUGIN END; si no viniera, se deduce
              // sumando la duración a la hora de inicio.
              const startMin = parseHoraMinuto(startedAtRaw);
              let   endMin   = parseHoraMinuto(g(row,
                'ended at', 'ended_at', 'plugin end', 'plugin_end',
                'fecha fin', 'fin', 'end time', 'end_time',
              ));
              if (startMin !== null && endMin !== null && endMin < startMin) {
                endMin += 1440; // la sesión cruza la medianoche
              }
              if (endMin === null && startMin !== null) {
                endMin = startMin + ocupadoMin;
              }

              sesionesOcupacion.push({ evse, fecha: dateStr, startMin, endMin, ocupadoMin });
            }
          }
        }
      }

      console.log(`[extract-kpis] Hoja "${sheetName}" → válidas:${filasValidas} | con_fecha:${filasConFecha} | fechas_fallidas:${fechasFallidas}`);
    }

    // ── TASA DE OCUPACIÓN (aditivo) ───────────────────────────────────────────
    // Σ duraciones ÷ (nº de cargadores distintos × jornada operativa) × 100.
    // La ventana es de 15 HORAS (900 min), no 24 h: se mide qué parte de la
    // jornada operativa estuvo ocupado cada cargador. El último día del archivo
    // se acota a la hora de la última sesión, porque el Excel se exporta antes
    // de que termine la jornada.
    const ocupacion = calcularOcupacion(sesionesOcupacion, {
      ventanaCompletaMin: VENTANA_OPERACION_MIN,
    });

    // ── Último día y KPIs del último día ──────────────────────────────────────
    const diasOrdenados = Object.keys(porDia).sort();
    const ultimoDia     = diasOrdenados.length > 0
      ? diasOrdenados[diasOrdenados.length - 1]
      : null;

    let kpisUltimoDia = null;
    if (ultimoDia && porDia[ultimoDia]) {
      const d = porDia[ultimoDia];
      kpisUltimoDia = {
        total_sesiones:  d.sesiones,
        usuarios_unicos: d.usuarios.size,
        kwh_total:       Math.round(d.kwh      * 100) / 100,
        ingresos_netos:  Math.round(d.ingresos * 100) / 100,
        // Tasa de ocupación DE ESTE DÍA — es la que se pinta en el correo.
        tasa_ocupacion:  (ocupacion.porDia[ultimoDia] && ocupacion.porDia[ultimoDia].tasa !== null)
          ? ocupacion.porDia[ultimoDia].tasa
          : null,
      };
    }

    // ── Resumen ───────────────────────────────────────────────────────────────
    console.log(`[extract-kpis] ═══ RESUMEN ═════════════════════════════════`);
    console.log(`  Sesiones:        ${totalSesiones}`);
    console.log(`  Usuarios únicos: ${usuariosSet.size}`);
    console.log(`  kWh total:       ${totalKwh.toFixed(2)}`);
    console.log(`  Ingresos netos:  ${totalIngresos.toFixed(2)}`);
    console.log(`  Días detectados: ${diasOrdenados.length} [últimos: ${diasOrdenados.slice(-3).join(', ')}]`);
    console.log(`  Último día:      ${ultimoDia || 'NO DETECTADO'}`);
    if (kpisUltimoDia) {
      console.log(`  KPIs último día: sesiones=${kpisUltimoDia.total_sesiones} | usuarios=${kpisUltimoDia.usuarios_unicos} | kWh=${kpisUltimoDia.kwh_total} | ingresos=${kpisUltimoDia.ingresos_netos}`);
    }

    // ── Diagnóstico de ocupación ──────────────────────────────────────────────
    if (ocupacion.tasa === null) {
      console.log(`  Ocupación:        NO CALCULABLE (faltan EVSE ID o CHARGING DURATION)`);
    } else {
      console.log(`  Ocupación período: ${ocupacion.tasa}% (${ocupacion.evses} cargador(es), ${ocupacion.ocupadoMin} de ${ocupacion.disponiblesMin} min — jornada ${VENTANA_OPERACION_MIN / 60} h)`);
      ocupacion.detalle.forEach(d => {
        console.log(`    · ${d.fecha}${d.diaCorte ? ' (día en curso, ventana ' + d.ventanaMin + ' min)' : ''}: ${d.tasa}% — ${d.sesiones} sesión(es), ${d.evses} EVSE`);
      });
    }
    console.log(`[extract-kpis] ════════════════════════════════════════════`);

    return {
      total_sesiones:  totalSesiones,
      usuarios_unicos: usuariosSet.size,
      kwh_total:       Math.round(totalKwh      * 100) / 100,
      ingresos_netos:  Math.round(totalIngresos  * 100) / 100,
      // Tasa de ocupación del período completo (ya no es null).
      tasa_ocupacion:  ocupacion.tasa,
      error:           null,
      ultimo_dia:      ultimoDia,
      kpis_ultimo_dia: kpisUltimoDia,
      // Detalle por día — aditivo, para diagnóstico y para el dashboard.
      ocupacion_detalle: ocupacion.detalle,
    };

  } catch (err) {
    console.error(`[extract-kpis] ❌ Error: ${err.message}`);
    console.error(err.stack);
    return { ...empty, error: err.message };
  }
}

module.exports = { extractKpis };
