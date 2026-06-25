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
  CREATE TABLE IF NOT EXISTS prod_emb (
    plu            TEXT NOT NULL PRIMARY KEY,
    qtd_embalagem  REAL NOT NULL DEFAULT 1,
    custo_unit     REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS fiscal (
    loja       INTEGER NOT NULL,
    plu        TEXT    NOT NULL,
    json       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (loja, plu)
  );
`);

// Migrations — adiciona colunas que podem não existir em bancos antigos
try { db.prepare('ALTER TABLE prod_emb ADD COLUMN custo_unit REAL NOT NULL DEFAULT 0').run(); } catch (_) {}
try { db.prepare("ALTER TABLE prod_emb ADD COLUMN descricao TEXT NOT NULL DEFAULT ''").run(); } catch (_) {}
try { db.prepare("ALTER TABLE prod_emb ADD COLUMN ncm TEXT NOT NULL DEFAULT ''").run(); } catch (_) {}
try { db.prepare("ALTER TABLE prod_emb ADD COLUMN departamento TEXT NOT NULL DEFAULT ''").run(); } catch (_) {}
try { db.prepare("ALTER TABLE prod_emb ADD COLUMN valor_produto REAL NOT NULL DEFAULT 0").run(); } catch (_) {}
try { db.prepare("ALTER TABLE prod_emb ADD COLUMN entra_rentabilidade TEXT NOT NULL DEFAULT 'S'").run(); } catch (_) {}

// TTLs em segundos
const TTL = {
  lojas:        86400,     // 24h — lojas raramente mudam
  fornecedores: 86400,     // 24h — fornecedores raramente mudam
  produtos:     86400,     // 24h — produtos raramente mudam
  fp:           86400,     // 24h — vinculo fornecedor-produto raramente muda
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
const stmtGetEst        = db.prepare('SELECT json, synced_at FROM estoques WHERE loja=? AND data=?');
const stmtGetEstRecente = db.prepare("SELECT json, synced_at, data FROM estoques WHERE loja=? AND data<=? AND json!='[]' ORDER BY data DESC LIMIT 1");
const stmtSetEst        = db.prepare('INSERT OR REPLACE INTO estoques(loja,data,json,synced_at) VALUES(?,?,?,?)');

// Usado pelo loadEstoque para decidir se precisa buscar do Hipcom (data exata apenas)
function getEstoqueExato(loja, data) {
  const r = stmtGetEst.get(loja, data);
  if (!r) return null;
  const ttl = data === hoje() ? TTL.hoje : TTL.passado;
  if (isStale(r.synced_at, ttl)) return null;
  const arr = JSON.parse(r.json);
  return arr.length > 0 ? arr : null; // null se vazio (força nova busca)
}
// Usado pela análise — usa fallback para data mais recente com dados
function getEstoque(loja, data) {
  const exato = getEstoqueExato(loja, data);
  if (exato) return exato;
  // Fallback: snapshot mais recente não-vazio (sem limite de dias)
  const r2 = stmtGetEstRecente.get(loja, data);
  if (!r2) return null;
  return JSON.parse(r2.json);
}
function setEstoque(loja, data, items) {
  if (!items || items.length === 0) return; // nunca salva vazio
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
const stmtGetFis    = db.prepare('SELECT json, updated_at FROM fiscal WHERE loja=? AND plu=?');
const stmtGetFisAny = db.prepare('SELECT json, updated_at FROM fiscal WHERE plu=? AND json IS NOT NULL ORDER BY updated_at DESC LIMIT 1');
const stmtSetFis    = db.prepare('INSERT OR REPLACE INTO fiscal(loja,plu,json,updated_at) VALUES(?,?,?,?)');

const stmtSetEmb = db.prepare(`INSERT OR REPLACE INTO prod_emb
  (plu, qtd_embalagem, custo_unit, descricao, ncm, departamento, valor_produto, entra_rentabilidade)
  VALUES(?,?,?,?,?,?,?,?)`);
function setEmbalagemMap(prods) {
  const ins = db.transaction(list => {
    list.forEach(p => stmtSetEmb.run(
      String(p.plu),
      parseFloat(p.qtd_embalagem || 1) || 1,
      parseFloat(p.custo || 0),
      p.descricao || '',
      String(p.ncm || ''),
      p.departamento || '',
      parseFloat(p.valor_produto || 0),
      p.entra_rentabilidade || 'S',
    ));
  });
  ins(prods);
}

function getProdEmb(plu) {
  return db.prepare('SELECT * FROM prod_emb WHERE plu=?').get(String(plu));
}

function getProdEmbMap() {
  return db.prepare('SELECT * FROM prod_emb').all()
    .reduce((m, r) => { m[r.plu] = r; return m; }, {});
}
function getCustoMap() {
  return db.prepare('SELECT plu, custo_unit FROM prod_emb WHERE custo_unit > 0').all()
    .reduce((m, r) => { m[r.plu] = r.custo_unit; return m; }, {});
}

function getFiscal(loja, plu) {
  // tenta a loja exata primeiro
  const r = stmtGetFis.get(loja, String(plu));
  if (r && !isStale(r.updated_at, TTL.fiscal)) return JSON.parse(r.json);
  // fallback: qualquer loja que tenha dados não-nulos (fiscal é por produto, não por loja)
  if (!r) {
    const any = stmtGetFisAny.get(String(plu));
    if (any && !isStale(any.updated_at, TTL.fiscal)) return JSON.parse(any.json);
  }
  if (r) return undefined; // existia mas expirou — precisa rebuscar
  return undefined;        // não existe em nenhuma loja
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

  // Compras por loja: data mínima, máxima e total de datas
  const comprasStats = db.prepare(
    'SELECT loja, MIN(data) as min_d, MAX(data) as max_d, COUNT(*) as dias FROM compras GROUP BY loja ORDER BY loja'
  ).all();

  let diasHistorico = 0;
  if (minVenda && maxVenda) {
    diasHistorico = Math.round((new Date(maxVenda) - new Date(minVenda)) / 86400000) + 1;
  }
  return { diasVendas, diasHistorico, fiscal, produtos, minVenda, maxVenda, comprasStats };
}

// ── Usuários e Sessões ────────────────────────────────────────────────────
const crypto = require('crypto');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nome       TEXT    NOT NULL,
    usuario    TEXT    NOT NULL UNIQUE,
    senha_hash TEXT    NOT NULL,
    salt       TEXT    NOT NULL,
    admin      INTEGER NOT NULL DEFAULT 0,
    criado_em  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS sessoes (
    token      TEXT    NOT NULL PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    expira_em  INTEGER NOT NULL
  );
`);

function hashSenha(senha, salt) {
  return crypto.scryptSync(senha, salt, 64).toString('hex');
}
function criarUsuario(nome, usuario, senha, admin = 0) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashSenha(senha, salt);
  return db.prepare('INSERT INTO usuarios(nome,usuario,senha_hash,salt,admin) VALUES(?,?,?,?,?)').run(nome, usuario, hash, salt, admin ? 1 : 0);
}
function autenticarUsuario(usuario, senha) {
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario=?').get(usuario);
  if (!u) return null;
  if (hashSenha(senha, u.salt) !== u.senha_hash) return null;
  return u;
}
function criarSessao(usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = Math.floor(Date.now() / 1000) + 8 * 3600; // 8h
  db.prepare('INSERT INTO sessoes(token,usuario_id,expira_em) VALUES(?,?,?)').run(token, usuarioId, expira);
  return token;
}
function getSessao(token) {
  if (!token) return null;
  const s = db.prepare('SELECT s.*, u.nome, u.usuario, u.admin FROM sessoes s JOIN usuarios u ON u.id=s.usuario_id WHERE s.token=?').get(token);
  if (!s || s.expira_em < Math.floor(Date.now() / 1000)) { if (s) db.prepare('DELETE FROM sessoes WHERE token=?').run(token); return null; }
  return s;
}
function deleteSessao(token) {
  db.prepare('DELETE FROM sessoes WHERE token=?').run(token);
}
function listarUsuarios() {
  return db.prepare('SELECT id,nome,usuario,admin,criado_em FROM usuarios ORDER BY id').all();
}
function deletarUsuario(id) {
  db.prepare('DELETE FROM sessoes WHERE usuario_id=?').run(id);
  db.prepare('DELETE FROM usuarios WHERE id=?').run(id);
}
function alterarSenha(id, novaSenha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashSenha(novaSenha, salt);
  db.prepare('UPDATE usuarios SET senha_hash=?, salt=? WHERE id=?').run(hash, salt, id);
}

// Criar admin padrão se não existir nenhum usuário
if (!db.prepare('SELECT id FROM usuarios LIMIT 1').get()) {
  criarUsuario('Administrador', 'admin', 'villa2025', 1);
  console.log('[auth] Usuário padrão criado: admin / villa2025');
}

// ── Pedidos de Compra ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS pedidos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    fornecedor TEXT    NOT NULL,
    forn_nome  TEXT,
    data       TEXT    NOT NULL,
    obs        TEXT,
    itens      TEXT    NOT NULL,
    total      REAL    NOT NULL DEFAULT 0,
    num_itens  INTEGER NOT NULL DEFAULT 0,
    usuario    TEXT,
    criado_em  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

function salvarPedido(p, usuario) {
  const r = db.prepare(
    'INSERT INTO pedidos(fornecedor,forn_nome,data,obs,itens,total,num_itens,usuario) VALUES(?,?,?,?,?,?,?,?)'
  ).run(p.fornecedor, p.forn_nome||'', p.data, p.obs||'', JSON.stringify(p.itens), p.total||0, (p.itens||[]).length, usuario||'');
  return r.lastInsertRowid;
}
function listarPedidos() {
  return db.prepare('SELECT id,fornecedor,forn_nome,data,obs,total,num_itens,criado_em FROM pedidos ORDER BY criado_em DESC').all();
}
function verPedido(id) {
  return db.prepare('SELECT * FROM pedidos WHERE id=?').get(id);
}
function deletarPedido(id) {
  db.prepare('DELETE FROM pedidos WHERE id=?').run(id);
}

// ── Histórico de Custos ───────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS historico_custos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plu         TEXT    NOT NULL,
    descricao   TEXT    NOT NULL DEFAULT '',
    departamento TEXT   NOT NULL DEFAULT '',
    custo_ant   REAL    NOT NULL,
    custo_novo  REAL    NOT NULL,
    variacao_pct REAL   NOT NULL,
    detectado_em TEXT   NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hc_plu ON historico_custos(plu);
  CREATE INDEX IF NOT EXISTS idx_hc_data ON historico_custos(detectado_em);
`);

function registrarReajuste(plu, descricao, departamento, custoAnt, custoNovo, data) {
  if (Math.abs(custoNovo - custoAnt) < 0.001) return; // ignorar diferenças mínimas
  const variacao = ((custoNovo - custoAnt) / custoAnt) * 100;
  db.prepare('INSERT INTO historico_custos(plu,descricao,departamento,custo_ant,custo_novo,variacao_pct,detectado_em) VALUES(?,?,?,?,?,?,?)')
    .run(String(plu), descricao||'', departamento||'', custoAnt, custoNovo, +variacao.toFixed(2), data);
}
function listarReajustes(dias) {
  const dataMin = new Date(); dataMin.setDate(dataMin.getDate() - (dias||30));
  const dt = dataMin.toISOString().slice(0,10);
  return db.prepare('SELECT * FROM historico_custos WHERE detectado_em >= ? ORDER BY detectado_em DESC LIMIT 200').all(dt);
}

// ── Transferências CD → Lojas ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS transferencias (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    numero_nf       TEXT    NOT NULL,
    serie_nf        TEXT    NOT NULL,
    codigo_fornecedor INTEGER NOT NULL,
    fornecedor      TEXT    NOT NULL,
    data_entrada    TEXT    NOT NULL,
    obs             TEXT,
    total_itens     INTEGER NOT NULL DEFAULT 0,
    valor_estimado  REAL    NOT NULL DEFAULT 0,
    itens           TEXT    NOT NULL,
    usuario         TEXT,
    criado_em       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

function salvarTransferencia(t, usuario) {
  const r = db.prepare(
    'INSERT INTO transferencias(numero_nf,serie_nf,codigo_fornecedor,fornecedor,data_entrada,obs,total_itens,valor_estimado,itens,usuario) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(t.numero_nf, t.serie_nf||'', t.codigo_fornecedor||0, t.fornecedor||'', t.data_entrada||'', t.obs||'',
        t.total_itens||0, t.valor_estimado||0, JSON.stringify(t.itens||[]), usuario||'');
  return r.lastInsertRowid;
}
function listarTransferencias() {
  return db.prepare('SELECT id,numero_nf,serie_nf,fornecedor,data_entrada,total_itens,valor_estimado,usuario,criado_em FROM transferencias ORDER BY criado_em DESC').all();
}
function verTransferencia(id) {
  return db.prepare('SELECT * FROM transferencias WHERE id=?').get(id);
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
  db,
  getLojas, setLojas,
  getFornecedores, setFornecedores,
  getProdutos, setProdutos,
  getFP, setFP,
  getVendas, setVendas, datasFaltandoVendas,
  getEstoque, getEstoqueExato, setEstoque,
  getCompras, setCompras, datasFaltandoCompras,
  getFiscal, setFiscal, plusSemFiscal,
  setEmbalagemMap, getCustoMap, getProdEmb, getProdEmbMap,
  getStats,
  setContasPagar, getContasPagar, getStatsCP,
  salvarPedido, listarPedidos, verPedido, deletarPedido,
  registrarReajuste, listarReajustes,
  salvarTransferencia, listarTransferencias, verTransferencia,
  getPrazo, setPrazo,
  criarUsuario, autenticarUsuario, criarSessao, getSessao, deleteSessao,
  listarUsuarios, deletarUsuario, alterarSenha,
};
