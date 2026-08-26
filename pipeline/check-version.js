/**
 * pipeline/check-version.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Script de diagnóstico rápido — verifica qué versión de los módulos del
 * pipeline está corriendo en GitHub Actions.
 *
 * Uso:
 *   node pipeline/check-version.js
 *
 * En GitHub Actions, agregar un step temporal:
 *   - name: 🔍 Verificar versión del pipeline
 *     run: node pipeline/check-version.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

console.log('═══════════════════════════════════════════════════════════');
console.log('  CIEN Pipeline — Verificación de versión de archivos');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

const archivos = [
  'pipeline/extract-kpis.js',
  'pipeline/run-once.js',
  'pipeline/generate-report-url.js',
  'pipeline/send-report-email.js',
  'pipeline/download-excel.js',
  'package.json',
];

archivos.forEach(rel => {
  const abs = path.join(process.cwd(), rel);
  if (!fs.existsSync(abs)) {
    console.log(`❌ NO EXISTE: ${rel}`);
    return;
  }
  const stat    = fs.statSync(abs);
  const content = fs.readFileSync(abs, 'utf8');
  const lines   = content.split('\n').length;

  // Detectar si tiene las funciones nuevas
  const tieneUltimoDia      = content.includes('ultimo_dia') || content.includes('ultimoDia');
  const tieneKpisDia        = content.includes('kpis_ultimo_dia') || content.includes('kpisUltimoDia');
  const tieneKpisDiaLabel   = content.includes('kpis_dia_label');
  const tienePorDia         = content.includes('porDia');
  const tieneParseFecha     = content.includes('parseFecha');
  const tieneDayParam       = content.includes('day') && content.includes('URLSearchParams');

  console.log(`📄 ${rel}`);
  console.log(`   Tamaño: ${stat.size} bytes | Líneas: ${lines}`);
  console.log(`   Modificado: ${stat.mtime.toISOString()}`);

  if (rel.includes('extract-kpis')) {
    console.log(`   ✔ ultimo_dia:      ${tieneUltimoDia  ? '✅ SÍ (versión nueva)' : '❌ NO (versión vieja)'}`);
    console.log(`   ✔ kpis_ultimo_dia: ${tieneKpisDia    ? '✅ SÍ (versión nueva)' : '❌ NO (versión vieja)'}`);
    console.log(`   ✔ porDia acum.:    ${tienePorDia     ? '✅ SÍ (versión nueva)' : '❌ NO (versión vieja)'}`);
    console.log(`   ✔ parseFecha():    ${tieneParseFecha ? '✅ SÍ (versión nueva)' : '❌ NO (versión vieja)'}`);
  }
  if (rel.includes('run-once')) {
    console.log(`   ✔ ultimoDia:       ${tieneUltimoDia  ? '✅ SÍ (versión nueva)' : '❌ NO (versión vieja)'}`);
    console.log(`   ✔ kpisCorreo:      ${content.includes('kpisCorreo') ? '✅ SÍ (versión nueva)' : '❌ NO (versión vieja)'}`);
  }
  if (rel.includes('generate-report-url')) {
    console.log(`   ✔ param &day=:     ${tieneUltimoDia  ? '✅ SÍ (versión nueva)' : '❌ NO (versión vieja)'}`);
  }
  if (rel.includes('send-report-email')) {
    console.log(`   ✔ kpis_dia_label:  ${tieneKpisDiaLabel ? '✅ SÍ (versión nueva)' : '❌ NO (versión vieja)'}`);
    console.log(`   ✔ ultimoDia param: ${tieneUltimoDia    ? '✅ SÍ (versión nueva)' : '❌ NO (versión vieja)'}`);
  }
  console.log('');
});

console.log('─── Node.js ───────────────────────────────────────────────');
console.log(`   Versión: ${process.version}`);
console.log(`   Plataforma: ${process.platform}`);
console.log(`   CWD: ${process.cwd()}`);
console.log('');

// Verificar si xlsx está instalado
try {
  const xlsx = require('xlsx');
  console.log(`✅ xlsx instalado: ${xlsx.version || '(versión no reportada)'}`);
} catch (e) {
  console.log(`❌ xlsx NO instalado: ${e.message}`);
}

// Verificar si dotenv está instalado
try {
  require('dotenv');
  console.log(`✅ dotenv instalado`);
} catch (e) {
  console.log(`❌ dotenv NO instalado: ${e.message}`);
}

console.log('');
console.log('═══════════════════════════════════════════════════════════');
