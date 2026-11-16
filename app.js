/* ============================================================================
   PAREX CAMPO — APP DE VERIFICAÇÃO EM CAMPO RNCs IAPC (PWA)
   ============================================================================ */

const STORAGE_KEY = 'parex_iapc_campo_v1';
const PENDING_SYNC_KEY = 'parex_iapc_pending_sync_v1';
const LAST_INSPECTOR_KEY = 'parex_iapc_last_inspector';
const INSTALL_DISMISSED_KEY = 'parex_iapc_install_dismissed_session';
const DB_NAME = 'parex_iapc_field_photos_db';
const DB_STORE = 'field_photos';

const SUPABASE_URL = 'https://croedunritaqeegbzxus.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FlFd0Tr7SbNaI5yhuv839A_-0IBVIjh';
const STORAGE_BUCKET = 'rnc-campo-fotos';
const MAX_FIELD_PHOTOS = 4;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB por foto

let DATA = { meta: {}, rncs: [] };
let STATE = {}; // { [codigo]: { verdict: 'ok'|'parcial'|'nao'|'', checks: [], gap: '', inspector: '', date: '', updatedAt: '' } }
let PENDING_SYNC = new Set();
let syncDebounceTimers = {};
let cloudReady = false;
let activeBloco = 'ALL';
let currentRncCode = null;
let deferredInstallPrompt = null;
let lightboxItems = [];
let lightboxIdx = 0;
let lastPdfDelivery = null;

// ============================================================================
// INDEXEDDB PARA FOTOS DE CAMPO (CÂMERA DO CELULAR)
// ============================================================================
function openPhotoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getFieldPhotos(codigo) {
  try {
    const db = await openPhotoDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const req = store.get(codigo);
      req.onsuccess = () => resolve(req.result ? req.result.photos : []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function saveFieldPhotos(codigo, photos) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    const store = tx.objectStore(DB_STORE);
    store.put({ id: codigo, photos });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllFieldPhotos() {
  const db = await openPhotoDb();
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = () => resolve();
  });
}

// ============================================================================
// UTILITÁRIOS
// ============================================================================
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function todayBr() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function showToast(msg, duration = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), duration);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    STATE = raw ? JSON.parse(raw) : {};
  } catch {
    STATE = {};
  }
  try {
    const pRaw = localStorage.getItem(PENDING_SYNC_KEY);
    PENDING_SYNC = new Set(pRaw ? JSON.parse(pRaw) : []);
  } catch {
    PENDING_SYNC = new Set();
  }
}

function persistPending() {
  try {
    localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify([...PENDING_SYNC]));
  } catch {}
}

function setSyncStatus(mode, text) {
  const pill = document.getElementById('sync-pill');
  if (!pill) return;
  pill.className = `sync-pill ${mode ? `sync-${mode}` : ''}`.trim();
  pill.textContent = text;
}

function formatBrDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

async function uploadPhotoBlobToStorage(codigo, blob, mime) {
  const safeCode = codigo.replace('/', '-');
  const ext = (mime && mime.split('/')[1]) ? mime.split('/')[1].replace('jpeg', 'jpg') : 'jpg';
  const filePath = `${safeCode}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${filePath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      'Content-Type': mime || 'image/jpeg',
      'x-upsert': 'true',
    },
    body: blob,
  });
  if (!resp.ok) {
    throw new Error(`Storage upload ${resp.status}`);
  }
  return {
    url: `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${filePath}`,
    path: filePath,
  };
}

async function supabaseUpsertRnc(codigo, showToastOnOk = false) {
  const st = getRncState(codigo);
  PENDING_SYNC.add(codigo);
  persistPending();
  setSyncStatus('saving', `Salvando ${codigo} no site...`);

  try {
    const rawFps = (await getFieldPhotos(codigo)).slice(0, MAX_FIELD_PHOTOS);
    const syncedFps = [];
    let modifiedLocalFps = false;

    for (const fp of rawFps) {
      if (fp.url) {
        syncedFps.push({ url: fp.url, path: fp.path || '', size: fp.size || 0, ts: fp.ts || '' });
      } else if (fp.dataUrl) {
        try {
          const blob = await (await fetch(fp.dataUrl)).blob();
          const up = await uploadPhotoBlobToStorage(codigo, blob, blob.type || fp.mime || 'image/jpeg');
          const cleanMeta = { url: up.url, path: up.path, size: blob.size, ts: fp.ts || new Date().toISOString() };
          syncedFps.push(cleanMeta);
          modifiedLocalFps = true;
        } catch {
          // Offline fallback only if small enough for jsonb
          if (fp.dataUrl.length < 400000) {
            syncedFps.push({ dataUrl: fp.dataUrl, ts: fp.ts || '' });
          } else {
            throw new Error('Upload foto falhou offline');
          }
        }
      }
    }

    if (modifiedLocalFps) {
      await saveFieldPhotos(codigo, syncedFps);
    }

    const payload = {
      rnc_codigo: codigo,
      verdict: st.verdict || '',
      checks: Array.isArray(st.checks) ? st.checks : [],
      gap: st.gap || '',
      inspector: st.inspector || '',
      visit_date: st.date || todayBr(),
      field_photos: syncedFps,
    };

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rnc_verificacoes?on_conflict=rnc_codigo`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => '');
      cloudReady = false;
      if (resp.status === 404 || errTxt.includes('PGRST205')) {
        setSyncStatus('warn', 'Salvo no aparelho • Criar tabela SQL no Supabase');
        if (showToastOnOk) showToast('Salvo no aparelho. Falta rodar o SQL da tabela no Supabase.');
      } else {
        setSyncStatus('warn', `Erro nuvem (${resp.status}) • Salvo local`);
        if (showToastOnOk) showToast('Erro ao salvar na nuvem; mantido salvo no aparelho.');
      }
      return { ok: false, status: resp.status };
    }

    const rows = await resp.json().catch(() => []);
    if (Array.isArray(rows) && rows[0]?.updated_at) {
      st.updatedAt = rows[0].updated_at;
    } else {
      st.updatedAt = new Date().toISOString();
    }
    PENDING_SYNC.delete(codigo);
    persistPending();
    persistState();
    cloudReady = true;

    const nowHm = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    setSyncStatus('ok', `Salvo no site • ${nowHm}`);
    const inlineMeta = document.getElementById('sheet-cloud-meta');
    if (inlineMeta && currentRncCode === codigo) {
      inlineMeta.textContent = `Salvo na nuvem: ${st.inspector || 'Equipe'} (${formatBrDateTime(st.updatedAt)})`;
    }
    if (showToastOnOk) showToast(`${codigo} salvo no site para toda a equipe!`);
    return { ok: true };
  } catch {
    setSyncStatus('warn', 'Sem internet • Salvo no aparelho');
    if (showToastOnOk) showToast('Sem sinal no momento — salvo no aparelho para sincronizar depois.');
    return { ok: false };
  }
}

function queueCloudSync(codigo) {
  PENDING_SYNC.add(codigo);
  persistPending();
  setSyncStatus('saving', `Alterações em ${codigo}...`);
  clearTimeout(syncDebounceTimers[codigo]);
  syncDebounceTimers[codigo] = setTimeout(() => {
    supabaseUpsertRnc(codigo, false);
  }, 900);
}

async function flushPendingSync() {
  const list = [...PENDING_SYNC];
  for (const code of list) {
    await supabaseUpsertRnc(code, false);
  }
}

async function supabasePullAll(showToastMsg = false) {
  try {
    if (PENDING_SYNC.size > 0) {
      await flushPendingSync();
    }
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rnc_verificacoes?select=*&order=updated_at.desc`, {
      headers: {
        apikey: SUPABASE_KEY,
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => '');
      cloudReady = false;
      if (resp.status === 404 || errTxt.includes('PGRST205')) {
        setSyncStatus('warn', 'Aguardando criação da tabela SQL no Supabase');
      } else {
        setSyncStatus('warn', `Nuvem indisponível (${resp.status}) • Modo local`);
      }
      return false;
    }

    const rows = await resp.json();
    cloudReady = true;
    let updatedCount = 0;

    for (const row of rows) {
      const code = row.rnc_codigo;
      if (!code || PENDING_SYNC.has(code)) continue;
      const local = STATE[code];
      const remoteTs = row.updated_at ? new Date(row.updated_at).getTime() : 0;
      const localTs = local?.updatedAt ? new Date(local.updatedAt).getTime() : 0;
      if (!local || remoteTs > localTs) {
        STATE[code] = {
          verdict: row.verdict || '',
          checks: Array.isArray(row.checks) ? row.checks : [],
          gap: row.gap || '',
          inspector: row.inspector || '',
          date: row.visit_date || todayBr(),
          updatedAt: row.updated_at || new Date().toISOString(),
        };
        if (Array.isArray(row.field_photos) && row.field_photos.length > 0) {
          await saveFieldPhotos(code, row.field_photos);
        }
        updatedCount++;
      }
    }

    persistState();
    updateProgressSummary();
    renderList();

    const nowHm = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    setSyncStatus('ok', `Sincronizado (${rows.length} reg.) • ${nowHm}`);
    if (showToastMsg) {
      showToast(updatedCount > 0 ? `${updatedCount} ficha(s) atualizada(s) da nuvem!` : 'Dados já estão atualizados com o site!');
    }
    return true;
  } catch {
    setSyncStatus('warn', 'Offline • Usando dados salvos no aparelho');
    if (showToastMsg) showToast('Sem conexão para atualizar da nuvem.');
    return false;
  }
}

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE));
    const ind = document.getElementById('save-indicator');
    if (ind) {
      const now = new Date();
      ind.textContent = `Salvo ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
  } catch {
    showToast('Atenção: espaço de armazenamento cheio.');
  }
}

function getRncState(codigo) {
  if (!STATE[codigo]) {
    const rnc = DATA.rncs.find((r) => r.codigo === codigo);
    const n = rnc ? rnc.checklist.length : 0;
    STATE[codigo] = {
      verdict: '',
      checks: Array(n).fill(''),
      gap: '',
      inspector: localStorage.getItem(LAST_INSPECTOR_KEY) || '',
      date: todayBr(),
      updatedAt: '',
    };
  }
  return STATE[codigo];
}

function verdictLabel(v) {
  if (v === 'ok') return 'Executado (OK)';
  if (v === 'parcial') return 'Parcial / Pend.';
  if (v === 'nao') return 'Não Executado';
  return 'Pendente';
}

function verdictClass(v) {
  if (v === 'ok') return 'verdict-ok';
  if (v === 'parcial') return 'verdict-parcial';
  if (v === 'nao') return 'verdict-nao';
  return 'verdict-pendente';
}

// Read image file preserving full quality up to 10 MB ceiling
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ============================================================================
// PWA INSTALL PROMPT (MENSAGEM AUTOMÁTICA NO CELULAR)
// ============================================================================
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function updateInstallUI() {
  const pill = document.getElementById('btn-open-install');
  const nativeBtn = document.getElementById('btn-trigger-native-install');
  const stepsEl = document.getElementById('install-instructions');

  if (isStandalone()) {
    pill.classList.add('hidden');
    return;
  }
  pill.classList.remove('hidden');

  if (isIos()) {
    nativeBtn.style.display = 'none';
    stepsEl.innerHTML = `
      <strong>Como instalar no iPhone / iPad (Safari):</strong>
      <ol>
        <li>Toque no botão <strong>Compartilhar</strong> (ícone quadrado com seta para cima <strong>↑</strong> na barra inferior).</li>
        <li>Role as opções e toque em <strong>"Adicionar à Tela de Início"</strong>.</li>
        <li>Confirme em <strong>Adicionar</strong> no canto superior direito.</li>
      </ol>
    `;
  } else if (deferredInstallPrompt) {
    nativeBtn.style.display = 'inline-flex';
    nativeBtn.textContent = 'Instalar Aplicativo Agora';
    stepsEl.innerHTML = `
      <strong>Instalação rápida disponível no seu celular:</strong>
      <ol>
        <li>Toque no botão laranja <strong>"Instalar Aplicativo Agora"</strong> abaixo.</li>
        <li>Confirme em <strong>Instalar</strong> para criar o atalho na tela inicial e liberar acesso offline em campo.</li>
      </ol>
    `;
  } else {
    nativeBtn.style.display = 'inline-flex';
    nativeBtn.textContent = 'Instalar / Criar Atalho na Tela Inicial';
    stepsEl.innerHTML = `
      <strong>Para instalar no Android (Chrome / Edge):</strong>
      <ol>
        <li>Toque no botão abaixo; se o aviso nativo não abrir automaticamente, toque no menu <strong>⋮</strong> (canto superior direito do navegador).</li>
        <li>Selecione <strong>"Instalar aplicativo"</strong> ou <strong>"Adicionar à tela inicial"</strong>.</li>
      </ol>
    `;
  }
}

function openInstallModal() {
  updateInstallUI();
  document.getElementById('install-modal').classList.add('open');
}

function closeInstallModal() {
  document.getElementById('install-modal').classList.remove('open');
  sessionStorage.setItem(INSTALL_DISMISSED_KEY, '1');
}

// ============================================================================
// FILTROS E RENDERIZAÇÃO DA LISTA
// ============================================================================
function getFilteredRncs() {
  const query = (document.getElementById('search-input').value || '').trim().toLowerCase();
  const vFilter = document.getElementById('filter-verdict').value;
  const dFilter = document.getElementById('filter-disc').value;

  return DATA.rncs.filter((r) => {
    if (activeBloco !== 'ALL' && r.bloco !== activeBloco) return false;
    if (dFilter !== 'ALL' && r.disciplina !== dFilter) return false;

    const st = STATE[r.codigo] || {};
    const v = st.verdict || '';
    if (vFilter === 'PEND' && v !== '') return false;
    if (vFilter !== 'ALL' && vFilter !== 'PEND' && v !== vFilter) return false;

    if (query) {
      const hay = `${r.codigo} ${r.titulo} ${r.tag} ${r.area} ${r.disciplina} ${r.responsavel} ${st.gap || ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

function updateProgressSummary() {
  const total = DATA.rncs.length || 34;
  let ok = 0, parcial = 0, nao = 0, pend = 0;
  DATA.rncs.forEach((r) => {
    const v = STATE[r.codigo]?.verdict || '';
    if (v === 'ok') ok++;
    else if (v === 'parcial') parcial++;
    else if (v === 'nao') nao++;
    else pend++;
  });
  const done = ok + parcial + nao;
  const pct = total ? Math.round((done / total) * 100) : 0;

  document.getElementById('header-progress-pill').textContent = `${done} / ${total} vist.`;
  document.getElementById('progress-pct-label').textContent = `${pct}% verificado (${done}/${total})`;
  document.getElementById('seg-ok').style.width = `${(ok / total) * 100}%`;
  document.getElementById('seg-parcial').style.width = `${(parcial / total) * 100}%`;
  document.getElementById('seg-nao').style.width = `${(nao / total) * 100}%`;

  document.getElementById('cnt-ok').textContent = ok;
  document.getElementById('cnt-parcial').textContent = parcial;
  document.getElementById('cnt-nao').textContent = nao;
  document.getElementById('cnt-pend').textContent = pend;
}

function renderList() {
  const items = getFilteredRncs();
  document.getElementById('results-label').textContent = `Exibindo ${items.length} de ${DATA.rncs.length} RNCs`;
  document.getElementById('export-count-filtered').textContent = items.length;

  const listEl = document.getElementById('rnc-list');
  if (items.length === 0) {
    listEl.innerHTML = `
      <div class="sheet-section" style="text-align:center;padding:28px 16px;">
        <p style="margin:0;font-weight:600;color:var(--parex-navy);">Nenhuma RNC encontrada com este filtro.</p>
        <p style="margin:6px 0 0;font-size:12.5px;color:var(--parex-muted);">Altere os filtros acima para visualizar os itens.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = items
    .map((r) => {
      const st = STATE[r.codigo] || {};
      const checks = st.checks || [];
      const markedCount = checks.filter(Boolean).length;
      const totalChecks = r.checklist.length;
      const gap = (st.gap || '').trim();
      const photoCnt = r.photos ? r.photos.length : 0;
      const noFolder = !r.fontes.folder_exists;

      const deltaText =
        r.dias_delta < 0
          ? `${Math.abs(r.dias_delta)}d atraso`
          : r.dias_delta === 0
            ? 'vence hoje'
            : `em ${r.dias_delta}d`;

      return `
        <article class="rnc-card bloco-${r.bloco}" data-code="${esc(r.codigo)}">
          <div class="rnc-card-top">
            <div class="rnc-code-group">
              <span class="rnc-idx">#${String(r.idx).padStart(2, '0')}</span>
              <span class="rnc-code">${esc(r.codigo)}</span>
              <span class="badge-bloco badge-${r.bloco}">${esc(r.bloco_label)} • ${esc(r.prazo)} (${deltaText})</span>
            </div>
            <span class="badge-verdict ${verdictClass(st.verdict)}">${verdictLabel(st.verdict)}</span>
          </div>
          <div class="rnc-card-title">${esc(r.titulo)}</div>
          <div class="rnc-card-meta">
            <span class="meta-chip"><strong>Disc:</strong> ${esc(r.disciplina || '—')}</span>
            <span class="meta-chip"><strong>TAG:</strong> ${esc(r.tag || '—')}</span>
          </div>
          ${gap ? `<div class="card-gap-preview"><strong>Falta:</strong> ${esc(gap)}</div>` : ''}
          <div class="rnc-card-footer">
            <span class="checklist-mini">Checklist: ${markedCount}/${totalChecks}${st.inspector ? ` • ${esc(st.inspector)}` : ''}</span>
            <span class="photo-chip ${noFolder ? 'no-folder' : ''}">
              ${
                noFolder
                  ? 'Sem pasta 30/10 (RF-278/279)'
                  : photoCnt > 0
                    ? `${photoCnt} foto(s) / ${r.fontes.total_files} arq.`
                    : `${r.fontes.total_files} arq. documental`
              }
            </span>
          </div>
        </article>
      `;
    })
    .join('');

  listEl.querySelectorAll('.rnc-card').forEach((card) => {
    card.addEventListener('click', () => openRncSheet(card.dataset.code));
  });
}

// ============================================================================
// FICHA DE VERIFICAÇÃO EM CAMPO (SLIDE-OVER)
// ============================================================================
async function openRncSheet(codigo) {
  const rnc = DATA.rncs.find((r) => r.codigo === codigo);
  if (!rnc) return;
  currentRncCode = codigo;
  const st = getRncState(codigo);
  const fieldPhotos = await getFieldPhotos(codigo);

  document.getElementById('sheet-code').textContent = `${rnc.codigo} (#${String(rnc.idx).padStart(2, '0')})`;
  document.getElementById('sheet-subtitle').textContent = `${rnc.bloco_label} • Prazo ${rnc.prazo} • ${rnc.disciplina}`;

  const bodyEl = document.getElementById('sheet-body');
  const photosHtml =
    rnc.photos && rnc.photos.length
      ? `<div class="photo-gallery">
          ${rnc.photos
            .map(
              (p, i) => `
              <div class="photo-item" data-lb-idx="${i}">
                <img src="${esc(p.src)}" alt="${esc(p.caption)}" loading="lazy" />
                <div class="photo-cap">${esc(p.caption)}</div>
              </div>
            `
            )
            .join('')}
        </div>`
      : `<p class="text-block" style="color:var(--parex-muted);font-style:italic;">${esc(rnc.fontes.note)}</p>`;

  const filesPills = (rnc.fontes.files || [])
    .map((f) => `<span class="file-pill">${esc(f)}</span>`)
    .join('');

  const checklistHtml = rnc.checklist
    .map((item, idx) => {
      const val = st.checks[idx] || '';
      return `
        <div class="checklist-item" data-q-idx="${idx}">
          <div class="checklist-q"><strong>Ação ${idx + 1}:</strong> ${esc(item)}</div>
          <div class="tri-toggle">
            <button type="button" class="tri-btn ${val === 'sim' ? 'selected' : ''}" data-val="sim">✓ Sim (Exec.)</button>
            <button type="button" class="tri-btn ${val === 'parcial' ? 'selected' : ''}" data-val="parcial">◐ Parcial</button>
            <button type="button" class="tri-btn ${val === 'nao' ? 'selected' : ''}" data-val="nao">✕ Não Exec.</button>
          </div>
        </div>
      `;
    })
    .join('');

  const quickTags = [
    'Falta relatório fotográfico',
    'Falta assinatura fiscalização Vale',
    'Execução em andamento',
    'Aguardando material / componente',
    'Falta lista de presença / treinamento',
    'Sem evidência em campo no momento',
  ];

  bodyEl.innerHTML = `
    <!-- STATUS & METADADOS -->
    <section class="sheet-section">
      <div class="section-heading">
        <span>Dados da RNC e TAG</span>
        <span class="badge-bloco badge-${rnc.bloco}">${esc(rnc.bloco_label)} • ${esc(rnc.prazo)}</span>
      </div>
      <p style="margin:0 0 10px;font-weight:700;font-size:14.5px;color:var(--parex-navy);">${esc(rnc.titulo)}</p>
      <div class="meta-kv-grid">
        <div class="kv-box"><div class="kv-k">Equipamento / TAG</div><div class="kv-v">${esc(rnc.tag || '—')}</div></div>
        <div class="kv-box"><div class="kv-k">Disciplina</div><div class="kv-v">${esc(rnc.disciplina || '—')}</div></div>
        <div class="kv-box"><div class="kv-k">Área / Local</div><div class="kv-v">${esc(rnc.area || '—')}</div></div>
        <div class="kv-box"><div class="kv-k">Resp. / Criticidade</div><div class="kv-v">${esc(rnc.responsavel || '—')} • ${esc(rnc.critica || '—')}</div></div>
      </div>
    </section>

    <!-- FOTOS E ANEXOS (FONTES) -->
    <section class="sheet-section">
      <div class="section-heading">
        <span>Fotos e Anexos (${esc(rnc.fontes.folder || 'Sem pasta 30/10')})</span>
        <span style="font-size:11px;color:var(--parex-grey-9);font-weight:500;">Toque para ampliar</span>
      </div>
      ${photosHtml}
      ${filesPills ? `<div class="files-badge-list">${filesPills}</div>` : ''}
    </section>

    <!-- CHECKLIST DAS AÇÕES PROPOSTAS -->
    <section class="sheet-section">
      <div class="section-heading">
        <span>Checklist em Campo — Ações Propostas</span>
        <span id="sheet-check-counter" style="font-size:11px;color:var(--parex-orange-dark);">
          ${st.checks.filter(Boolean).length}/${rnc.checklist.length} marcados
        </span>
      </div>
      ${checklistHtml}
    </section>

    <!-- VEREDITO + CAMPO PARA ESCREVER O QUE FALTA -->
    <section class="sheet-section">
      <div class="section-heading">
        <span>Resultado e O que Falta (Pendências)</span>
      </div>

      <label class="field-label">Status Geral da Verificação em Campo:</label>
      <div class="verdict-grid">
        <button type="button" class="verdict-btn ${st.verdict === 'ok' ? 'selected' : ''}" data-verdict="ok">✓ Executado (OK)</button>
        <button type="button" class="verdict-btn ${st.verdict === 'parcial' ? 'selected' : ''}" data-verdict="parcial">◐ Parcial / Pend.</button>
        <button type="button" class="verdict-btn ${st.verdict === 'nao' ? 'selected' : ''}" data-verdict="nao">✕ Não Executado</button>
      </div>

      <label class="field-label" for="input-gap">O que falta / Pendências observadas em campo:</label>
      <textarea id="input-gap" class="textarea-gap ${st.verdict === 'nao' || st.verdict === 'parcial' ? 'highlight-required' : ''}" placeholder="Descreva objetivamente o que ainda falta executar, ajustar ou evidenciar para encerramento da RNC...">${esc(st.gap)}</textarea>

      <div class="quick-chips">
        ${quickTags.map((t) => `<button type="button" class="quick-chip" data-tag="${esc(t)}">+ ${esc(t)}</button>`).join('')}
      </div>

      <div class="audit-inputs-row">
        <div>
          <label class="field-label" for="input-inspector">Inspetor / Responsável</label>
          <input id="input-inspector" class="input-ctrl" type="text" placeholder="Seu nome" value="${esc(st.inspector)}" />
        </div>
        <div>
          <label class="field-label" for="input-date">Data da Vistoria</label>
          <input id="input-date" class="input-ctrl" type="text" value="${esc(st.date || todayBr())}" />
        </div>
      </div>

      <div class="cam-box">
        <label class="cam-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
          Anexar Foto da Vistoria (máx. 4 fotos • até 10 MB/foto)
          <input id="input-field-cam" type="file" accept="image/*" capture="environment" multiple style="display:none" />
        </label>
        <div id="field-photos-grid" class="field-photos-grid"></div>
      </div>

      <div class="sheet-save-banner">
        <div class="sheet-save-meta">
          <strong>Salvamento Compartilhado no Site</strong>
          <span id="sheet-cloud-meta">${
            st.updatedAt
              ? `Última gravação: ${esc(st.inspector || 'Equipe')} (${formatBrDateTime(st.updatedAt)})`
              : 'Ao preencher, salva automaticamente no site para toda a equipe.'
          }</span>
        </div>
        <button id="sheet-save-inline" class="btn btn-orange" style="min-height:38px;padding:0 12px;font-size:12px;" type="button">Salvar no Site</button>
      </div>
    </section>

    <!-- CONTEXTO ORIGINAL DO EXTRATO (DESVIO / PROPOSTA / AÇÕES) -->
    <section class="sheet-section">
      <div class="section-heading">
        <span>Detalhes Originais do Extrato</span>
        <button id="toggle-orig-btn" class="collapse-toggle" type="button">Expandir textos completos</button>
      </div>
      <div id="orig-details" style="display:none;">
        <p style="font-size:11.5px;font-weight:700;color:var(--parex-navy);margin:0 0 3px;">DESCRIÇÃO DA NÃO CONFORMIDADE:</p>
        <p class="text-block" style="margin-bottom:10px;">${esc(rnc.escopo || '—')}</p>
        <p style="font-size:11.5px;font-weight:700;color:var(--parex-navy);margin:0 0 3px;">PROPOSTA DE DISPOSIÇÃO (${esc(rnc.proposta_tipo || '—')}):</p>
        <p class="text-block" style="margin-bottom:10px;">${esc(rnc.proposta || '—')}</p>
        <p style="font-size:11.5px;font-weight:700;color:var(--parex-navy);margin:0 0 3px;">AÇÕES JÁ REGISTRADAS NO SE SUITE:</p>
        <p class="text-block">${esc(rnc.acoes_exec || 'Nenhuma ação final registrada até 16/11/2026.')}</p>
      </div>
    </section>
  `;

  // Bind gallery lightbox
  bodyEl.querySelectorAll('.photo-item').forEach((el) => {
    el.addEventListener('click', () => {
      openLightbox(rnc.photos, Number(el.dataset.lbIdx));
    });
  });

  // Render field snapped photos
  const renderFieldThumbs = async () => {
    const fps = await getFieldPhotos(codigo);
    const grid = document.getElementById('field-photos-grid');
    if (!grid) return;
    grid.innerHTML = fps
      .map(
        (fp, i) => `
        <div class="field-thumb-wrap">
          <img src="${esc(fp.url || fp.dataUrl)}" alt="Foto campo ${i + 1}" data-fp-idx="${i}" />
          <button type="button" class="field-thumb-del" data-del-idx="${i}" title="Remover">×</button>
        </div>
      `
      )
      .join('');

    grid.querySelectorAll('img').forEach((img) => {
      img.addEventListener('click', () => {
        openLightbox(
          fps.map((p, idx) => ({ src: p.url || p.dataUrl, caption: `Evidência de Campo #${idx + 1} — ${codigo}` })),
          Number(img.dataset.fpIdx)
        );
      });
    });

    grid.querySelectorAll('.field-thumb-del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cur = await getFieldPhotos(codigo);
        cur.splice(Number(btn.dataset.delIdx), 1);
        await saveFieldPhotos(codigo, cur);
        renderFieldThumbs();
        queueCloudSync(codigo);
        showToast('Foto removida');
      });
    });
  };
  renderFieldThumbs();

  // Checklist interactions
  bodyEl.querySelectorAll('.checklist-item').forEach((box) => {
    const qIdx = Number(box.dataset.qIdx);
    box.querySelectorAll('.tri-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.val;
        const already = st.checks[qIdx] === val;
        st.checks[qIdx] = already ? '' : val;
        box.querySelectorAll('.tri-btn').forEach((b) => b.classList.remove('selected'));
        if (!already) btn.classList.add('selected');

        // Smart suggestion for overall verdict
        const nonEmpty = st.checks.filter(Boolean);
        if (nonEmpty.length > 0) {
          if (nonEmpty.length === rnc.checklist.length && nonEmpty.every((x) => x === 'sim')) {
            st.verdict = 'ok';
          } else if (nonEmpty.some((x) => x === 'nao') && nonEmpty.every((x) => x === 'nao')) {
            st.verdict = 'nao';
          } else if (nonEmpty.some((x) => x === 'nao' || x === 'parcial')) {
            st.verdict = 'parcial';
          }
          bodyEl.querySelectorAll('.verdict-btn').forEach((vb) => {
            vb.classList.toggle('selected', vb.dataset.verdict === st.verdict);
          });
        }

        document.getElementById('sheet-check-counter').textContent = `${nonEmpty.length}/${rnc.checklist.length} marcados`;
        st.updatedAt = new Date().toISOString();
        persistState();
        updateProgressSummary();
        renderList();
        queueCloudSync(codigo);
      });
    });
  });

  // Verdict buttons
  bodyEl.querySelectorAll('.verdict-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.verdict;
      st.verdict = st.verdict === v ? '' : v;
      bodyEl.querySelectorAll('.verdict-btn').forEach((b) => b.classList.toggle('selected', b.dataset.verdict === st.verdict));
      const gapInput = document.getElementById('input-gap');
      gapInput.classList.toggle('highlight-required', st.verdict === 'nao' || st.verdict === 'parcial');
      st.updatedAt = new Date().toISOString();
      persistState();
      updateProgressSummary();
      renderList();
      queueCloudSync(codigo);
    });
  });

  // Gap textarea & quick chips
  const gapInput = document.getElementById('input-gap');
  gapInput.addEventListener('input', () => {
    st.gap = gapInput.value;
    st.updatedAt = new Date().toISOString();
    persistState();
    renderList();
    queueCloudSync(codigo);
  });

  bodyEl.querySelectorAll('.quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      const cur = gapInput.value.trim();
      gapInput.value = cur ? `${cur}; ${tag}` : tag;
      st.gap = gapInput.value;
      st.updatedAt = new Date().toISOString();
      persistState();
      renderList();
      queueCloudSync(codigo);
    });
  });

  // Inspector & date
  const inspInput = document.getElementById('input-inspector');
  inspInput.addEventListener('input', () => {
    st.inspector = inspInput.value;
    localStorage.setItem(LAST_INSPECTOR_KEY, st.inspector);
    persistState();
    queueCloudSync(codigo);
  });

  const dateInput = document.getElementById('input-date');
  dateInput.addEventListener('input', () => {
    st.date = dateInput.value;
    persistState();
    queueCloudSync(codigo);
  });

  // Camera input (up to 4 photos per RNC, ceiling 10 MB per photo via Supabase Storage)
  document.getElementById('input-field-cam').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    showToast('Enviando foto(s)...');
    const cur = await getFieldPhotos(codigo);
    let added = 0;
    for (const f of files) {
      if (cur.length >= MAX_FIELD_PHOTOS) {
        showToast('Limite de 4 fotos por RNC atingido.');
        break;
      }
      if (f.size > MAX_PHOTO_BYTES) {
        showToast(`"${f.name}" excede 10 MB (${(f.size / (1024 * 1024)).toFixed(1)} MB).`, 3500);
        continue;
      }
      try {
        const up = await uploadPhotoBlobToStorage(codigo, f, f.type || 'image/jpeg');
        cur.push({ url: up.url, path: up.path, size: f.size, ts: new Date().toISOString() });
        added++;
      } catch {
        const dataUrl = await readFileAsDataUrl(f);
        cur.push({ dataUrl, mime: f.type || 'image/jpeg', size: f.size, ts: new Date().toISOString() });
        added++;
      }
    }
    e.target.value = '';
    if (added > 0) {
      await saveFieldPhotos(codigo, cur);
      renderFieldThumbs();
      queueCloudSync(codigo);
      showToast(`${added} foto(s) anexada(s) e salva(s) no site!`);
    }
  });

  // Inline explicit Save to Site button
  document.getElementById('sheet-save-inline').addEventListener('click', () => {
    supabaseUpsertRnc(codigo, true);
  });

  // Original texts toggle
  document.getElementById('toggle-orig-btn').addEventListener('click', (e) => {
    const d = document.getElementById('orig-details');
    const hidden = d.style.display === 'none';
    d.style.display = hidden ? 'block' : 'none';
    e.target.textContent = hidden ? 'Ocultar textos' : 'Expandir textos completos';
  });

  const overlay = document.getElementById('rnc-sheet');
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  bodyEl.scrollTop = 0;
}

function closeRncSheet() {
  const overlay = document.getElementById('rnc-sheet');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  currentRncCode = null;
}

// ============================================================================
// LIGHTBOX
// ============================================================================
function openLightbox(items, idx) {
  lightboxItems = items || [];
  if (!lightboxItems.length) return;
  lightboxIdx = Math.max(0, Math.min(idx || 0, lightboxItems.length - 1));
  updateLightbox();
  document.getElementById('lightbox').classList.add('open');
}

function updateLightbox() {
  const item = lightboxItems[lightboxIdx];
  document.getElementById('lightbox-counter').textContent = `Foto ${lightboxIdx + 1} / ${lightboxItems.length}`;
  document.getElementById('lightbox-img').src = item.src;
  document.getElementById('lightbox-caption').textContent = item.caption || '';
}

// ============================================================================
// WHATSAPP FORMATTERS
// ============================================================================
function sendSingleRncWhatsApp(codigo) {
  const rnc = DATA.rncs.find((r) => r.codigo === codigo);
  if (!rnc) return;
  const st = getRncState(codigo);

  const lines = [
    `*PAREX ENGENHARIA | VERIFICAÇÃO DE CAMPO (IAPC)*`,
    `*RNC:* ${rnc.codigo} (${rnc.bloco_label} • Prazo ${rnc.prazo})`,
    `*TAG:* ${rnc.tag || '—'} | *Disc:* ${rnc.disciplina || '—'}`,
    `*Escopo:* ${rnc.titulo}`,
    `*Status em Campo:* ${verdictLabel(st.verdict)}`,
    ``,
    `*Checklist Ações Propostas:*`,
  ];

  rnc.checklist.forEach((act, i) => {
    const v = st.checks[i] || '';
    const ico = v === 'sim' ? '✅ Sim' : v === 'parcial' ? '⚠️ Parcial' : v === 'nao' ? '❌ Não' : '⬜ Pendente';
    lines.push(`${i + 1}. [${ico}] ${act}`);
  });

  if (st.gap && st.gap.trim()) {
    lines.push('', `*O que falta / Pendências:*`, st.gap.trim());
  }
  if (st.inspector) {
    lines.push('', `*Inspetor:* ${st.inspector} (${st.date || todayBr()})`);
  }
  lines.push('', `Ref. Painel: ${window.location.href.split('#')[0]}`);

  const url = `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
  window.open(url, '_blank', 'noopener');
}

function sendConsolidatedWhatsApp() {
  const items = getFilteredRncs();
  const okList = [];
  const pendList = [];
  let unvisited = 0;

  items.forEach((r) => {
    const st = STATE[r.codigo] || {};
    if (st.verdict === 'ok') okList.push(r.codigo);
    else if (st.verdict === 'parcial' || st.verdict === 'nao') {
      const gap = (st.gap || '').trim();
      pendList.push(`• *${r.codigo}* (${r.prazo}) — ${verdictLabel(st.verdict)}${gap ? `: ${gap}` : ''}`);
    } else {
      unvisited++;
    }
  });

  const lines = [
    `*PAREX ENGENHARIA | RESUMO AUDITORIA CAMPO IAPC*`,
    `Projeto ${DATA.meta.projeto} • Extrato ${DATA.meta.data_base}`,
    `*IAPC Atual:* ${DATA.meta.iapc_atual.toFixed(2).replace('.', ',')}% (${DATA.meta.em_dia}/${DATA.meta.elegiveis_iapc}) | Meta: ${DATA.meta.meta_iapc}%`,
    `*Escopo:* ${items.length} RNCs (${okList.length} OK | ${pendList.length} com pendência | ${unvisited} pendentes de vistoria)`,
  ];

  if (okList.length) {
    lines.push('', `✅ *Executadas (OK):* ${okList.join(', ')}`);
  }
  if (pendList.length) {
    lines.push('', `⚠️ *Com Pendência / O que falta:*`, ...pendList.slice(0, 18));
    if (pendList.length > 18) lines.push(`... +${pendList.length - 18} itens (ver PDF completo).`);
  }
  lines.push('', `Link do App: ${window.location.href.split('#')[0]}`);

  const url = `https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`;
  window.open(url, '_blank', 'noopener');
}

// ============================================================================
// BOOT & EVENTOS
// ============================================================================
async function init() {
  loadState();

  // Register Service Worker for offline PWA capability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Capture Android/Chrome install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updateInstallUI();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    closeInstallModal();
    updateInstallUI();
    showToast('App PAREX IAPC instalado no celular!');
  });

  // Show automatic install prompt when opened in mobile/browser (not standalone)
  if (!isStandalone() && !sessionStorage.getItem(INSTALL_DISMISSED_KEY)) {
    setTimeout(() => openInstallModal(), 450);
  }

  // Load RNC dataset
  try {
    const resp = await fetch('./data/rncs.json');
    DATA = await resp.json();
  } catch (err) {
    showToast('Erro ao carregar base de RNCs.');
    return;
  }

  // Populate Disciplina dropdown
  const discs = [...new Set(DATA.rncs.map((r) => r.disciplina).filter(Boolean))].sort();
  const discSel = document.getElementById('filter-disc');
  discs.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    discSel.appendChild(opt);
  });

  updateProgressSummary();
  renderList();

  // Pull shared state from Supabase + auto-sync listeners
  await supabasePullAll(false);
  window.addEventListener('online', () => {
    flushPendingSync().then(() => supabasePullAll(false));
  });
  setInterval(() => {
    if (navigator.onLine && !currentRncCode) {
      supabasePullAll(false);
    }
  }, 25000);

  document.getElementById('btn-sync-cloud').addEventListener('click', () => {
    supabasePullAll(true);
  });

  // Filter tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activeBloco = btn.dataset.bloco;
      renderList();
    });
  });

  document.getElementById('search-input').addEventListener('input', renderList);
  document.getElementById('filter-verdict').addEventListener('change', renderList);
  document.getElementById('filter-disc').addEventListener('change', renderList);
  document.getElementById('btn-scroll-top').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  // Sheet controls
  document.getElementById('sheet-close').addEventListener('click', closeRncSheet);
  document.getElementById('sheet-btn-save').addEventListener('click', () => {
    if (currentRncCode) supabaseUpsertRnc(currentRncCode, true);
  });
  document.getElementById('sheet-btn-wpp').addEventListener('click', () => {
    if (currentRncCode) sendSingleRncWhatsApp(currentRncCode);
  });

  document.getElementById('sheet-btn-pdf').addEventListener('click', async () => {
    if (!currentRncCode || !window.ParexPdf) return;
    const rnc = DATA.rncs.find((r) => r.codigo === currentRncCode);
    const st = getRncState(currentRncCode);
    const fps = await getFieldPhotos(currentRncCode);
    showToast('Gerando PDF da ficha...');
    const doc = await ParexPdf.buildSingleRncPdf(rnc, st, fps, DATA.meta);
    const fname = `Verificacao_${rnc.safe_code}.pdf`;
    const res = await ParexPdf.deliverPdf(doc, fname, `Verificação ${rnc.codigo}`, `Ficha A4 ${rnc.codigo} — Parex`);
    openPdfReadyModal(res, fname);
  });

  document.getElementById('sheet-btn-next').addEventListener('click', () => {
    const filtered = getFilteredRncs();
    const curIdx = filtered.findIndex((r) => r.codigo === currentRncCode);
    const next = filtered[(curIdx + 1) % filtered.length];
    if (next) openRncSheet(next.codigo);
  });

  // Install modal buttons
  document.getElementById('btn-open-install').addEventListener('click', openInstallModal);
  document.getElementById('btn-dismiss-install').addEventListener('click', closeInstallModal);
  document.getElementById('btn-trigger-native-install').addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        closeInstallModal();
      }
      deferredInstallPrompt = null;
      updateInstallUI();
    } else {
      showToast('Abra o menu ⋮ do navegador e toque em "Instalar aplicativo" ou "Adicionar à tela inicial".', 4000);
    }
  });

  // Consolidated Export Modal
  const exportModal = document.getElementById('export-modal');
  const exportMsg = document.getElementById('export-status-msg');
  document.getElementById('btn-export-pdf-modal').addEventListener('click', () => {
    exportMsg.textContent = '';
    document.getElementById('export-count-filtered').textContent = getFilteredRncs().length;
    exportModal.classList.add('open');
  });
  document.getElementById('btn-close-export').addEventListener('click', () => exportModal.classList.remove('open'));

  const runConsolidatedExport = async (subset, includeSheets, filename) => {
    if (!subset.length) {
      showToast('Nenhuma RNC selecionada para exportar.');
      return;
    }
    exportMsg.textContent = 'Gerando PDF Brandbook PAREX A4...';
    try {
      const doc = await ParexPdf.buildConsolidatedPdf(subset, STATE, getFieldPhotos, DATA.meta, {
        includeSheets,
        includeRefPhotos: true,
        onProgress: (cur, tot, code) => {
          exportMsg.textContent = `Montando ficha ${cur}/${tot}: ${code}...`;
        },
      });
      const res = await ParexPdf.deliverPdf(doc, filename, 'Relatório Verificação Campo IAPC', 'Relatório PAREX IAPC');
      exportMsg.textContent = `Concluído! Arquivo ${filename} salvo no dispositivo.`;
      exportModal.classList.remove('open');
      openPdfReadyModal(res, filename);
    } catch (e) {
      exportMsg.textContent = 'Erro ao gerar PDF.';
    }
  };

  document.getElementById('btn-pdf-filtered').addEventListener('click', () => {
    runConsolidatedExport(getFilteredRncs(), true, 'Relatorio_Campo_IAPC_Parex.pdf');
  });
  document.getElementById('btn-pdf-summary-only').addEventListener('click', () => {
    runConsolidatedExport(getFilteredRncs(), false, 'Resumo_Auditoria_IAPC_Parex.pdf');
  });
  document.getElementById('btn-pdf-pending-only').addEventListener('click', () => {
    const pend = DATA.rncs.filter((r) => ['parcial', 'nao'].includes(STATE[r.codigo]?.verdict));
    runConsolidatedExport(pend, true, 'Pendencias_Campo_IAPC_Parex.pdf');
  });

  document.getElementById('btn-whatsapp-summary').addEventListener('click', sendConsolidatedWhatsApp);

  // Offline & Backup Modal
  const offlineModal = document.getElementById('offline-modal');
  const offMsg = document.getElementById('offline-status-msg');
  document.getElementById('btn-offline-menu').addEventListener('click', () => {
    offMsg.textContent = '';
    offlineModal.classList.add('open');
  });
  document.getElementById('btn-close-offline').addEventListener('click', () => offlineModal.classList.remove('open'));

  document.getElementById('btn-cache-all-photos').addEventListener('click', async () => {
    const urls = [];
    DATA.rncs.forEach((r) => (r.photos || []).forEach((p) => urls.push(p.src)));
    const unique = [...new Set(urls)];
    let ok = 0;
    const cache = 'caches' in window ? await caches.open('parex-iapc-photos-v1') : null;
    for (const u of unique) {
      try {
        const resp = await fetch(u);
        if (resp.ok && cache) await cache.put(u, resp.clone());
        ok++;
        offMsg.textContent = `Baixando fotos offline: ${ok}/${unique.length}...`;
      } catch {}
    }
    offMsg.textContent = `${ok}/${unique.length} fotos salvas no aparelho para uso offline!`;
    showToast('Fotos cacheadas offline!');
  });

  document.getElementById('btn-export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(STATE, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `parex_iapc_marcacoes_${todayBr().replace(/\//g, '-')}.json`;
    a.click();
    showToast('Backup JSON baixado!');
  });

  document.getElementById('input-import-json').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        STATE = { ...STATE, ...parsed };
        persistState();
        updateProgressSummary();
        renderList();
        showToast('Marcações importadas com sucesso!');
      } catch {
        showToast('Arquivo JSON inválido.');
      }
    };
    reader.readAsText(f);
  });

  document.getElementById('btn-clear-marks').addEventListener('click', async () => {
    if (!confirm('Deseja apagar todas as marcações e fotos tiradas em campo deste aparelho?')) return;
    STATE = {};
    localStorage.removeItem(STORAGE_KEY);
    await clearAllFieldPhotos();
    updateProgressSummary();
    renderList();
    offMsg.textContent = 'Todas as marcações foram limpas.';
    showToast('Marcações limpas.');
  });

  // Lightbox controls
  document.getElementById('lightbox-close').addEventListener('click', () => {
    document.getElementById('lightbox').classList.remove('open');
  });
  document.getElementById('lightbox-prev').addEventListener('click', () => {
    if (!lightboxItems.length) return;
    lightboxIdx = (lightboxIdx - 1 + lightboxItems.length) % lightboxItems.length;
    updateLightbox();
  });
  document.getElementById('lightbox-next').addEventListener('click', () => {
    if (!lightboxItems.length) return;
    lightboxIdx = (lightboxIdx + 1) % lightboxItems.length;
    updateLightbox();
  });

  // PDF Ready Modal controls (Mobile WhatsApp PDF share)
  document.getElementById('btn-close-pdf-ready').addEventListener('click', () => {
    document.getElementById('pdf-ready-modal').classList.remove('open');
  });
  document.getElementById('btn-redownload-pdf').addEventListener('click', () => {
    if (!lastPdfDelivery) return;
    const url = URL.createObjectURL(lastPdfDelivery.file);
    const a = document.createElement('a');
    a.href = url;
    a.download = lastPdfDelivery.fname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  document.getElementById('btn-share-pdf-native').addEventListener('click', async () => {
    if (!lastPdfDelivery) return;
    if (lastPdfDelivery.canNativeShare) {
      try {
        await lastPdfDelivery.shareViaSystem();
        return;
      } catch {}
    }
    showToast('Anexe o PDF baixado no WhatsApp Web/App (Downloads).', 3500);
    if (currentRncCode) sendSingleRncWhatsApp(currentRncCode);
    else sendConsolidatedWhatsApp();
  });
}

function openPdfReadyModal(delivery, fname) {
  lastPdfDelivery = { ...delivery, fname };
  document.getElementById('pdf-ready-fname').textContent = fname;
  const shareBtn = document.getElementById('btn-share-pdf-native');
  shareBtn.textContent = delivery.canNativeShare
    ? 'Enviar PDF pelo WhatsApp / Compartilhar'
    : 'Enviar Resumo WhatsApp (PDF já baixado)';
  document.getElementById('pdf-ready-modal').classList.add('open');
}

document.addEventListener('DOMContentLoaded', init);
