/* ============================================================================
   PAREX IAPC — GERADOR DE PDF A4 EM BRANDBOOK PAREX (Client-Side via jsPDF)
   ============================================================================ */

(function (global) {
  const NAVY = [0, 45, 114];      // Pantone 288 C (#002D72)
  const ORANGE = [255, 105, 0];   // Pantone 1505 C (#FF6900)
  const CYAN = [60, 203, 218];    // Pantone 2226 C (#3CCBDA)
  const GREY_1 = [217, 217, 214]; // Cool Grey 1 C
  const GREY_9 = [117, 120, 123]; // Cool Grey 9 C
  const INK = [19, 32, 51];
  const RED = [180, 35, 24];
  const GREEN = [20, 134, 109];
  const BG_SOFT = [243, 244, 244];

  let cachedLogoDataUrl = null;

  async function loadImageAsDataUrl(url, maxDim = 900) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      let w = bmp.width;
      let h = bmp.height;
      if (w > maxDim || h > maxDim) {
        const scale = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      return {
        dataUrl: canvas.toDataURL('image/jpeg', 0.84),
        w,
        h,
      };
    } catch (e) {
      return null;
    }
  }

  async function getLogo() {
    if (cachedLogoDataUrl) return cachedLogoDataUrl;
    cachedLogoDataUrl = await loadImageAsDataUrl('assets/parex-logo-positiva.png', 700);
    return cachedLogoDataUrl;
  }

  function sanitizeTxt(str) {
    if (!str) return '';
    return String(str)
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2026/g, '...')
      .replace(/[\r\t]+/g, ' ')
      .trim();
  }

  function drawHeader(doc, logo, title, subtitle) {
    const W = 210;
    const M = 12;

    if (logo) {
      const logoH = 8.5;
      const logoW = logoH * (logo.w / logo.h);
      doc.addImage(logo.dataUrl, 'JPEG', M, 8, logoW, logoH);
    } else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(...NAVY);
      doc.text('PAREX ENGENHARIA', M, 14);
    }

    // Top-right 3x2 dot matrix motif (Brandbook p.46)
    doc.setFillColor(...ORANGE);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        doc.rect(W - M - 8 + c * 3, 9 + r * 3, 1.3, 1.3, 'F');
      }
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...NAVY);
    doc.text(sanitizeTxt(title), M + 36, 12);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    doc.setTextColor(...GREY_9);
    doc.text(sanitizeTxt(subtitle), M + 36, 16.5);

    // Orange divider line
    doc.setDrawColor(...ORANGE);
    doc.setLineWidth(0.7);
    doc.line(M, 19.5, W - M, 19.5);
    doc.setDrawColor(...GREY_1);
    doc.setLineWidth(0.25);

    return 23.5;
  }

  function addFooters(doc, dataBase) {
    const total = doc.getNumberOfPages();
    const W = 210;
    const H = 297;
    const M = 12;
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setDrawColor(...GREY_1);
      doc.setLineWidth(0.3);
      doc.line(M, H - 11, W - M, H - 11);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...GREY_9);
      doc.text(`Parex Engenharia S.A. | Contrato 5900110079 | Projeto N1341 | Base ${dataBase}`, M, H - 6.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...NAVY);
      doc.text(`Página ${p} de ${total}`, W - M, H - 6.5, { align: 'right' });
    }
  }

  function ensureSpace(doc, y, needed, logo, title, subtitle) {
    if (y + needed <= 281) return y;
    doc.addPage();
    return drawHeader(doc, logo, title, subtitle);
  }

  function statusColor(bloco) {
    if (bloco === 'A') return RED;
    if (bloco === 'B') return ORANGE;
    return NAVY;
  }

  function verdictText(verdict) {
    if (verdict === 'ok') return 'EXECUTADO (OK)';
    if (verdict === 'parcial') return 'PARCIAL / PENDÊNCIA';
    if (verdict === 'nao') return 'NÃO EXECUTADO';
    return 'PENDENTE DE VISTORIA';
  }

  async function drawRncSheet(doc, rnc, state, fieldPhotos, meta, logo, includeRefPhotos = true) {
    const M = 12;
    const W_BOX = 210 - 2 * M;
    const headerTitle = `FICHA DE VERIFICAÇÃO EM CAMPO — ${rnc.codigo}`;
    const headerSub = `${rnc.bloco_label} • Prazo: ${rnc.prazo} • Disciplina: ${rnc.disciplina || '—'}`;
    let y = drawHeader(doc, logo, headerTitle, headerSub);

    // 1. Banner Status + Veredito
    const sCol = statusColor(rnc.bloco);
    doc.setFillColor(...sCol);
    doc.roundedRect(M, y, 42, 7.5, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.setTextColor(255, 255, 255);
    doc.text(`${rnc.bloco_label} | ${rnc.prazo}`, M + 21, y + 5, { align: 'center' });

    const vStr = verdictText(state.verdict);
    const vCol = state.verdict === 'ok' ? GREEN : state.verdict === 'nao' ? RED : state.verdict === 'parcial' ? ORANGE : GREY_9;
    doc.setFillColor(246, 248, 251);
    doc.setDrawColor(...vCol);
    doc.setLineWidth(0.5);
    doc.roundedRect(M + 44, y, W_BOX - 44, 7.5, 1.5, 1.5, 'FD');
    doc.setTextColor(...vCol);
    doc.text(`STATUS CAMPO: ${vStr}`, M + 47, y + 5);
    y += 10.5;

    // 2. Metadata Grid
    doc.setFillColor(...BG_SOFT);
    doc.setDrawColor(...GREY_1);
    doc.setLineWidth(0.3);
    doc.roundedRect(M, y, W_BOX, 17, 1.5, 1.5, 'FD');
    doc.setFontSize(7.5);

    const drawKV = (x, yy, w, k, v) => {
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...NAVY);
      doc.text(k, x, yy);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...INK);
      const txt = sanitizeTxt(v || '—');
      const cut = txt.length > 44 ? txt.slice(0, 42) + '...' : txt;
      doc.text(cut, x, yy + 3.6);
    };

    drawKV(M + 3, y + 4.2, 58, 'EQUIPAMENTO / TAG:', rnc.tag);
    drawKV(M + 65, y + 4.2, 60, 'ÁREA / LOCAL:', rnc.area);
    drawKV(M + 128, y + 4.2, 55, 'RESPONSÁVEL:', rnc.responsavel);
    drawKV(M + 3, y + 12, 120, 'TÍTULO DO DESVIO:', rnc.titulo);
    drawKV(M + 128, y + 12, 55, 'CRITICIDADE:', rnc.critica || rnc.prioridade);
    y += 20;

    // 3. Escopo / Descrição resumida
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...NAVY);
    doc.text('DESCRIÇÃO DO DESVIO E REFERÊNCIA FONTES', M, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    doc.setTextColor(...INK);
    const escopoClean = sanitizeTxt(rnc.escopo || rnc.titulo);
    const escLines = doc.splitTextToSize(escopoClean, W_BOX - 4).slice(0, 5);
    doc.text(escLines, M + 2, y);
    y += escLines.length * 3.5 + 2;

    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.3);
    doc.setTextColor(...GREY_9);
    const fNote = doc.splitTextToSize(`FONTES: ${rnc.fontes.note}`, W_BOX - 4).slice(0, 2);
    doc.text(fNote, M + 2, y);
    y += fNote.length * 3.3 + 3;

    // 4. Checklist Interativo Preenchido
    y = ensureSpace(doc, y, 28, logo, headerTitle, headerSub);
    doc.setFillColor(...NAVY);
    doc.rect(M, y, W_BOX, 6.2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.setTextColor(255, 255, 255);
    doc.text('CHECKLIST DE VERIFICAÇÃO EM CAMPO (AÇÕES PROPOSTAS NA RNC)', M + 3, y + 4.3);
    y += 8;

    const checks = state.checks || [];
    rnc.checklist.forEach((act, idx) => {
      const val = checks[idx] || '';
      const qLines = doc.splitTextToSize(`${idx + 1}. ${sanitizeTxt(act)}`, W_BOX - 52);
      const rowH = Math.max(8.5, qLines.length * 3.5 + 3.5);
      y = ensureSpace(doc, y, rowH + 2, logo, headerTitle, headerSub);

      doc.setDrawColor(...GREY_1);
      doc.setFillColor(idx % 2 === 0 ? 255 : 249, idx % 2 === 0 ? 255 : 250, idx % 2 === 0 ? 255 : 252);
      doc.rect(M, y, W_BOX, rowH, 'FD');

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.8);
      doc.setTextColor(...INK);
      doc.text(qLines, M + 2.5, y + 4);

      const markX = M + W_BOX - 47;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.4);

      // [ ] Sim  [ ] Parc  [ ] Não
      const drawOpt = (ox, label, active, col) => {
        doc.setDrawColor(...(active ? col : GREY_9));
        if (active) {
          doc.setFillColor(...col);
          doc.rect(ox, y + 2.3, 3.2, 3.2, 'F');
          doc.setTextColor(...col);
        } else {
          doc.rect(ox, y + 2.3, 3.2, 3.2, 'S');
          doc.setTextColor(...GREY_9);
        }
        doc.text(label, ox + 4.2, y + 5);
      };

      drawOpt(markX, 'Sim', val === 'sim', GREEN);
      drawOpt(markX + 14.5, 'Parc', val === 'parcial', ORANGE);
      drawOpt(markX + 30.5, 'Não', val === 'nao', RED);

      y += rowH;
    });
    y += 4;

    // 5. Campo "O que falta" (preenchido OU pautado à mão!)
    const gapText = sanitizeTxt(state.gap || '');
    const gapLines = gapText ? doc.splitTextToSize(gapText, W_BOX - 6) : [];
    const minLines = 4;
    const boxH = gapText
      ? Math.max(24, gapLines.length * 4.2 + 16)
      : 6 + minLines * 6.8 + 10;
    y = ensureSpace(doc, y, boxH + 4, logo, headerTitle, headerSub);

    doc.setDrawColor(...ORANGE);
    doc.setLineWidth(0.5);
    doc.setFillColor(255, 250, 245);
    doc.roundedRect(M, y, W_BOX, boxH, 1.5, 1.5, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...ORANGE);
    doc.text('PENDÊNCIAS / O QUE FALTA PARA ENCERRAMENTO EM CAMPO:', M + 3, y + 4.8);

    if (gapText) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...INK);
      doc.text(gapLines, M + 3, y + 10.2);
    } else {
      doc.setDrawColor(...GREY_1);
      doc.setLineWidth(0.3);
      for (let l = 1; l <= minLines; l++) {
        const ly = y + 6 + l * 6.8;
        doc.line(M + 3, ly, M + W_BOX - 3, ly);
      }
    }

    const sigY = y + boxH - 4.2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...NAVY);
    const insp = sanitizeTxt(state.inspector || '____________________________');
    const dt = sanitizeTxt(state.date || '____/____/2026');
    doc.text(`Inspetor: ${insp}`, M + 3, sigY);
    doc.text(`Data: ${dt}`, M + 96, sigY);
    doc.text('Assinatura: ______________________', M + 135, sigY);
    y += boxH + 5;

    // 6. Fotos (Referência FONTES + Fotos capturadas em campo)
    const imgsToRender = [];
    if (includeRefPhotos && rnc.photos && rnc.photos.length) {
      for (const p of rnc.photos.slice(0, 2)) {
        const loaded = await loadImageAsDataUrl(p.src, 850);
        if (loaded) imgsToRender.push({ ...loaded, cap: p.caption });
      }
    }
    if (fieldPhotos && fieldPhotos.length) {
      for (let i = 0; i < Math.min(fieldPhotos.length, 4); i++) {
        const fp = fieldPhotos[i];
        const loaded = await loadImageAsDataUrl(fp.dataUrl, 850);
        if (loaded) imgsToRender.push({ ...loaded, cap: `Evidência de Campo #${i + 1}` });
      }
    }

    if (imgsToRender.length > 0) {
      const slotW = (W_BOX - 6) / 2;
      const slotH = 52;
      y = ensureSpace(doc, y, slotH + 16, logo, headerTitle, headerSub);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.2);
      doc.setTextColor(...NAVY);
      doc.text('REGISTROS FOTOGRÁFICOS (REFERÊNCIA FONTES / CAMPO)', M, y);
      y += 4;

      for (let rowStart = 0; rowStart < imgsToRender.length; rowStart += 2) {
        if (rowStart > 0) {
          y = ensureSpace(doc, y, slotH + 12, logo, headerTitle, headerSub);
        }
        const pair = imgsToRender.slice(rowStart, rowStart + 2);
        pair.forEach((im, idx) => {
          const ix = M + idx * (slotW + 6);
          doc.setDrawColor(...GREY_1);
          doc.setFillColor(255, 255, 255);
          doc.roundedRect(ix, y, slotW, slotH + 8, 1.5, 1.5, 'FD');

          const ratio = Math.min((slotW - 4) / im.w, (slotH - 3) / im.h);
          const rw = im.w * ratio;
          const rh = im.h * ratio;
          const rx = ix + (slotW - rw) / 2;
          const ry = y + 2 + (slotH - rh) / 2;
          doc.addImage(im.dataUrl, 'JPEG', rx, ry, rw, rh);

          doc.setFont('helvetica', 'normal');
          doc.setFontSize(6.8);
          doc.setTextColor(...GREY_9);
          const cap = sanitizeTxt(im.cap || '').slice(0, 56);
          doc.text(cap, ix + 2.5, y + slotH + 5);
        });
        y += slotH + 11;
      }
    }
  }

  async function buildSingleRncPdf(rnc, state, fieldPhotos, meta) {
    const { jsPDF } = global.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const logo = await getLogo();
    await drawRncSheet(doc, rnc, state, fieldPhotos, meta, logo, true);
    addFooters(doc, meta.data_base);
    return doc;
  }

  async function buildConsolidatedPdf(rncs, allState, getFieldPhotosFn, meta, options = {}) {
    const { jsPDF } = global.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const logo = await getLogo();
    const M = 12;
    const W_BOX = 210 - 2 * M;

    // Cover / Summary Page
    let y = drawHeader(
      doc,
      logo,
      'RELATÓRIO DE VERIFICAÇÃO EM CAMPO — RNCs COM IMPACTO NO IAPC',
      `Extrato ${meta.data_base} | Contrato ${meta.contrato} | Projeto ${meta.projeto} | Vencidas + Nov/26 + Dez/26`
    );

    // KPI boxes
    const verified = rncs.filter((r) => {
      const st = allState[r.codigo];
      return st && st.verdict;
    }).length;
    const okCount = rncs.filter((r) => allState[r.codigo]?.verdict === 'ok').length;
    const pendCount = rncs.filter((r) => ['parcial', 'nao'].includes(allState[r.codigo]?.verdict)).length;

    const kpis = [
      { l: 'IAPC ATUAL (16/11)', v: `${meta.iapc_atual.toFixed(2).replace('.', ',')}%`, s: `${meta.em_dia}/${meta.elegiveis_iapc} em dia`, c: NAVY },
      { l: 'ESCOPO EXPORTADO', v: `${rncs.length} RNCs`, s: `Venc: ${meta.qtd_vencidas} | Nov: ${meta.qtd_nov} | Dez: ${meta.qtd_dez}`, c: ORANGE },
      { l: 'VISTORIADAS EM CAMPO', v: `${verified}/${rncs.length}`, s: `${okCount} OK | ${pendCount} c/ pendência`, c: GREEN },
      { l: 'RISCO NOV+DEZ SEM BAIXA', v: `${meta.sim_sem_nov_dez.toFixed(2).replace('.', ',')}%`, s: `Meta contratual: ${meta.meta_iapc}%`, c: RED },
    ];

    const kw = (W_BOX - 9) / 4;
    kpis.forEach((k, i) => {
      const kx = M + i * (kw + 3);
      doc.setFillColor(...BG_SOFT);
      doc.setDrawColor(...k.c);
      doc.setLineWidth(0.5);
      doc.roundedRect(kx, y, kw, 20, 1.5, 1.5, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.6);
      doc.setTextColor(...GREY_9);
      doc.text(k.l, kx + 2.5, y + 5);
      doc.setFontSize(13.5);
      doc.setTextColor(...k.c);
      doc.text(k.v, kx + 2.5, y + 12.2);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.6);
      doc.setTextColor(...INK);
      doc.text(k.s, kx + 2.5, y + 17);
    });
    y += 25;

    // Consolidated Summary Table
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...NAVY);
    doc.text('RESUMO CONSOLIDADO DAS VERIFICAÇÕES EM CAMPO', M, y);
    y += 4;

    const drawTableHead = (yy) => {
      doc.setFillColor(...NAVY);
      doc.rect(M, yy, W_BOX, 6.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.2);
      doc.setTextColor(255, 255, 255);
      doc.text('#', M + 2, yy + 4.4);
      doc.text('Código', M + 9, yy + 4.4);
      doc.text('Prazo', M + 32, yy + 4.4);
      doc.text('Disciplina / TAG', M + 53, yy + 4.4);
      doc.text('Status Campo & Pendências Observadas', M + 97, yy + 4.4);
      return yy + 6.5;
    };

    y = drawTableHead(y);

    rncs.forEach((r, idx) => {
      const st = allState[r.codigo] || {};
      const vStr = verdictText(st.verdict);
      const gap = sanitizeTxt(st.gap || '');
      const statusSummary = gap ? `${vStr} — Falta: ${gap}` : vStr;
      const sLines = doc.splitTextToSize(statusSummary, W_BOX - 99);
      const rh = Math.max(7.5, sLines.length * 3.3 + 3);
      if (y + rh > 280) {
        doc.addPage();
        y = drawHeader(doc, logo, 'ÍNDICE CONSOLIDADO DE VERIFICAÇÃO (CONT.)', `Base ${meta.data_base}`);
        y = drawTableHead(y);
      }
      doc.setDrawColor(...GREY_1);
      doc.setFillColor(idx % 2 === 0 ? 255 : 248, idx % 2 === 0 ? 255 : 250, idx % 2 === 0 ? 255 : 252);
      doc.rect(M, y, W_BOX, rh, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.2);
      doc.setTextColor(...NAVY);
      doc.text(String(r.idx).padStart(2, '0'), M + 2, y + 4.4);
      doc.text(r.codigo, M + 9, y + 4.4);

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...statusColor(r.bloco));
      doc.text(`${r.prazo}`, M + 32, y + 4.4);

      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...INK);
      const tagCut = sanitizeTxt(`${r.disciplina} | ${r.tag}`).slice(0, 26);
      doc.text(tagCut, M + 53, y + 4.4);
      doc.text(sLines, M + 97, y + 4.2);

      y += rh;
    });

    if (options.includeSheets !== false) {
      for (let i = 0; i < rncs.length; i++) {
        const r = rncs[i];
        if (options.onProgress) options.onProgress(i + 1, rncs.length, r.codigo);
        doc.addPage();
        const st = allState[r.codigo] || {};
        const fps = getFieldPhotosFn ? await getFieldPhotosFn(r.codigo) : [];
        await drawRncSheet(doc, r, st, fps, meta, logo, options.includeRefPhotos !== false);
      }
    }

    addFooters(doc, meta.data_base);
    return doc;
  }

  async function deliverPdf(doc, filename, shareTitle, shareText) {
    const blob = doc.output('blob');
    const file = new File([blob], filename, { type: 'application/pdf' });

    // Try native mobile file share if user chooses or supports; also trigger reliable download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);

    return {
      file,
      canNativeShare: Boolean(navigator.canShare && navigator.canShare({ files: [file] })),
      shareViaSystem: async () => {
        if (navigator.share) {
          await navigator.share({
            title: shareTitle,
            text: shareText,
            files: [file],
          });
          return true;
        }
        return false;
      },
    };
  }

  global.ParexPdf = {
    buildSingleRncPdf,
    buildConsolidatedPdf,
    deliverPdf,
  };
})(window);
