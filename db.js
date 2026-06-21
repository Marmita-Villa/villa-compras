/**
 * db.js — SQLite local (cache Hipcom)
 * Tabelas: lojas, fornecedores, produtos, fornecedor_produtos,
 *          vendas, estoques, fiscal
 */
const Database = require('better-sqlite3');
const path     = require('path');

const dataDir = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(dataDir, 'banco.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous  = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS lojas (
    json       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS fornecedores (
    json       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS produtos (
    loja       INTEGER NOT NULL PRIMARY KEY,
    json       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS fornecedor_produtos (
    loja       INTEGER NOT NULL PRIMARY KEY,
    json       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS vendas (
    loja       INTEGER NOT NULL,
    data       TEXT    NOT NULL,
    json       TEXT    NOT NULL,
    synced_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (loja, data)
  );
  CREATE TABLE IF NOT EXISTS estoques (
    loja       INTEGER NOT NULL,
    data       TEXT    NOT NULL,
    json       TEXT    NOT NULL,
    synced_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (loja, data)
  );
  CREATE TABLE IF NOT EXISTS compras (
    loja       INTEGER NOT NULL,
    data       TEXT    NOT NULL,
    json       TEXT    NOT NULL,
    synced_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (loja, data)
  );
  CREATE TABLE IF NOT EXISTS fiscal (
    loja       INTEGER NOT NULL,
    plu        TEXT    NOT NULL,
    json       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (loja, plu)
  );
`);

// TTLs em segundos
const TTL = {
  lojas:        86400,     // 24h — lojas raramente mudam
  fornecedores: 86400,     // 24h — fornecedores raramente mudam
  produtos:     3600,      // 1h
  fp:           3600,      // 1h
  fiscal:       86400 * 7, // 7 dias
  hoje:         300,       // 5 min (vendas/estoque do dia atual)
  passado:      Infinity,  // datas passadas não expiram
};

const now = () => Math.floor(Date.now() / 1000);
const hoje = () => new Date().toISOString().slice(0, 10);
const isStale = (ts, ttl) => ttl === Infinity ? false : (!ts || (now() - ts) > ttl);

// ── Lojas ──────────────────────────────────────────────────────────────────
function getLojas() {
  const r = db.prepare('SELECT json, updated_at FROM lojas LIMIT 1').get();
  if (!r || isStale(r.updated_at, TTL.lojas)) return null;
  return JSON.parse(r.json);
}
function setLojas(items) {
  db.prepare('DELETE FROM lojas').run();
  db.prepare('INSERT INTO lojas(json,updated_at) VALUES(?,?)').run(JSON.stringify(items), now());
}

// ── Fornecedores ───────────────────────────────────────────────────────────
function getFornecedores() {
  const r = db.prepare('SELECT json, updated_at FROM fornecedores LIMIT 1').get();
  if (!r || isStale(r.updated_at, TTL.fornecedores)) return null;
  return JSON.parse(r.json);
}
function setFornecedores(items) {
  db.prepare('DELETE FROM fornecedores').run();
  db.prepare('INSERT INTO fornecedores(json,updated_at) VALUES(?,?)').run(JSON.stringify(items), now());
}

// ── Produtos ───────────────────────────────────────────────────────────────
function getProdutos(loja) {
  const r = db.prepare('SELECT json, updated_at FROM produtos WHERE loja=?').get(loja);
  if (!r || isStale(r.updated_at, TTL.produtos)) return null;
  return JSON.parse(r.json);
}
function setProdutos(loja, items) {
  db.prepare('INSERT OR REPLACE INTO produtos(loja,json,updated_at) VALUES(?,?,?)').run(loja, JSON.stringify(items), now());
}

// ── Fornecedor-Produtos ────────────────────────────────────────────────────
function getFP(loja) {
  const r = db.prepare('SELECT json, updated_at FROM fornecedor_produtos WHERE loja=?').get(loja);
  if (!r || isStale(r.updated_at, TTL.fp)) return null;
  return JSON.parse(r.json);
}
function setFP(loja, items) {
  db.prepare('INSERT OR REPLACE INTO fornecedor_produtos(loja,json,updated_at) VALUES(?,?,?)').run(loja, JSON.stringify(items), now());
}

// ── Vendas ─────────────────────────────────────────────────────────────────
const stmtGetVenda   = db.prepare('SELECT json, synced_at FROM vendas WHERE loja=? AND data=?');
const stmtSetVenda   = db.prepare('INSERT OR REPLACE INTO vendas(loja,data,json,synced_at) VALUES(?,?,?,?)');
const stmtListVendas = db.prepare('SELECT data FROM vendas WHERE loja=? AND data BETWEEN ? AND ?');

function getVendas(loja, data) {
  const r = stmtGetVenda.get(loja, data);
  if (!r) return null;
  const ttl = data === hoje() ? TTL.hoje : TTL.passado;
  if (isStale(r.synced_at, ttl)) return null;
  return JSON.parse(r.json);
}
function setVendas(loja, data, items) {
  stmtSetVenda.run(loja, data, JSON.stringify(items), now());
}
function datasFaltandoVendas(loja, datas) {
  const h = hoje();
  const existentes = new Set(stmtListVendas.all(loja, datas[0], datas[datas.length - 1]).map(r => r.data));
  return datas.filter(d => {
    if (!existentes.has(d)) return true;
    if (d === h) {
      const r = stmtGetVenda.get(loja, d);
      return isStale(r && r.synced_at, TTL.hoje);
    }
    return false;
  });
}

// ── Estoques ───────────────────────────────────────────────────────────────
const stmtGetEst = db.prepare('SELECT json, synced_at FROM estoques WHERE loja=? AND data=?');
const stmtSetEst = db.prepare('INSERT OR REPLACE INTO estoques(loja,data,json,synced_at) VALUES(?,?,?,?)');

function getEstoque(loja, data) {
  const r = stmtGetEst.get(loja, data);
  if (!r) return null;
  const ttl = data === hoje() ? TTL.hoje : TTL.passado;
  if (isStale(r.synced_at, ttl)) return null;
  return JSON.parse(r.json);
}
function setEstoque(loja, data, items) {
  stmtSetEst.run(loja, data, JSON.stringify(items), now());
}

// ── Compras ────────────────────────────────────────────────────────────────
const stmtGetCmp    = db.prepare('SELECT json, synced_at FROM compras WHERE loja=? AND data=?');
const stmtSetCmp    = db.prepare('INSERT OR REPLACE INTO compras(loja,data,json,synced_at) VALUES(?,?,?,?)');
const stmtListCmps  = db.prepare('SELECT data FROM compras WHERE loja=? AND data BETWEEN ? AND ?');

function getCompras(loja, data) {
  const r = stmtGetCmp.get(loja, data);
  if (!r) return null;
  const ttl = data === hoje() ? TTL.hoje : TTL.passado;
  if (isStale(r.synced_at, ttl)) return null;
  return JSON.parse(r.json);
}
function setCompras(loja, data, items) {
  stmtSetCmp.run(loja, data, JSON.stringify(items), now());
}
function datasFaltandoCompras(loja, datas) {
  const existentes = new Set(stmtListCmps.all(loja, datas[0], datas[datas.length - 1]).map(r => r.data));
  return datas.filter(d => !existentes.has(d));
}

// ── Fiscal ─────────────────────────────────────────────────────────────────
const stmtGetFis = db.prepare('SELECT json, updated_at FROM fiscal WHERE loja=? AND plu=?');
const stmtSetFis = db.prepare('INSERT OR REPLACE INTO fiscal(loja,plu,json,updated_at) VALUES(?,?,?,?)');

function getFiscal(loja, plu) {
  const r = stmtGetFis.get(loja, String(plu));
  if (!r) return undefined;              // undefined = não existe no banco
  if (isStale(r.updated_at, TTL.fiscal)) return undefined; // expirou
  return JSON.parse(r.json);            // null = Hipcom não tem dados p/ este produto
}
function setFiscal(loja, plu, data) {
  stmtSetFis.run(loja, String(plu), JSON.stringify(data), now());
}
function plusSemFiscal(loja, plus) {
  return plus.filter(plu => getFiscal(loja, plu) === undefined);
}

// ── Contas a Pagar (importação manual do TXT Hipcom) ──────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS contaspagar (
    data     TEXT NOT NULL PRIMARY KEY,
    valor_l  REAL NOT NULL DEFAULT 0,
    valor_p  REAL NOT NULL DEFAULT 0,
    lojas    TEXT,
    periodo  TEXT,
    importado INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

const stmtSetCP = db.prepare('INSERT OR REPLACE INTO contaspagar(data,valor_l,valor_p,lojas,periodo,importado) VALUES(?,?,?,?,?,?)');
const stmtGetCP = db.prepare('SELECT data,valor_l,valor_p,lojas,periodo FROM contaspagar WHERE data BETWEEN ? AND ? ORDER BY data');
const stmtStatsCP = db.prepare('SELECT MIN(data) as min_d, MAX(data) as max_d, COUNT(*) as n, SUM(valor_l) as total_l, SUM(valor_p) as total_p, MAX(importado) as ultimo FROM contaspagar');

function setContasPagar(lancamentos, lojas, periodo) {
  const ts = now();
  const inserir = db.transaction(rows => {
    for (const r of rows)
      stmtSetCP.run(r.data, r.valor_lancamento || 0, r.valor_previsao || 0, lojas || '', periodo || '', ts);
  });
  inserir(lancamentos);
  return lancamentos.length;
}
function getContasPagar(inicio, fim) {
  return stmtGetCP.all(inicio, fim);
}
function getStatsCP() {
  return stmtStatsCP.get() || {};
}

// ── Estatísticas do banco ─────────────────────────────────────────────────
function getStats() {
  const minVenda = db.prepare('SELECT MIN(data) as d FROM vendas').get().d;
  const maxVenda = db.prepare('SELECT MAX(data) as d FROM vendas').get().d;
  const diasVendas = db.prepare('SELECT COUNT(DISTINCT data) as n FROM vendas').get().n;
  const fiscal   = db.prepare('SELECT COUNT(*) as n FROM fiscal').get().n;
  const produtos = db.prepare('SELECT loja FROM produtos').all().map(r => r.loja);

  let diasHistorico = 0;
  if (minVenda && maxVenda) {
    diasHistorico = Math.round((new Date(maxVenda) - new Date(minVenda)) / 86400000) + 1;
  }
  return { diasVendas, diasHistorico, fiscal, produtos, minVenda, maxVenda };
}

// ── Prazos por Fornecedor ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS fornecedor_prazos (
    fornecedor    INTEGER NOT NULL PRIMARY KEY,
    prazo_dias    INTEGER NOT NULL DEFAULT 28,
    num_parcelas  INTEGER NOT NULL DEFAULT 1,
    intervalo_dias INTEGER NOT NULL DEFAULT 7,
    forma_pagto   TEXT    NOT NULL DEFAULT 'boleto',
    updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

function getPrazo(fornecedor) {
  return db.prepare('SELECT * FROM fornecedor_prazos WHERE fornecedor=?').get(fornecedor)
      || { fornecedor, prazo_dias:28, num_parcelas:1, intervalo_dias:7, forma_pagto:'boleto' };
}
function setPrazo(fornecedor, p) {
  db.prepare('INSERT OR REPLACE INTO fornecedor_prazos(fornecedor,prazo_dias,num_parcelas,intervalo_dias,forma_pagto,updated_at) VALUES(?,?,?,?,?,?)').run(
    fornecedor, p.prazo_dias||28, p.num_parcelas||1, p.intervalo_dias||7, p.forma_pagto||'boleto', now());
}

module.exports = {
  getLojas, setLojas,
  getFornecedores, setFornecedores,
  getProdutos, setProdutos,
  getFP, setFP,
  getVendas, setVendas, datasFaltandoVendas,
  getEstoque, setEstoque,
  getCompras, setCompras, datasFaltandoCompras,
  getFiscal, setFiscal, plusSemFiscal,
  getStats,
  setContasPagar, getContasPagar, getStatsCP,
  getPrazo, setPrazo,
};
