/**
 * upload-to-repo.js
 * ════════════════════════════════════════════════════════════════
 * Sube un archivo Excel al repositorio de archivos estáticos.
 * Backend: GitHub Contents API → jsDelivr CDN
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: '.env' });

const GITHUB = {
  TOKEN:     process.env.GH_TOKEN,
  OWNER:     process.env.GH_OWNER,
  REPO:      process.env.GH_REPO,
  BRANCH:    process.env.GH_BRANCH    || 'main',
  BASE_PATH: process.env.GH_BASEPATH  || 'informes',
  CDN_BASE:  process.env.GH_CDN_BASE,
};

const JSDELIVR_PROPAGATION_DELAY_MS = 5000;

async function _getFileSha(filePath) {
  const url = `https://api.github.com/repos/${GITHUB.OWNER}/${GITHUB.REPO}/contents/${filePath}?ref=${GITHUB.BRANCH}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${GITHUB.TOKEN}`,
      'Accept': 'application/vnd.github+json',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET file failed: ${res.status}`);
  const data = await res.json();
  return data.sha || null;
}

async function uploadToGitHub({ fileBuffer, aliadoId, fecha, fileName }) {
  if (!GITHUB.TOKEN) throw new Error('[upload-to-repo] GH_TOKEN no definido');
  if (!GITHUB.OWNER) throw new Error('[upload-to-repo] GH_OWNER no definido');
  if (!GITHUB.REPO)  throw new Error('[upload-to-repo] GH_REPO no definido');

  const fechaStr = fecha    || new Date().toISOString().slice(0, 10);
  const fileNm   = fileName || 'data.xlsx';
  const repoPath = `${GITHUB.BASE_PATH}/${aliadoId}/${fechaStr}/${fileNm}`;
  const content  = fileBuffer.toString('base64');

  console.log(`[upload-to-repo] Subiendo a GitHub: ${repoPath}`);

  const existingSha = await _getFileSha(repoPath);
  if (existingSha) {
    console.warn(`[upload-to-repo] ⚠️ Archivo ya existe en ${repoPath}. Se omite la subida.`);
    const cdnUrl = `${GITHUB.CDN_BASE}/${aliadoId}/${fechaStr}/${fileNm}`;
    return { repoPath, publicUrl: cdnUrl, cdnUrl, alreadyExists: true };
  }

  const url  = `https://api.github.com/repos/${GITHUB.OWNER}/${GITHUB.REPO}/contents/${repoPath}`;
  const body = {
    message: `feat: informe CIEN de ${aliadoId} — ${fechaStr} [bot]`,
    content,
    branch: GITHUB.BRANCH,
  };

  let retries = 3;
  let lastErr;
  while (retries > 0) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${GITHUB.TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`GitHub PUT failed: ${res.status} — ${errBody.slice(0, 200)}`);
      }

      const data      = await res.json();
      const publicUrl = data.content?.download_url || '';
      const cdnUrl    = GITHUB.CDN_BASE
        ? `${GITHUB.CDN_BASE}/${aliadoId}/${fechaStr}/${fileNm}`
        : publicUrl;

      console.log(`[upload-to-repo] ✅ Subido exitosamente: ${cdnUrl}`);

      if (GITHUB.CDN_BASE && GITHUB.CDN_BASE.includes('jsdelivr')) {
        console.log(`[upload-to-repo] ⏳ Esperando propagación jsDelivr (${JSDELIVR_PROPAGATION_DELAY_MS}ms)...`);
        await new Promise(r => setTimeout(r, JSDELIVR_PROPAGATION_DELAY_MS));
      }

      return { repoPath, publicUrl, cdnUrl, alreadyExists: false, sha: data.content?.sha };

    } catch (err) {
      lastErr = err;
      retries--;
      if (retries > 0) {
        const delay = (4 - retries) * 2000;
        console.warn(`[upload-to-repo] Reintentando en ${delay}ms... (${retries} intentos restantes)`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function uploadExcel({ fileBuffer, aliadoId, fecha }) {
  let buffer = fileBuffer;
  if (typeof fileBuffer === 'string') buffer = fs.readFileSync(fileBuffer);
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);

  if (GITHUB.TOKEN && GITHUB.OWNER && GITHUB.REPO) {
    return uploadToGitHub({ fileBuffer: buffer, aliadoId, fecha });
  }

  throw new Error('[upload-to-repo] No hay backend configurado. Define GH_TOKEN + GH_OWNER + GH_REPO');
}

module.exports = { uploadExcel, uploadToGitHub };

if (require.main === module) {
  const [,, filePath, aliadoId, fecha] = process.argv;
  if (!filePath || !aliadoId) {
    console.error('Uso: node upload-to-repo.js <archivo.xlsx> <aliado_id> [fecha YYYY-MM-DD]');
    process.exit(1);
  }
  uploadExcel({ fileBuffer: filePath, aliadoId, fecha })
    .then(result => {
      console.log('\n✅ Subida exitosa:');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.error('\n❌ Error:', err.message);
      process.exit(1);
    });
}
