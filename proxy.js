/**
 * Villa Borghese — Proxy + SQLite cache  (Lucro Real / SP)
 * node proxy.js
 */

const http = require('http');
const url  = require('url');
const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const PORT        = process.env.PORT        || 3000;
const HIPCOM_BASE = process.env.HIPCOM_BASE || 'http://emporiovilla.dyndns.info:2222';
const HIPCOM_USER = process.env.HIPCOM_USER || 'hipcomfull';
const HIPCOM_PASS = process.env.HIPCOM_PASS || 'xFyXDciUvM2&$Le$qgpl';
const AUTH        = 'Basic ' + Buffer.from(`${HIPCOM_USER}:${HIPCOM_PASS}`).toString('base64');
const DIAS_HIST   = 90;
// Lojas ativas: filtra quais lojas aparecem no sistema (env var ou todas)
const LOJAS_ATIVAS = process.env.LOJAS_ATIVAS
  ? process.env.LOJAS_ATIVAS.split(',').map(Number)
  : null; // null = todas
// Loja CD: estoque conta para compra mas não entra no cálculo de vendas
const LOJA_CD = process.env.LOJA_CD ? Number(process.env.LOJA_CD) : 2;

// ── Tabela NCM ─────────────────────────────────────────────────────────────
let NCM_TABLE = {};
try {
  NCM_TABLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'ncm_fiscal.json'), 'utf8'));
  console.log('[ncm] Tabela carregada:', Object.keys(NCM_TABLE.ncms || {}).length - 1, 'NCMs');
} catch (e) { console.warn('[ncm] ncm_fiscal.json não encontrado'); }

function getNcmInfo(ncm) {
  if (!ncm || !NCM_TABLE.ncms) return NCM_TABLE.ncms && NCM_TABLE.ncms['_padrao'];
  const s = String(ncm).replace(/\D/g, '').padStart(8, '0');
  return NCM_TABLE.ncms[s] || NCM_TABLE.ncms[s.slice(0,6)] || NCM_TABLE.ncms[s.slice(0,4)] || NCM_TABLE.ncms['_padrao'];
}

// ── Jobs (análise + sync) ─────────────────────────────────────────────────
const jobs = new Map();
function jId() { return Math.random().toString(36).slice(2, 10); }
function jAtualiza(jid, pct, etapa) {
  const j = jobs.get(jid);
  if (j) { j.pct = pct; j.etapa = etapa; }
}

// ── HTTP Hipcom ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function hGetRaw(p) {
  return new Promise((ok, fail) => {
    const u = new URL(HIPCOM_BASE + p);
    const req = http.request({
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, method: 'GET',
      headers: { Authorization: AUTH, Accept: 'application/json' },
    }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => b += c);
      res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { fail(new Error('JSON: ' + b.slice(0, 200))); } });
    });
    req.on('error', fail);
    req.setTimeout(45000, () => { req.destroy(); fail(new Error('timeout ' + p)); });
    req.end();
  });
}

async function hGet(p, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await hGetRaw(p);
    } catch (e) {
      const resetavel = e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED' || e.message.startsWith('timeout');
      if (resetavel && i < tentativas - 1) {
        await sleep(800 * (i + 1)); // 800ms, 1600ms entre tentativas
        continue;
      }
      throw e;
    }
  }
}

function hPostRaw(p, body) {
  return new Promise((ok, fail) => {
    const u  = new URL(HIPCOM_BASE + p);
    const pl = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pl), Accept: 'application/json' },
    }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => b += c);
      res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { fail(new Error('JSON: ' + b.slice(0, 200))); } });
    });
    req.on('error', fail);
    req.setTimeout(45000, () => { req.destroy(); fail(new Error('timeout ' + p)); });
    req.write(pl); req.end();
  });
}

async function hPost(p, body, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await hPostRaw(p, body);
    } catch (e) {
      const resetavel = e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED' || e.message.startsWith('timeout');
      if (resetavel && i < tentativas - 1) { await sleep(800 * (i + 1)); continue; }
      throw e;
    }
  }
}

function unwrap(data) {
  if (Array.isArray(data)) return data;
  const first = Object.values(data || {})[0];
  return Array.isArray(first) ? first : [];
}

async function hGetAll(base, extra = '') {
  const sep = base.includes('?') ? '&' : '?';
  let offset = 0, all = [];
  while (true) {
    const d     = await hGet(`${base}${sep}limite=200&offset=${offset}${extra ? '&' + extra : ''}`);
    const items = unwrap(d);
    all = all.concat(items);
    if (items.length < 200) break;
    offset += 200;
  }
  return all;
}

// ── Datas ──────────────────────────────────────────────────────────────────
const today   = () => new Date().toISOString().slice(0, 10);
const daysAgo = n  => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
function dateRange(s, e) {
  const r = [], c = new Date(s), f = new Date(e);
  while (c <= f) { r.push(c.toISOString().slice(0, 10)); c.setDate(c.getDate() + 1); }
  return r;
}

// ── Carregar com fallback para banco ───────────────────────────────────────
async function loadLojas() {
  let d = db.getLojas();
  if (!d) { d = unwrap(await hGet('/api/hipcom/lojas')); db.setLojas(d); }
  return LOJAS_ATIVAS ? d.filter(l => LOJAS_ATIVAS.includes(l.loja)) : d;
}
async function loadFornecedores() {
  let d = db.getFornecedores();
  if (!d) { d = await hGetAll('/api/hipcom/fornecedores'); db.setFornecedores(d); }
  return d;
}
async function loadProdutos(loja) {
  let d = db.getProdutos(loja);
  if (!d) { d = await hGetAll(`/api/hipcom/produtos?loja=${loja}&entra_rentabilidade=S`); db.setProdutos(loja, d); }
  return d;
}
async function loadFP(loja) {
  let d = db.getFP(loja);
  if (!d) { d = await hGetAll(`/api/hipcom/fornecedoresprodutos?loja=${loja}`); db.setFP(loja, d); }
  return d;
}
async function loadVendasDia(loja, data) {
  let d = db.getVendas(loja, data);
  if (d === null) { d = await hGetAll(`/api/hipcom/vendasprodutos?loja=${loja}&data=${data}`); db.setVendas(loja, data, d); }
  return d;
}
async function loadEstoque(loja, data) {
  let d = db.getEstoqueExato(loja, data);
  if (d === null) { d = await hGetAll(`/api/hipcom/estoquesprodutos?loja=${loja}&data=${data}`); db.setEstoque(loja, data, d); }
  return d;
}
async function loadComprasDia(loja, data) {
  let d = db.getCompras(loja, data);
  if (d === null) { d = await hGetAll(`/api/hipcom/comprasprodutos?loja=${loja}&data=${data}`); db.setCompras(loja, data, d); }
  return d;
}

// ── Fiscal ─────────────────────────────────────────────────────────────────
async function loadFiscal(loja, plu) {
  const cached = db.getFiscal(loja, plu);
  if (cached !== undefined) return cached;
  try {
    const resp  = await hPost('/api/fiscal/consultarproduto', { loja, codigo: plu });
    const items = unwrap(resp);
    const f     = items[0] || null;
    db.setFiscal(loja, plu, f);
    return f;
  } catch (e) {
    db.setFiscal(loja, plu, null);
    return null;
  }
}

async function loadFiscalBatch(loja, plus, jid, pctIni, pctFim) {
  const map      = {};
  const faltando = db.plusSemFiscal(loja, plus);
  const jaNoDb   = plus.filter(p => !faltando.includes(p));

  jaNoDb.forEach(p => { map[p] = db.getFiscal(loja, p); });

  const total = faltando.length;
  for (let i = 0; i < faltando.length; i += 8) {
    const batch   = faltando.slice(i, i + 8);
    const results = await Promise.all(batch.map(p => loadFiscal(loja, p)));
    batch.forEach((p, j) => { map[p] = results[j]; });
    if (total > 0) {
      const pct = Math.round(pctIni + ((i + batch.length) / total) * (pctFim - pctIni));
      jAtualiza(jid, pct, `Fiscal: ${Math.min(i + 8, total)}/${total} novos produtos`);
    }
  }
  if (total === 0) jAtualiza(jid, pctFim, 'Fiscal: tudo no banco local ✓');
  return map;
}

// ── Sync completo (background) ─────────────────────────────────────────────
async function rodarSync(jid, lojaId, diasHist) {
  const j = jobs.get(jid);
  try {
    const dataFim    = today();
    const dataInicio = daysAgo(diasHist);
    const datas      = dateRange(dataInicio, dataFim);

    jAtualiza(jid, 2, 'Sincronizando cadastros...');
    const [prods, forn, fp, lojasArr] = await Promise.all([
      hGetAll(`/api/hipcom/produtos?loja=${lojaId}&entra_rentabilidade=S`),
      hGetAll('/api/hipcom/fornecedores'),
      hGetAll(`/api/hipcom/fornecedoresprodutos?loja=${lojaId}`),
      hGet('/api/hipcom/lojas').then(r => unwrap(r)),
    ]);
    db.setProdutos(lojaId, prods);
    db.setFornecedores(forn);
    db.setFP(lojaId, fp);
    db.setLojas(lojasArr);
    // Salva qtd_embalagem de TODOS os produtos (sem filtro rentabilidade) para análise de unidades
    const todosProds = await hGetAll(`/api/hipcom/produtos?loja=${lojaId}`);
    db.setEmbalagemMap(todosProds);

    // Vendas
    const faltandoV = db.datasFaltandoVendas(lojaId, datas);
    for (let i = 0; i < faltandoV.length; i++) {
      const pct = Math.round(5 + ((i + 1) / Math.max(faltandoV.length, 1)) * 40);
      jAtualiza(jid, pct, `Vendas: ${faltandoV[i]} (${i + 1}/${faltandoV.length} datas novas)`);
      const v = await hGetAll(`/api/hipcom/vendasprodutos?loja=${lojaId}&data=${faltandoV[i]}`);
      db.setVendas(lojaId, faltandoV[i], v);
    }
    if (!faltandoV.length) jAtualiza(jid, 45, 'Vendas: todas as datas já no banco ✓');

    // Compras — datas novas + últimos 3 dias sempre re-buscados (NFs podem ser lançadas com atraso)
    const recentes3 = dateRange(daysAgo(3), daysAgo(0)).filter(d => datas.includes(d));
    const faltandoC = [...new Set([...db.datasFaltandoCompras(lojaId, datas), ...recentes3])].sort();
    for (let i = 0; i < faltandoC.length; i++) {
      const pct = Math.round(45 + ((i + 1) / Math.max(faltandoC.length, 1)) * 35);
      jAtualiza(jid, pct, `Compras: ${faltandoC[i]} (${i + 1}/${faltandoC.length} datas)`);
      const c = await hGetAll(`/api/hipcom/comprasprodutos?loja=${lojaId}&data=${faltandoC[i]}`);
      db.setCompras(lojaId, faltandoC[i], c);
    }
    if (!faltandoC.length) jAtualiza(jid, 80, 'Compras: todas as datas já no banco ✓');

    // Estoques: início e ontem (Hipcom não disponibiliza estoque do dia corrente até o fechamento)
    const dataEstFim = daysAgo(1);
    jAtualiza(jid, 88, 'Sincronizando estoques...');
    await Promise.all([loadEstoque(lojaId, dataInicio), loadEstoque(lojaId, dataEstFim)]);

    jAtualiza(jid, 100, `Sincronização concluída — ${diasHist} dias`);
    j.resultado = db.getStats();
    j.done = true;

  } catch (err) {
    console.error('[sync]', err.message);
    j.erro = err.message; j.done = true; j.pct = 0;
    j.etapa = 'Erro: ' + err.message;
  }
}

// ── Análise multi-loja (background) ───────────────────────────────────────
async function rodarAnalise(jid, lojas, fornecedorId, diasAnalise, diasAbast, todosForn = false) {
  const j = jobs.get(jid);
  try {
    const lojaIds  = Array.isArray(lojas) ? lojas : [parseInt(lojas)];
    const lojaRef  = lojaIds[0];
    // Lojas de venda = todas exceto o CD
    // Se só o CD foi selecionado, busca vendas em todas as lojas cadastradas
    let lojaVenda = lojaIds.filter(l => l !== LOJA_CD);
    if (lojaVenda.length === 0) {
      const todasLojas = await loadLojas();
      lojaVenda = todasLojas.map(l => l.loja).filter(l => l !== LOJA_CD);
      // garante que essas lojas também entram no lojaIds para leitura de vendas
      for (const lv of lojaVenda) { if (!lojaIds.includes(lv)) lojaIds.push(lv); }
    }

    jAtualiza(jid, 2, 'Carregando produtos...');
    const todosProd = await loadProdutos(lojaRef);
    const prodMap   = {};
    todosProd.forEach(p => { prodMap[p.plu] = p; });

    // Vínculo fornecedor→produto via compras reais do banco (90 dias, todas as lojas)
    jAtualiza(jid, 5, 'Identificando produtos do fornecedor pelas compras...');
    const plusSet  = new Set();
    const dataFim    = today();
    const dataInicio = daysAgo(diasAnalise);
    const datas      = dateRange(dataInicio, dataFim);

    for (const lid of lojaIds) {
      for (const dt of datas) {
        (db.getCompras(lid, dt) || []).forEach(c => {
          if (String(c.codigo_fornecedor) === String(fornecedorId)) plusSet.add(c.plu);
        });
      }
    }
    // Se solicitado, inclui também PLUs do catálogo do fornecedor (fora do período)
    const plusForaPeriodo = new Set();
    if (todosForn) {
      jAtualiza(jid, 6, 'Buscando catálogo completo do fornecedor no banco...');
      const fp = db.getFP(lojaRef) || [];
      fp.forEach(r => {
        if (String(r.fornecedor) === String(fornecedorId) && !plusSet.has(r.plu)) {
          plusSet.add(r.plu);
          plusForaPeriodo.add(r.plu);
        }
      });
    }

    const plus = [...plusSet];
    if (!plus.length) { j.done = true; j.resultado = []; return; }
    j.totalProdutos = plus.length;

    jAtualiza(jid, 8, `${plus.length} produtos. Verificando fiscal no banco...`);
    const fiscalMap = await loadFiscalBatch(lojaRef, plus, jid, 8, 35);

    // Carrega vendas, estoques e compras de cada loja
    const vendasPorLoja      = {}; // lid → plu → { total, dias, valorTotal }
    const estFimPorLoja      = {}; // lid → plu → qtd
    const estIniPorLoja      = {}; // lid → plu → qtd
    const comprasPorLoja     = {}; // lid → plu → qtd
    const comprasValorPorLoja= {}; // lid → plu → { qtd, valor }

    jAtualiza(jid, 36, `Lendo dados do banco local para ${lojaIds.length} loja(s)...`);

    // custoMap: custo unitário real de cada PLU (do cadastro de produtos, sem filtro rentabilidade)
    const custoMap = db.getCustoMap();
    todosProd.forEach(p => { if (p.custo > 0) custoMap[String(p.plu)] = parseFloat(p.custo); });

    // Se algum PLU analisado não tem nome ou custo (entra_rentabilidade=N),
    // tenta primeiro o cache prod_emb do banco (salvo no sync sem filtro de rentabilidade)
    const plusSemDados = plus.filter(p => !prodMap[p] || !custoMap[String(p)]);
    if (plusSemDados.length > 0) {
      const embMap = db.getProdEmbMap();
      plusSemDados.forEach(p => {
        const e = embMap[String(p)];
        if (!e) return;
        if (e.custo_unit > 0) custoMap[String(p)] = e.custo_unit;
        if (!prodMap[p]) prodMap[p] = { plu: p, descricao: e.descricao, ncm: e.ncm, departamento: e.departamento, valor_produto: e.valor_produto, custo: e.custo_unit, qtd_embalagem: e.qtd_embalagem };
      });
      // Só chama a Hipcom se ainda faltarem dados após o cache
      const aindaSemDados = plusSemDados.filter(p => !prodMap[p] || !custoMap[String(p)]);
      if (aindaSemDados.length > 0) {
        jAtualiza(jid, 37, 'Buscando dados de produtos não catalogados na Hipcom...');
        const todosProdsAnalise = await hGetAll(`/api/hipcom/produtos?loja=${lojaRef}`);
        db.setEmbalagemMap(todosProdsAnalise);
        todosProdsAnalise.forEach(p => {
          if (p.custo > 0) custoMap[String(p.plu)] = parseFloat(p.custo);
          if (!prodMap[p.plu]) prodMap[p.plu] = p;
        });
      }
    }

    // Análise lê APENAS do banco local — nunca chama a Hipcom
    // Para atualizar os dados use "Sincronizar Banco"
    const datasComDados = {};
    for (const lid of lojaIds) {
      const faltandoV = db.datasFaltandoVendas(lid, datas);
      const faltandoC = db.datasFaltandoCompras(lid, datas);
      if (faltandoV.length || faltandoC.length) {
        datasComDados[lid] = { faltaVendas: faltandoV.length, faltaCompras: faltandoC.length };
      }

      vendasPorLoja[lid] = {};
      for (const dt of datas) {
        (db.getVendas(lid, dt) || []).forEach(item => {
          const p    = item.plu;
          const qtd  = parseFloat(item.quantidade_total || 0);
          const cScan = parseFloat(item.custo || 0);
          // custo unitário do cadastro → fator de embalagem = custo_scan / custo_unit
          const cUnit = custoMap[String(p)] || cScan;
          const emb   = cScan > 0 && cUnit > 0 && cScan > cUnit ? Math.round(cScan / cUnit) : 1;
          const qtdUnid = qtd * Math.max(1, emb);
          if (!vendasPorLoja[lid][p]) vendasPorLoja[lid][p] = { total: 0, dias: 0, valorTotal: 0, custoTotal: 0 };
          vendasPorLoja[lid][p].total      += qtdUnid;
          vendasPorLoja[lid][p].valorTotal += parseFloat(item.valor_total || 0);
          vendasPorLoja[lid][p].custoTotal += (cUnit || cScan) * qtdUnid;
          if (qtd > 0) vendasPorLoja[lid][p].dias++;
        });
      }

      estIniPorLoja[lid] = {};
      estFimPorLoja[lid] = {};
      // Hipcom só fecha o estoque do dia no encerramento — usa ontem como referência atual
      const dataEstFimAnalise = daysAgo(1);
      (db.getEstoque(lid, dataInicio)        || []).forEach(e => { estIniPorLoja[lid][e.plu] = parseFloat(e.quantidade_total || 0); });
      (db.getEstoque(lid, dataEstFimAnalise) || []).forEach(e => { estFimPorLoja[lid][e.plu]  = parseFloat(e.quantidade_total || 0); });

      comprasPorLoja[lid]      = {};
      comprasValorPorLoja[lid] = {}; // plu → {qtd, valor} para custo médio ponderado
      for (const dt of datas) {
        (db.getCompras(lid, dt) || []).forEach(c => {
          if (!comprasPorLoja[lid][c.plu]) comprasPorLoja[lid][c.plu] = 0;
          comprasPorLoja[lid][c.plu] += parseFloat(c.quantidade_total || 0);
          if (!comprasValorPorLoja[lid][c.plu]) comprasValorPorLoja[lid][c.plu] = { qtd: 0, valor: 0, ultimaData: '', ultimoCustoNF: 0 };
          comprasValorPorLoja[lid][c.plu].qtd   += parseFloat(c.quantidade_total || 0);
          comprasValorPorLoja[lid][c.plu].valor  += parseFloat(c.valor_total || 0);
          // rastreia custo unitário da NF mais recente (valor_total / quantidade_total)
          const qtdC = parseFloat(c.quantidade_total || 0);
          const valC = parseFloat(c.valor_total || 0);
          if (qtdC > 0 && dt >= comprasValorPorLoja[lid][c.plu].ultimaData) {
            comprasValorPorLoja[lid][c.plu].ultimaData    = dt;
            comprasValorPorLoja[lid][c.plu].ultimoCustoNF = valC / qtdC;
          }
        });
      }
    }

    // Avisa se há dados faltando (banco desatualizado)
    const lojasSemDados = Object.keys(datasComDados);
    if (lojasSemDados.length) {
      const aviso = lojasSemDados.map(lid => `Loja ${lid}: ${datasComDados[lid].faltaVendas} dias de vendas e ${datasComDados[lid].faltaCompras} de compras faltando`).join('; ');
      console.warn('[analise] Banco desatualizado —', aviso);
      j.avisoSync = aviso;
    }

    jAtualiza(jid, 80, 'Calculando sugestões e transferências...');

    const resultado = plus.map(plu => {
      const prod    = prodMap[plu] || {};
      const fRaw    = fiscalMap[plu];
      const custo   = parseFloat(prod.custo        || 0); // custo balanço (reposição)
      const preco   = parseFloat(prod.valor_produto || 0);
      const ncmStr  = String(prod.ncm || '').replace(/\D/g, '').padStart(8, '0');
      const ncmInfo = getNcmInfo(ncmStr);

      // custo da última NF de entrada (base mais precisa para Custo Líq.)
      let custoNF = 0, melhorDataNF = '';
      for (const lid of lojaIds) {
        const cv = comprasValorPorLoja[lid]?.[plu];
        if (cv && cv.ultimaData >= melhorDataNF && cv.ultimoCustoNF > 0) {
          melhorDataNF = cv.ultimaData;
          custoNF      = cv.ultimoCustoNF;
        }
      }
      const ca      = calcLucroReal(custo, preco, fRaw, ncmInfo);

      let cAntes = null;
      if (ncmInfo && ncmInfo.icms_sp && ncmInfo.icms_sp.st_removida) {
        const custoComST = custo * (1 + (ncmInfo.icms_sp.aliq || 12) / 100);
        const fAntes     = fRaw ? { ...fRaw, icmsCstSaida: '60', icmsAlqEntrada: 0, icmsAlqSaida: 0 } : null;
        cAntes = calcLucroReal(custoComST, preco, fAntes, ncmInfo);
        cAntes.nota = 'Estimativa com ST ativa';
      }
      const reforma = calcReforma(custo, preco, ncmInfo, ca);

      // Dados por loja (para transferência)
      const qtdEmb = parseFloat(prod.qtd_embalagem || 1) || 1;
      const porLoja = lojaIds.map(lid => {
        const v      = vendasPorLoja[lid][plu]  || { total: 0, dias: 0, valorTotal: 0 };
        // Para lojaRef, qtd_estoque_atual é em tempo real — tem precedência sobre snapshot de ontem
        const estAtualRef = lid === lojaRef ? parseFloat(prod.qtd_estoque_atual || 0) : null;
        const estSnap     = estFimPorLoja[lid][plu] ?? (lid === lojaRef ? 0 : 0);
        const estFim      = estAtualRef !== null ? estAtualRef : estSnap;
        const estIni = estIniPorLoja[lid][plu]  ?? estFim;
        const cmp    = comprasPorLoja[lid][plu] || 0;
        const vmd    = diasAnalise > 0 ? v.total / diasAnalise : 0;
        const nec    = vmd * diasAbast;
        const excesso = Math.max(0, estFim - nec * 1.3);
        return {
          loja: lid,
          estoque:   +estFim.toFixed(3),
          estoque_ini: +estIni.toFixed(3),
          venda_total: +v.total.toFixed(3),
          compras:   +cmp.toFixed(3),
          venda_media_dia: +vmd.toFixed(3),
          necessidade: +nec.toFixed(3),
          excesso:   +excesso.toFixed(3),
        };
      });

      // Agregado total
      // Vendas: só lojas de venda (exceto CD)
      const vTotal      = porLoja.filter(l => l.loja !== LOJA_CD).reduce((s, l) => s + l.venda_total, 0);
      const receitaReal  = lojaVenda.reduce((s, lid) => s + (vendasPorLoja[lid]?.[plu]?.valorTotal  || 0), 0);
      const custoTotalVendas = lojaVenda.reduce((s, lid) => s + (vendasPorLoja[lid]?.[plu]?.custoTotal || 0), 0);
      const vDiasMedia = lojaVenda.reduce((s, lid) => s + (vendasPorLoja[lid]?.[plu]?.dias || 0), 0) / Math.max(lojaVenda.length, 1);
      // Estoque: todas as lojas (CD + lojas de venda)
      const estAtual  = porLoja.reduce((s, l) => s + l.estoque,    0);
      const estInicio = porLoja.reduce((s, l) => s + l.estoque_ini, 0);
      const totalCmp  = porLoja.reduce((s, l) => s + l.compras,    0);

      // Custo médio ponderado: derivado do custo×qtd das próprias vendas (mesma unidade da API)
      // Fallback: prod.custo quando não há histórico de vendas com custo no período
      const custoMedioPonderado = vTotal > 0 && custoTotalVendas > 0
        ? custoTotalVendas / vTotal
        : (custo > 0 ? custo : null);

      const vendaMediaDia = diasAnalise > 0 ? vTotal / diasAnalise : 0;
      const quebraEst     = Math.max(0, estInicio + totalCmp - vTotal - estAtual);
      const baseQuebra    = estInicio + totalCmp;
      const taxaQuebra    = baseQuebra > 0 ? (quebraEst / baseQuebra) * 100 : 0;
      const qtdNec        = vendaMediaDia * diasAbast;
      const qtdComQbr     = qtdNec * (1 + taxaQuebra / 100);
      const qtdLiqEst     = qtdComQbr - estAtual;
      const rupturaPct    = diasAnalise > 0 && vendaMediaDia > 0
        ? Math.max(0, ((diasAnalise - vDiasMedia) / diasAnalise) * 100) : 0;
      let qtdSug = Math.max(0, qtdLiqEst);
      if (rupturaPct > 30) qtdSug *= 1.2;
      const qtdFinal    = Math.ceil(qtdSug / qtdEmb) * qtdEmb;

      // Sugestões de transferência (antes de comprar)
      const transferencias = [];
      if (qtdSug > qtdEmb) {
        porLoja.forEach(l => {
          const qtdTransf = Math.floor(l.excesso / qtdEmb) * qtdEmb;
          if (qtdTransf >= qtdEmb && l.loja !== lojaRef) transferencias.push({ de_loja: l.loja, para_loja: lojaRef, qtd: qtdTransf, excesso: l.excesso });
        });
      }
      const qtdTransfTotal   = Math.min(transferencias.reduce((s, t) => s + t.qtd, 0), qtdFinal);
      const qtdComprarAposTf = Math.max(0, Math.ceil((qtdSug - qtdTransfTotal) / qtdEmb) * qtdEmb);
      const valorPedido      = qtdComprarAposTf * custo;
      const recPrevista      = vendaMediaDia * diasAbast * preco;
      const lucroPrev        = vendaMediaDia * diasAbast * (preco - ca.custo_real - ca.tot_imp_saida);

      // Custo real do período usando CMV (custo médio ponderado das NFs de entrada)
      const caCmv = custoMedioPonderado ? calcLucroReal(custoMedioPonderado, preco, fRaw, ncmInfo) : null;

      const ml = ca.margem_liquida;
      const foraPeriodo = plusForaPeriodo.has(plu);
      let status = 'OK';
      if      (foraPeriodo)                           status = 'FORA DO PERÍODO';
      else if (custo === 0)                           status = 'SEM CUSTO';
      else if (vendaMediaDia === 0 && estAtual === 0) status = 'INATIVO';
      else if (vendaMediaDia === 0)                   status = 'SEM GIRO';
      else if (qtdFinal === 0)                        status = 'ESTOQUE OK';
      else if (ml != null && ml < 0)                  status = 'ABAIXO DO CUSTO';
      else if (ml != null && ml < 30)                 status = 'REVISAR PREÇO';
      else if (rupturaPct > 30)                       status = 'RUPTURA FREQUENTE';

      const recomendaCompra = qtdComprarAposTf > 0
        && status !== 'SEM CUSTO' && status !== 'INATIVO'
        && status !== 'SEM GIRO'  && status !== 'ABAIXO DO CUSTO';

      const alertas = [];
      if (ncmInfo?.icms_sp?.st_removida)
        alertas.push({ tipo: 'ST_REMOVIDA', msg: ncmInfo.icms_sp.alerta });
      if (ca.regime_pis_cofins === 'monofasico')
        alertas.push({ tipo: 'MONOFASICO', msg: 'PIS/COFINS monofásico — sem crédito/débito no varejo.' });
      if (ca.regime_pis_cofins === 'isento')
        alertas.push({ tipo: 'ISENTO', msg: 'PIS/COFINS isento — cesta básica / Lei 10.925.' });
      if (!ncmStr || ncmStr === '00000000')
        alertas.push({ tipo: 'SEM_NCM', msg: 'NCM não cadastrado na Hipcom.' });
      if (fRaw && !ca.tem_st && ncmInfo?.icms_sp?.st_ativo)
        alertas.push({ tipo: 'DIVERGENCIA_CST', msg: `Hipcom CST ${fRaw.icmsCstSaida} mas NCM aponta ST ativa em SP.` });
      if (!fRaw)
        alertas.push({ tipo: 'SEM_FISCAL', msg: 'Sem dados fiscais no Hipcom — estimado pela tabela NCM.' });
      if (transferencias.length)
        alertas.push({ tipo: 'TRANSFERENCIA', msg: `Excesso em ${transferencias.length} loja(s) — verifique transferência antes de comprar.`, lojas: transferencias.map(t => ({ de_loja: t.de_loja, para_loja: t.para_loja })) });

      return {
        plu, nome: prod.descricao || '', ncm: ncmStr !== '00000000' ? ncmStr : 'N/D',
        departamento: prod.departamento || '', secao: prod.secao || '',
        curva_abc: prod.curva_abc || '', ativo: prod.ativo || 'S',
        estoque_atual: +estAtual.toFixed(3), estoque_inicio: +estInicio.toFixed(3),
        total_vendas_periodo: +vTotal.toFixed(3), total_compras_periodo: +totalCmp.toFixed(3),
        venda_media_dia: +vendaMediaDia.toFixed(3),
        taxa_quebra: +taxaQuebra.toFixed(2), ruptura_pct: +rupturaPct.toFixed(1),
        qtd_embalagem: qtdEmb, qtd_sugerida: +qtdFinal.toFixed(0),
        qtd_transferencia: +qtdTransfTotal.toFixed(0),
        qtd_comprar: +qtdComprarAposTf.toFixed(0),
        valor_pedido: +valorPedido.toFixed(2),
        receita_prevista: +recPrevista.toFixed(2), lucro_previsto: +lucroPrev.toFixed(2),
        receita_periodo: +receitaReal.toFixed(2),
        custo_medio_ponderado: custoMedioPonderado ? +custoMedioPonderado.toFixed(4) : null,
        total_compras_valor: null,
        fiscal_cmv: caCmv,
        recomenda_compra: recomendaCompra, status, alertas,
        transferencias, por_loja: porLoja, lojas_analise: lojaIds,
        fiscal: {
          custo_hipcom: +custo.toFixed(4), preco_venda: +preco.toFixed(4),
          custo_nf_ultimo: (() => {
            // custo unitário da última NF de entrada deste PLU (qualquer loja)
            let melhorData = '', melhorCusto = 0;
            for (const lid of lojaIds) {
              const cv = comprasValorPorLoja[lid]?.[plu];
              if (cv && cv.ultimaData >= melhorData && cv.ultimoCustoNF > 0) {
                melhorData  = cv.ultimaData;
                melhorCusto = cv.ultimoCustoNF;
              }
            }
            return melhorCusto > 0 ? +melhorCusto.toFixed(4) : null;
          })(),
          cenario_atual: ca, cenario_anterior: cAntes, cenarios_reforma: reforma,
          ncm_info: ncmInfo ? {
            descricao: ncmInfo.descricao, categoria: ncmInfo.categoria,
            regime_pis_cofins: ca.regime_pis_cofins,
            st_ativo:        ncmInfo.icms_sp?.st_ativo        ?? null,
            st_removida:     ncmInfo.icms_sp?.st_removida     ?? false,
            st_data_remocao: ncmInfo.icms_sp?.st_data_remocao ?? null,
            st_portaria:     ncmInfo.icms_sp?.st_portaria     ?? null,
            alerta:          ncmInfo.icms_sp?.alerta          ?? '',
            ncm_mapeado: ncmInfo !== (NCM_TABLE.ncms || {})['_padrao'],
          } : null,
        },
      };
    });

    resultado.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));

    jAtualiza(jid, 100, `Concluído — ${resultado.length} produtos`);
    j.resultado = resultado; j.done = true;

  } catch (err) {
    console.error('[análise]', err.message);
    j.erro = err.message; j.done = true; j.pct = 0;
    j.etapa = 'Erro: ' + err.message;
  }
}

// ── Análise de Transferência (CD → lojas de venda) ────────────────────────
async function rodarAnaliseTransferencia(jid, nfRef) {
  const j = jobs.get(jid);
  try {
    jAtualiza(jid, 5, 'Lendo itens da NF...');
    const todasLojas = await loadLojas();
    const lojaVenda  = todasLojas.map(l => l.loja).filter(l => l !== LOJA_CD);
    const lojaRef    = lojaVenda[0] || 1;

    const itenNF = [];
    (db.getCompras(LOJA_CD, nfRef.data_entrada) || []).forEach(c => {
      if (String(c.numero_nf) === String(nfRef.numero_nf) &&
          String(c.serie_nf)  === String(nfRef.serie_nf)) {
        itenNF.push(c);
      }
    });
    if (!itenNF.length) { j.done = true; j.resultado = []; return; }

    const plus        = [...new Set(itenNF.map(c => c.plu))];
    const qtdNFporPlu = {};
    const valNFporPlu = {};
    itenNF.forEach(c => {
      qtdNFporPlu[c.plu] = parseFloat(c.quantidade_total || 0);
      valNFporPlu[c.plu] = parseFloat(c.valor_total || 0);
    });

    jAtualiza(jid, 10, `${plus.length} produtos na NF. Carregando dados...`);

    const lojaIds   = [LOJA_CD, ...lojaVenda];
    const todosProd = await loadProdutos(lojaRef);
    const prodMap   = {};
    todosProd.forEach(p => { prodMap[p.plu] = p; });

    // Preenche prodMap com produtos fora da rentabilidade via cache local
    const embMap = db.getProdEmbMap();
    plus.forEach(plu => {
      if (!prodMap[plu] && embMap[String(plu)]) {
        const e = embMap[String(plu)];
        prodMap[plu] = { plu, descricao: e.descricao, ncm: e.ncm, departamento: e.departamento, valor_produto: e.valor_produto, custo: e.custo_unit, qtd_embalagem: e.qtd_embalagem };
      }
    });

    // Usa todo o histórico disponível no banco (DIAS_HIST) para estimar vendas
    const diasHist   = DIAS_HIST;
    const dataFim    = today();
    const dataInicio = daysAgo(diasHist);
    const datas      = dateRange(dataInicio, dataFim);
    const dataEstFim = daysAgo(1);

    const custoMap = db.getCustoMap();
    todosProd.forEach(p => { if (p.custo > 0) custoMap[String(p.plu)] = parseFloat(p.custo); });

    jAtualiza(jid, 35, 'Lendo vendas e estoques no banco...');
    const vendasPorLoja = {};
    const estPorLoja    = {};

    for (const lid of lojaIds) {
      vendasPorLoja[lid] = {};
      estPorLoja[lid]    = {};

      // Vendas: todo o histórico no banco
      for (const dt of datas) {
        (db.getVendas(lid, dt) || []).forEach(item => {
          if (!plus.includes(item.plu)) return;
          const qtd   = parseFloat(item.quantidade_total || 0);
          const cScan = parseFloat(item.custo || 0);
          const cUnit = custoMap[String(item.plu)] || cScan;
          const emb   = cScan > 0 && cUnit > 0 && cScan > cUnit ? Math.round(cScan / cUnit) : 1;
          if (!vendasPorLoja[lid][item.plu]) vendasPorLoja[lid][item.plu] = 0;
          vendasPorLoja[lid][item.plu] += qtd * Math.max(1, emb);
        });
      }

      // Estoque atual
      const snaps = db.getEstoque(lid, dataEstFim) || [];
      snaps.forEach(e => { estPorLoja[lid][e.plu] = parseFloat(e.quantidade_total || 0); });
    }

    // Estoque em tempo real da lojaRef
    todosProd.forEach(p => { estPorLoja[lojaRef][p.plu] = parseFloat(p.qtd_estoque_atual || 0); });

    jAtualiza(jid, 75, 'Calculando distribuição...');

    const resultado = plus.map(plu => {
      const prod    = prodMap[plu] || {};
      const custo   = parseFloat(prod.custo || 0);
      const preco   = parseFloat(prod.valor_produto || 0);
      const qtdEmb  = parseFloat(prod.qtd_embalagem || 1) || 1;

      const qtdRecebidaCD = qtdNFporPlu[plu] || 0;
      const custoUnitNF   = qtdRecebidaCD > 0 ? (valNFporPlu[plu] || 0) / qtdRecebidaCD : custo;
      const estCD         = estPorLoja[LOJA_CD]?.[plu] || 0;

      // Vendas históricas por loja de venda (período completo do banco)
      const porLoja = lojaVenda.map(lid => ({
        loja:        lid,
        estoque:     +(estPorLoja[lid]?.[plu] || 0).toFixed(3),
        venda_total: +(vendasPorLoja[lid]?.[plu] || 0).toFixed(3),
      }));

      // Distribuição proporcional à venda, com prioridade para estoque zero
      // 1. Calcula peso de cada loja (vendas históricas; mínimo 1 se zerado para não excluir)
      const totalVendas = porLoja.reduce((s, l) => s + l.venda_total, 0);
      const pesos = porLoja.map(l => totalVendas > 0 ? l.venda_total / totalVendas : 1 / porLoja.length);

      // 2. Quantidade disponível para distribuir = estoque do CD
      let disponivel = Math.floor(estCD / qtdEmb) * qtdEmb;

      // 3. Calcula sugestão proporcional
      const transfs = [];
      porLoja.forEach((l, i) => {
        const bruto = disponivel * pesos[i];
        // Arredonda para baixo em embalagem (exceto se for a última loja, recebe o restante)
        const qtdTransf = Math.floor(bruto / qtdEmb) * qtdEmb;
        transfs.push({ para_loja: l.loja, qtd: qtdTransf, estoque_loja: l.estoque, venda_total: l.venda_total, peso_pct: +(pesos[i] * 100).toFixed(1) });
      });

      // 4. Distribui sobra de arredondamento para a loja com maior venda que ainda tem "crédito"
      const totalTransfCalc = transfs.reduce((s, t) => s + t.qtd, 0);
      let sobra = disponivel - totalTransfCalc;
      if (sobra >= qtdEmb) {
        const iMax = transfs.reduce((best, t, i) => t.peso_pct > transfs[best].peso_pct ? i : best, 0);
        transfs[iMax].qtd += Math.floor(sobra / qtdEmb) * qtdEmb;
      }

      // 5. Lojas com estoque zero têm garantia de pelo menos 1 embalagem se houver disponível
      let dispExtra = disponivel;
      for (const t of transfs) {
        if (t.estoque_loja === 0 && t.qtd === 0 && dispExtra >= qtdEmb) {
          t.qtd = qtdEmb; dispExtra -= qtdEmb;
        }
        dispExtra -= t.qtd;
      }

      const totalTransf = transfs.filter(t => t.qtd > 0).reduce((s, t) => s + t.qtd, 0);
      const sobraCD     = estCD - totalTransf;

      const status = estCD === 0 ? 'SEM ESTOQUE CD'
                   : totalTransf === 0 ? 'CD OK — SEM DEMANDA'
                   : 'TRANSFERIR';

      return {
        plu, nome: prod.descricao || '',
        departamento: prod.departamento || '',
        qtd_embalagem: qtdEmb,
        qtd_recebida_cd: +qtdRecebidaCD.toFixed(3),
        custo_unit_nf: +custoUnitNF.toFixed(4),
        valor_total_nf: +(valNFporPlu[plu] || 0).toFixed(2),
        estoque_cd: +estCD.toFixed(3),
        saldo_cd_apos_transf: +sobraCD.toFixed(3),
        total_a_transferir: +totalTransf.toFixed(3),
        dias_historico: diasHist,
        status,
        transferencias: transfs.filter(t => t.qtd > 0),
        por_loja: porLoja,
      };
    });

    resultado.sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR'));
    jAtualiza(jid, 100, `Concluído — ${resultado.length} produtos`);
    j.resultado = { nf: nfRef, lojas_venda: lojaVenda, loja_cd: LOJA_CD, produtos: resultado };
    j.done = true;

  } catch (err) {
    console.error('[transferência]', err.message);
    j.erro = err.message; j.done = true; j.pct = 0;
    j.etapa = 'Erro: ' + err.message;
  }
}

// ── Cálculos fiscais ───────────────────────────────────────────────────────
function calcLucroReal(custo, preco, f, ncmInfo) {
  if (!f) return calcFallback(custo, preco, ncmInfo);
  const temST    = String(f.icmsCstSaida || '').trim() === '60';
  const alqIcmsE = parseFloat(f.icmsAlqEntrada    || 0);
  const alqIcmsS = parseFloat(f.icmsAlqSaida      || 0);
  const credIcms = temST ? 0 : custo * (alqIcmsE / 100);
  const debIcms  = temST ? 0 : preco  * (alqIcmsS / 100);
  const pE = parseFloat(f.pisAlqEntrada      || 0), cE = parseFloat(f.cofinsAliqEntrada || 0);
  const pS = parseFloat(f.pisAlqSaida        || 0), cS = parseFloat(f.cofinsAlqSaida   || 0);
  const credPis = custo*(pE/100), credCof = custo*(cE/100);
  const debPis  = preco*(pS/100), debCof  = preco*(cS/100);
  const debFcp  = preco*(parseFloat(f.fcp || 0)/100);
  const custoReal   = custo - credIcms - credPis - credCof;
  const totImpSaida = debIcms + debPis + debCof + debFcp;
  const ml          = preco > 0 ? ((preco - custoReal - totImpSaida) / preco) * 100 : null;
  const alqTot      = ((alqIcmsS*(temST?0:1)) + pS + cS + parseFloat(f.fcp||0)) / 100;
  const p30 = custoReal > 0 && (1-alqTot-0.30) > 0 ? custoReal/(1-alqTot-0.30) : null;
  const p35 = custoReal > 0 && (1-alqTot-0.35) > 0 ? custoReal/(1-alqTot-0.35) : null;
  const cstS = parseInt(f.pisCofinsCstSaida || '99');
  let regime = 'normal';
  if (pE===0 && cE===0 && pS===0 && cS===0)
    regime = (cstS >= 4 && cstS <= 6) ? 'isento' : 'monofasico';
  return {
    origem:'hipcom', tem_st:temST, cst_icms_saida:String(f.icmsCstSaida||''),
    alq_icms_entrada:alqIcmsE, alq_icms_saida:alqIcmsS, regime_pis_cofins:regime,
    alq_pis_entrada:pE, alq_cofins_entrada:cE, alq_pis_saida:pS, alq_cofins_saida:cS,
    alq_fcp:parseFloat(f.fcp||0),
    cred_icms:+credIcms.toFixed(4), cred_pis:+credPis.toFixed(4), cred_cofins:+credCof.toFixed(4),
    custo_real:+custoReal.toFixed(4),
    deb_icms:+debIcms.toFixed(4), deb_pis:+debPis.toFixed(4), deb_cofins:+debCof.toFixed(4), deb_fcp:+debFcp.toFixed(4),
    tot_imp_saida:+totImpSaida.toFixed(4),
    margem_bruta:   preco>0 ? +((preco-custo)/preco*100).toFixed(2) : null,
    margem_liquida: ml!=null ? +ml.toFixed(2) : null,
    preco_min_30: p30 ? +p30.toFixed(4) : null, preco_min_35: p35 ? +p35.toFixed(4) : null,
  };
}

function calcFallback(custo, preco, ncmInfo) {
  const icms_sp = ncmInfo && ncmInfo.icms_sp;
  const pc      = ncmInfo && ncmInfo.pis_cofins;
  const alqI    = icms_sp ? icms_sp.aliq    : 12;
  const temST   = icms_sp ? icms_sp.st_ativo : false;
  const regime  = pc ? pc.regime : 'normal';
  const pE = regime==='normal'?(pc?pc.aliq_pis_entrada   :1.65):0;
  const cE = regime==='normal'?(pc?pc.aliq_cofins_entrada:7.60):0;
  const pS = regime==='normal'?(pc?pc.aliq_pis_saida     :1.65):0;
  const cS = regime==='normal'?(pc?pc.aliq_cofins_saida  :7.60):0;
  const credI=temST?0:custo*(alqI/100); const debI=temST?0:preco*(alqI/100);
  const cR=custo-credI-custo*(pE/100)-custo*(cE/100);
  const totI=debI+preco*(pS/100)+preco*(cS/100);
  const ml=preco>0?((preco-cR-totI)/preco)*100:null;
  const alqT=(alqI*(temST?0:1)+pS+cS)/100;
  const p30=cR>0&&(1-alqT-0.30)>0?cR/(1-alqT-0.30):null;
  const p35=cR>0&&(1-alqT-0.35)>0?cR/(1-alqT-0.35):null;
  return {
    origem:'ncm_tabela', tem_st:temST, regime_pis_cofins:regime,
    alq_icms_entrada:alqI, alq_icms_saida:alqI,
    alq_pis_entrada:pE, alq_cofins_entrada:cE, alq_pis_saida:pS, alq_cofins_saida:cS, alq_fcp:0,
    cred_icms:+credI.toFixed(4), cred_pis:+(custo*(pE/100)).toFixed(4), cred_cofins:+(custo*(cE/100)).toFixed(4),
    custo_real:+cR.toFixed(4), deb_icms:+debI.toFixed(4), deb_pis:+(preco*(pS/100)).toFixed(4),
    deb_cofins:+(preco*(cS/100)).toFixed(4), deb_fcp:0, tot_imp_saida:+totI.toFixed(4),
    margem_bruta:   preco>0?+((preco-custo)/preco*100).toFixed(2):null,
    margem_liquida: ml!=null?+ml.toFixed(2):null,
    preco_min_30:p30?+p30.toFixed(4):null, preco_min_35:p35?+p35.toFixed(4):null,
  };
}

function calcReforma(custo, preco, ncmInfo, ca) {
  const cat     = ncmInfo&&ncmInfo.reforma?ncmInfo.reforma.categoria:'alimentacao_reducao60';
  const aliqCat = ((NCM_TABLE.aliquotas_reforma_por_categoria||{})[cat])||{cbs_2027:8.8,ibs_2033:17.7};
  const isCesta = cat==='cesta_basica_nacional';
  const cbs27   = isCesta?0:(aliqCat.cbs_2027||8.8);
  const ibs33   = isCesta?0:(aliqCat.ibs_2033||17.7);
  const alqIcms = ca.alq_icms_saida||12;
  const pisSai  = ca.alq_pis_saida||1.65;
  const cofSai  = ca.alq_cofins_saida||7.6;
  const _c=(cbs,ibs,icms)=>{
    const tot=cbs+ibs+icms; const cred=custo*(cbs+ibs)/100; const deb=preco*tot/100; const cr=custo-cred;
    return{custo_real:+cr.toFixed(4),tot_imp_saida:+deb.toFixed(4),margem:preco>0?+((preco-cr-deb)/preco*100).toFixed(2):null};
  };
  return {
    categoria:cat, cesta_basica:isCesta,
    cenarios:{
      '2025':{descricao:'Regime atual',..._c(pisSai,cofSai,ca.tem_st?0:alqIcms)},
      '2027':{descricao:'CBS substitui PIS/COFINS',cbs:cbs27,..._c(cbs27,0,alqIcms)},
      '2029':{descricao:'IBS 10% / ICMS –10%',cbs:cbs27,ibs:+(ibs33*.1).toFixed(2),icms:+(alqIcms*.9).toFixed(2),..._c(cbs27,ibs33*.1,alqIcms*.9)},
      '2030':{descricao:'IBS 20% / ICMS –20%',cbs:cbs27,ibs:+(ibs33*.2).toFixed(2),icms:+(alqIcms*.8).toFixed(2),..._c(cbs27,ibs33*.2,alqIcms*.8)},
      '2031':{descricao:'IBS 30% / ICMS –30%',cbs:cbs27,ibs:+(ibs33*.3).toFixed(2),icms:+(alqIcms*.7).toFixed(2),..._c(cbs27,ibs33*.3,alqIcms*.7)},
      '2032':{descricao:'IBS 40% / ICMS –40%',cbs:cbs27,ibs:+(ibs33*.4).toFixed(2),icms:+(alqIcms*.6).toFixed(2),..._c(cbs27,ibs33*.4,alqIcms*.6)},
      '2033':{descricao:'IBS+CBS plenos / ICMS extinto',cbs:cbs27,ibs:ibs33,..._c(cbs27,ibs33,0)},
    },
  };
}

// ── Lê body de POST ────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(ok => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => ok(b));
  });
}

// ── Resposta HTTP ──────────────────────────────────────────────────────────
function jRes(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ── Servidor ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const q        = parsed.query;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type' });
    return res.end();
  }

  // ── Helpers de cookie ──────────────────────────────────────────────────────
  function getCookie(name) {
    const c = (req.headers.cookie || '').split(';').map(s => s.trim());
    const found = c.find(s => s.startsWith(name + '='));
    return found ? found.slice(name.length + 1) : null;
  }
  function setCookie(res, name, value, maxAge) {
    res.setHeader('Set-Cookie', `${name}=${value}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`);
  }

  // ── Rotas públicas: login ──────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/login') {
    const f = path.join(__dirname, 'login.html');
    if (fs.existsSync(f)) { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return res.end(fs.readFileSync(f,'utf8')); }
  }

  if (req.method === 'POST' && pathname === '/auth/login') {
    const body = JSON.parse(await readBody(req) || '{}');
    const u = db.autenticarUsuario(body.usuario, body.senha);
    if (!u) return jRes(res, 401, { erro: 'Usuário ou senha incorretos' });
    const token = db.criarSessao(u.id);
    setCookie(res, 'sess', token, 8 * 3600);
    return jRes(res, 200, { ok: true, nome: u.nome, admin: u.admin });
  }

  if (req.method === 'POST' && pathname === '/auth/logout') {
    const token = getCookie('sess');
    if (token) db.deleteSessao(token);
    setCookie(res, 'sess', '', 0);
    return jRes(res, 200, { ok: true });
  }

  // ── Verificação de sessão para todas as outras rotas ───────────────────────
  const token = getCookie('sess');
  const sessao = db.getSessao(token);
  if (!sessao) {
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      res.writeHead(302, { Location: '/login' }); return res.end();
    }
    return jRes(res, 401, { erro: 'Não autenticado' });
  }

  // ── Rotas de gestão de usuários (admin) ────────────────────────────────────
  if (pathname === '/auth/me') return jRes(res, 200, { nome: sessao.nome, usuario: sessao.usuario, admin: sessao.admin });

  if (pathname === '/auth/usuarios') {
    if (!sessao.admin) return jRes(res, 403, { erro: 'Acesso negado' });
    if (req.method === 'GET') return jRes(res, 200, db.listarUsuarios());
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.usuario || !body.senha || !body.nome) return jRes(res, 400, { erro: 'nome, usuario e senha são obrigatórios' });
      try {
        db.criarUsuario(body.nome, body.usuario, body.senha, body.admin || 0);
        return jRes(res, 201, { ok: true });
      } catch(e) {
        return jRes(res, 409, { erro: 'Usuário já existe' });
      }
    }
  }

  if (pathname.startsWith('/auth/usuarios/') && req.method === 'DELETE') {
    if (!sessao.admin) return jRes(res, 403, { erro: 'Acesso negado' });
    const id = parseInt(pathname.split('/').pop());
    if (id === sessao.usuario_id) return jRes(res, 400, { erro: 'Não pode remover seu próprio usuário' });
    db.deletarUsuario(id);
    return jRes(res, 200, { ok: true });
  }

  if (pathname === '/auth/senha' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    if (!body.senha || body.senha.length < 4) return jRes(res, 400, { erro: 'Senha muito curta' });
    db.alterarSenha(sessao.usuario_id, body.senha);
    return jRes(res, 200, { ok: true });
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const f = path.join(__dirname, 'index.html');
    if (fs.existsSync(f)) { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return res.end(fs.readFileSync(f,'utf8')); }
  }

  if (req.method === 'GET' && pathname === '/documentacao.html') {
    const f = path.join(__dirname, 'documentacao.html');
    if (fs.existsSync(f)) { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return res.end(fs.readFileSync(f,'utf8')); }
  }

  try {
    const loja = parseInt(q.loja || '1');

    if (pathname === '/api/lojas')              return jRes(res, 200, await loadLojas());
    if (pathname === '/api/fornecedores')       return jRes(res, 200, await loadFornecedores());
    if (pathname === '/api/cronograma-reforma') return jRes(res, 200, { cronograma: NCM_TABLE.cronograma_reforma||{}, categorias: NCM_TABLE.aliquotas_reforma_por_categoria||{} });
    if (pathname.startsWith('/api/ncm/'))       return jRes(res, 200, { ncm: pathname.split('/').pop(), info: getNcmInfo(pathname.split('/').pop()) });
    if (pathname === '/api/banco/status')       return jRes(res, 200, db.getStats());

    // ── Sync ──────────────────────────────────────────────────────────────
    if (pathname === '/api/sync/iniciar') {
      const jid  = jId();
      const dias = parseInt(q.dias || String(DIAS_HIST));
      jobs.set(jid, { pct:0, etapa:'Iniciando sincronização...', done:false, erro:null, resultado:null, tipo:'sync' });
      rodarSync(jid, loja, dias).catch(() => {});
      return jRes(res, 200, { jobId: jid });
    }
    if (pathname === '/api/sync/progresso') {
      const j = jobs.get(q.job);
      if (!j) return jRes(res, 404, { erro: 'Job não encontrado' });
      return jRes(res, 200, { pct:j.pct, etapa:j.etapa, done:j.done, erro:j.erro });
    }
    if (pathname === '/api/sync/resultado') {
      const j = jobs.get(q.job);
      if (!j) return jRes(res, 404, { erro: 'Job não encontrado' });
      if (!j.done) return jRes(res, 202, { msg:'Sincronizando', pct:j.pct });
      if (j.erro)  return jRes(res, 500, { erro:j.erro });
      return jRes(res, 200, { ok:true, stats:j.resultado });
    }

    // ── Análise ────────────────────────────────────────────────────────────
    if (pathname === '/api/analise/iniciar') {
      if (!q.id) return jRes(res, 400, { erro: 'id obrigatório' });
      const jid   = jId();
      const dias  = parseInt(q.dias       || '30');
      const dabst = parseInt(q.dias_abast || '30');
      // Aceita ?lojas=1,2,3 (multi) ou ?loja=1 (retrocompatível)
      const lojas = q.lojas
        ? q.lojas.split(',').map(Number).filter(n => n > 0)
        : [parseInt(q.loja || '1')];
      const todosForn = q.todos === '1';
      jobs.set(jid, { pct:0, etapa:'Iniciando...', done:false, erro:null, resultado:null });
      rodarAnalise(jid, lojas, q.id, dias, dabst, todosForn).catch(() => {});
      for (const [k, v] of jobs) if (v.done && k !== jid) jobs.delete(k);
      return jRes(res, 200, { jobId: jid });
    }
    if (pathname === '/api/analise/progresso') {
      const j = jobs.get(q.job);
      if (!j) return jRes(res, 404, { erro: 'Job não encontrado' });
      return jRes(res, 200, { pct:j.pct, etapa:j.etapa, done:j.done, erro:j.erro, totalProdutos:j.totalProdutos });
    }
    if (pathname === '/api/analise/resultado') {
      const j = jobs.get(q.job);
      if (!j) return jRes(res, 404, { erro: 'Job não encontrado' });
      if (!j.done) return jRes(res, 202, { msg:'Processando', pct:j.pct });
      if (j.erro)  return jRes(res, 500, { erro:j.erro });
      return jRes(res, 200, { dados: j.resultado, avisoSync: j.avisoSync || null });
    }

    // ── Pedidos de Compra ─────────────────────────────────────────────────
    if (pathname === '/api/pedidos/salvar' && req.method === 'POST') {
      const body = await readBody(req);
      const p = JSON.parse(body);
      const id = db.salvarPedido(p, sessao?.usuario || '');
      return jRes(res, 200, { id });
    }
    if (pathname === '/api/pedidos/listar') {
      return jRes(res, 200, db.listarPedidos());
    }
    if (pathname === '/api/pedidos/ver') {
      const p = db.verPedido(parseInt(q.id));
      if (!p) return jRes(res, 404, { erro: 'Pedido não encontrado' });
      return jRes(res, 200, p);
    }
    if (pathname === '/api/pedidos/deletar' && req.method === 'DELETE') {
      db.deletarPedido(parseInt(q.id));
      return jRes(res, 200, { ok: true });
    }

    // ── Prazos por Fornecedor ─────────────────────────────────────────────
    if (pathname === '/api/prazos/get') {
      return jRes(res, 200, db.getPrazo(parseInt(q.fornecedor || '0')));
    }
    if (pathname === '/api/prazos/set' && req.method === 'POST') {
      const body = await readBody(req);
      const p = JSON.parse(body);
      db.setPrazo(p.fornecedor, p);
      return jRes(res, 200, { ok: true });
    }

    // ── Contas a Pagar ────────────────────────────────────────────────────
    if (pathname === '/api/contaspagar/status') {
      return jRes(res, 200, db.getStatsCP());
    }
    if (pathname === '/api/contaspagar/calendario') {
      const inicio = q.inicio || daysAgo(60);
      const fim    = q.fim    || today();
      return jRes(res, 200, { lancamentos: db.getContasPagar(inicio, fim), stats: db.getStatsCP() });
    }
    if (pathname === '/api/margem/analise') {
      const produtos_rows = db.db.prepare("SELECT json FROM produtos WHERE loja=1").all();
      const todos_prods = [];
      for (const row of produtos_rows) {
        try { todos_prods.push(...JSON.parse(row.json)); } catch(e){}
      }
      const fiscalMapA = {};
      const fiscRowsA = db.db.prepare("SELECT plu, json FROM fiscal WHERE json IS NOT NULL").all();
      for (const fr of fiscRowsA) {
        if (!fiscalMapA[fr.plu]) { try { fiscalMapA[fr.plu] = JSON.parse(fr.json); } catch(e){} }
      }
      let fornMapA = {};
      try {
        const frows = db.db.prepare("SELECT json FROM fornecedor_produtos WHERE loja=1").all();
        for (const r of frows) {
          try { for (const item of JSON.parse(r.json)) { if (item.plu && item.fornecedor && !fornMapA[item.plu]) fornMapA[item.plu] = item.fornecedor; } } catch(e){}
        }
      } catch(e){}
      let nomeFornA = {};
      try {
        const fns = db.db.prepare("SELECT json FROM fornecedores WHERE loja=1").all();
        for (const fn of fns) { try { for (const f of JSON.parse(fn.json)) { if (f.id) nomeFornA[f.id] = f.nome || String(f.id); } } catch(e){} }
      } catch(e){}

      const resultados = [];
      for (const p of todos_prods) {
        if (!p.ativo || p.ativo === 'N') continue;
        const custo = parseFloat(p.custo || 0);
        const preco = parseFloat(p.valor_produto || 0);
        if (custo <= 0 || preco <= 0) continue;
        const fRaw = fiscalMapA[p.plu] || null;
        const f = fRaw ? (fRaw[0] || fRaw) : null;
        const ncmInfo = getNcmInfo(p.ncm);
        const ca = calcLucroReal(custo, preco, f, ncmInfo);
        const ml = ca.margem_liquida;
        let status = 'OK';
        if (preco < ca.custo_real)  status = 'ABAIXO_CUSTO_REAL';
        else if (preco < custo)     status = 'ABAIXO_CUSTO_HIPCOM';
        else if (ml !== null && ml < 0)  status = 'PREJUIZO';
        else if (ml !== null && ml < 15) status = 'MARGEM_CRITICA';
        else if (ml !== null && ml < 30) status = 'MARGEM_BAIXA';
        resultados.push({
          plu: p.plu, descricao: p.descricao, ncm: p.ncm || '',
          comprador: p.nome_comprador || '',
          custo_hipcom: +custo.toFixed(4), custo_real: +ca.custo_real.toFixed(4),
          preco: +preco.toFixed(4),
          margem_bruta: preco > 0 ? +((preco-custo)/preco*100).toFixed(2) : null,
          margem_liquida: ml !== null ? +ml.toFixed(2) : null,
          preco_min_30: ca.preco_min_30 ? +ca.preco_min_30.toFixed(2) : null,
          ajuste: ca.preco_min_30 ? +(ca.preco_min_30 - preco).toFixed(2) : null,
          tem_st: ca.tem_st, regime: ca.regime, origem: ca.origem,
          curva_abc: p.curva_abc || '', status,
        });
      }
      return jRes(res, 200, { resultados });
    }

    if (pathname === '/api/margem/divergencias') {
      const pRows = db.db.prepare("SELECT json FROM produtos WHERE loja=1").all();
      const prods = [];
      for (const r of pRows) { try { prods.push(...JSON.parse(r.json)); } catch(e){} }
      const fiscMapD = {};
      for (const fr of db.db.prepare("SELECT plu, json FROM fiscal WHERE json IS NOT NULL").all()) {
        if (!fiscMapD[fr.plu]) { try { fiscMapD[fr.plu] = JSON.parse(fr.json); } catch(e){} }
      }
      const divs = [];
      for (const p of prods) {
        if (!p.ativo || p.ativo === 'N') continue;
        const custo = parseFloat(p.custo || 0);
        const preco = parseFloat(p.valor_produto || 0);
        const ncmInfo = getNcmInfo(p.ncm);
        const fRaw = fiscMapD[p.plu];
        const f = fRaw ? (fRaw[0] || fRaw) : null;
        const base = { plu:p.plu, descricao:p.descricao, ncm:p.ncm||'', comprador:p.nome_comprador||'', custo, preco, curva:p.curva_abc||'' };

        if (!p.ncm || p.ncm === '00000000' || p.ncm === '') {
          divs.push({...base, tipo:'SEM_NCM', impacto:'ALTO', detalhe:'NCM não cadastrado — tributação desconhecida, risco de autuação'}); continue;
        }
        if (!f) continue; // sem fiscal não dá pra verificar divergência de CST

        const temSTHipcom = String(f.icmsCstSaida||'').trim()==='60';
        const stAtivaNcm  = ncmInfo && ncmInfo.icms_sp && ncmInfo.icms_sp.st_ativo;
        const pE=parseFloat(f.pisAlqEntrada||0), cE=parseFloat(f.cofinsAliqEntrada||0);
        const pS=parseFloat(f.pisAlqSaida||0),   cS=parseFloat(f.cofinsAlqSaida||0);
        const temPC = pE>0||cE>0||pS>0||cS>0;
        const regimeNcm = ncmInfo&&ncmInfo.pis_cofins ? ncmInfo.pis_cofins.regime : null;
        const alqIcmsH = parseFloat(f.icmsAlqEntrada||0);
        const alqIcmsN = ncmInfo&&ncmInfo.icms_sp ? ncmInfo.icms_sp.aliq : null;

        if (ncmInfo && temSTHipcom && !stAtivaNcm) {
          divs.push({...base, tipo:'ST_REMOVIDA_ERRADA', impacto:'ALTO',
            detalhe:'CST 60 (com ST) no Hipcom, mas ST foi removida para este NCM em SP. Crédito ICMS '+alqIcmsN+'% não aproveitado.',
            valor_impacto: alqIcmsN ? +(custo*(alqIcmsN/100)).toFixed(2) : null });
        } else if (ncmInfo && !temSTHipcom && stAtivaNcm) {
          divs.push({...base, tipo:'ST_ATIVA_SEM_CADASTRO', impacto:'ALTO',
            detalhe:'NCM indica ST ativa em SP mas produto não está cadastrado como CST 60. Risco de autuação fiscal.' });
        }
        if (ncmInfo && regimeNcm==='monofasico' && temPC) {
          divs.push({...base, tipo:'MONOFASICO_ERRADO', impacto:'MEDIO',
            detalhe:'NCM é monofásico (PIS/COFINS recolhido na indústria) mas Hipcom tem alíquotas de débito (PIS '+pS+'% + COFINS '+cS+'%). Possível débito indevido.',
            valor_impacto: preco>0 ? +(preco*((pS+cS)/100)).toFixed(2) : null });
        }
        if (ncmInfo && regimeNcm==='isento' && temPC) {
          divs.push({...base, tipo:'ISENTO_TRIBUTADO_ERRADO', impacto:'MEDIO',
            detalhe:'NCM indica isenção de PIS/COFINS (Cesta Básica/Lei 10.925) mas Hipcom tem alíquotas de débito.',
            valor_impacto: preco>0 ? +(preco*((pS+cS)/100)).toFixed(2) : null });
        }
        if (ncmInfo && alqIcmsN && !temSTHipcom && !stAtivaNcm && Math.abs(alqIcmsH - alqIcmsN) > 2) {
          divs.push({...base, tipo:'ICMS_DIVERGENTE', impacto:'MEDIO',
            detalhe:'Alíquota ICMS no Hipcom ('+alqIcmsH+'%) diverge do esperado para o NCM em SP ('+alqIcmsN+'%).' });
        }
      }
      return jRes(res, 200, { divergencias: divs });
    }

    if (pathname === '/api/contaspagar/importar' && req.method === 'POST') {
      const body = await readBody(req);
      const { lancamentos, lojas, periodo } = JSON.parse(body);
      if (!Array.isArray(lancamentos) || lancamentos.length === 0)
        return jRes(res, 400, { erro: 'Sem lançamentos' });
      const n = db.setContasPagar(lancamentos, lojas, periodo);
      return jRes(res, 200, { ok: true, importados: n });
    }

    // ── Sugestão de Transferência ─────────────────────────────────────────
    if (pathname === '/api/transferencia/debug') {
      const nf  = q.numero_nf;
      const plu = q.plu ? +q.plu : null;
      if (q.data) {
        const itens = db.getCompras(LOJA_CD, q.data) || [];
        let filtrado = itens;
        if (nf)  filtrado = filtrado.filter(c => String(c.numero_nf) === String(nf));
        if (plu) filtrado = filtrado.filter(c => c.plu === plu);
        return jRes(res, 200, { loja_cd: LOJA_CD, data: q.data, total_itens: itens.length, filtrados: filtrado.length, amostra: filtrado.slice(0, 5), campos: itens[0] ? Object.keys(itens[0]) : [] });
      }
      // Sem data: busca NF em todas as datas disponíveis
      const datas = dateRange(daysAgo(90), daysAgo(0));
      const encontrados = [];
      for (const dt of datas) {
        const itens = db.getCompras(LOJA_CD, dt) || [];
        let f = itens;
        if (nf)  f = f.filter(c => String(c.numero_nf) === String(nf));
        if (plu) f = f.filter(c => c.plu === plu);
        if (f.length) encontrados.push({ data: dt, qtd: f.length, amostra: f.slice(0, 2) });
        if (encontrados.length >= 5) break;
      }
      return jRes(res, 200, { loja_cd: LOJA_CD, buscou_nf: nf || null, resultado: encontrados });
    }

    if (pathname === '/api/transferencia/nfs') {
      // Lista NFs que chegaram no CD num período, agrupadas por NF
      const dataInicio = q.data_inicio || daysAgo(7);
      const dataFim    = q.data_fim    || today();
      const datas      = dateRange(dataInicio, dataFim);
      const nfsMap     = {}; // chave: numero_nf|serie|fornecedor
      for (const dt of datas) {
        const itens = db.getCompras(LOJA_CD, dt) || [];
        for (const c of itens) {
          const chave = `${c.numero_nf}|${c.serie_nf}|${c.codigo_fornecedor}`;
          if (!nfsMap[chave]) {
            nfsMap[chave] = {
              numero_nf: c.numero_nf, serie_nf: c.serie_nf,
              data_entrada: dt, data_emissao: c.data_emissao_nf,
              codigo_fornecedor: c.codigo_fornecedor, fornecedor: c.fornecedor,
              total_itens: 0, valor_total: 0, plus: [],
            };
          }
          nfsMap[chave].total_itens++;
          nfsMap[chave].valor_total += parseFloat(c.valor_total || 0);
          nfsMap[chave].plus.push(c.plu);
        }
      }
      const lista = Object.values(nfsMap).sort((a, b) => b.data_entrada.localeCompare(a.data_entrada));
      return jRes(res, 200, { nfs: lista });
    }

    if (pathname === '/api/transferencia/sugestao') {
      // Recebe numero_nf + serie_nf + codigo_fornecedor + data_entrada
      // Retorna sugestão de transferência do CD para cada loja de venda
      if (!q.numero_nf || !q.data_entrada) return jRes(res, 400, { erro: 'numero_nf e data_entrada obrigatórios' });
      const jid = jId();
      jobs.set(jid, { pct: 0, etapa: 'Iniciando...', done: false, erro: null, resultado: null });
      rodarAnaliseTransferencia(jid, {
        numero_nf:         q.numero_nf,
        serie_nf:          q.serie_nf || '',
        codigo_fornecedor: q.codigo_fornecedor || '',
        data_entrada:      q.data_entrada,
      }).catch(() => {});
      for (const [k, v] of jobs) if (v.done && k !== jid) jobs.delete(k);
      return jRes(res, 200, { jobId: jid });
    }

    if (pathname === '/api/transferencia/progresso') {
      const j = jobs.get(q.job);
      if (!j) return jRes(res, 404, { erro: 'Job não encontrado' });
      return jRes(res, 200, { pct: j.pct, etapa: j.etapa, done: j.done, erro: j.erro });
    }

    if (pathname === '/api/transferencia/resultado') {
      const j = jobs.get(q.job);
      if (!j) return jRes(res, 404, { erro: 'Job não encontrado' });
      if (!j.done) return jRes(res, 202, { msg: 'Processando', pct: j.pct });
      if (j.erro)  return jRes(res, 500, { erro: j.erro });
      return jRes(res, 200, { dados: j.resultado });
    }

    jRes(res, 404, { erro: 'Rota não encontrada: ' + pathname });
  } catch (err) {
    console.error('[ERRO]', err.message);
    jRes(res, 500, { erro: err.message });
  }
});

server.listen(PORT, () => {
  const stats = db.getStats();
  console.log(`\n✅  Villa Borghese — Sugestão de Compras  →  http://localhost:${PORT}`);
  console.log(`    Regime: Lucro Real · SP  |  Hipcom: ${HIPCOM_BASE}`);
  if (stats.diasHistorico > 0)
    console.log(`    Banco local: ${stats.diasHistorico} dias de histórico | Fiscal: ${stats.fiscal} produtos\n`);
  else
    console.log(`    Banco local: vazio — use "Sincronizar Banco" na tela\n`);
});
