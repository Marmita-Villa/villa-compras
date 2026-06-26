# CLAUDE.md

Este arquivo descreve o projeto ao Claude Code. Leia antes de qualquer alteração.

## Comandos

```bash
npm start          # node proxy.js na porta 3000
```

Produção: **Render** com auto-deploy via push em `main`. Sem testes automatizados nem lint.
Local: `http://localhost:3000` — login padrão `admin` / `villa2025`.

Deploys são feitos via PR + merge em `main` usando o GitHub CLI (`gh`). O Claude cria o PR e faz o merge automaticamente sem pedir confirmação.

---

## Visão geral

Sistema de **gestão de compras** para o Empório Villa Borghese (Lucro Real / SP).

Funcionalidades principais:
- Análise de sugestão de compra por fornecedor (margem, ruptura, giro)
- Dashboard diário com NFs recebidas, alertas de ruptura e reajustes de custo
- Aba de Transferência CD → lojas (distribuição automática das NFs recebidas)
- Histórico de transferências com romaneio imprimível
- Pedidos de compra com comparativo vs NF recebida
- Fluxo de Caixa com contas a pagar
- Sync automático diário às 06h + recuperação automática após restart

---

## Stack

- **Backend:** Node.js puro (sem framework) — `proxy.js`
- **Banco:** SQLite via `better-sqlite3` — `db.js`
- **Frontend:** HTML + JS inline em arquivo único — `index.html` (SPA sem bundler)
- **Charts:** Chart.js via CDN
- **ERP:** Hipcom REST API v7.3

---

## Arquivos principais

| Arquivo | Responsabilidade |
|---|---|
| `proxy.js` | Servidor HTTP, rotas API, jobs de sync/análise, lógica fiscal e transferência |
| `db.js` | Camada SQLite — cache Hipcom, tabelas de negócio, funções de leitura/escrita |
| `index.html` | SPA completa — toda a UI em um único arquivo |
| `login.html` | Página de login |
| `ncm_fiscal.json` | Tabela de tributação por NCM (ICMS SP, PIS/COFINS, ST, reforma tributária 2025-2033) |

---

## Arquitetura e fluxo de dados

```
Hipcom REST API ──► rodarSync() ──► SQLite (banco.db)
                                         │
                              rodarAnalise()          ──► resultado JSON ──► index.html
                              rodarAnaliseTransferencia()
```

**`rodarSync`**: busca dados da Hipcom e grava no SQLite (vendas, estoques, compras, produtos, fornecedores). Roda manualmente via botão "Sincronizar Banco" ou automaticamente às 06h.

**`rodarAnalise`**: lê **apenas do SQLite**, nunca chama a Hipcom. Deriva fornecedor→produto pelas compras reais do banco.

**`rodarAnaliseTransferencia`**: lê `prod_emb` local (SQLite) para dados de produto — não chama `loadProdutos` para evitar timeout. Só chama Hipcom se houver PLUs ausentes no cache.

---

## Regras de negócio críticas

- **Loja 2 = CD** (depósito central): entra no estoque total mas **não** entra no cálculo de vendas
- **Lojas 1 e 6** = lojas de venda: venda média calculada só por elas
- **Estoque total** = loja 1 + loja 2 + loja 6
- **Vínculo fornecedor→produto** vem das compras reais no banco (não do endpoint `fornecedoresprodutos`, que tem 96k registros históricos e é lento)
- **`LOJAS_ATIVAS`** env var filtra quais lojas aparecem (Render: `1,2,6`)
- **`LOJA_CD`** env var define a loja depósito (default: `2`)
- **`DIAS_HIST = 90`** dias de histórico usados na análise de transferência
- **`valor_total`** do endpoint `comprasprodutos` da Hipcom = preço de venda × qtd (NÃO é o custo). Usar `prod.custo` do cadastro para custo unitário.

---

## Constantes e env vars

| Variável | Default local | Render |
|---|---|---|
| `PORT` | 3000 | 10000 |
| `DATA_DIR` | `.` | `/data` |
| `HIPCOM_BASE` | `http://emporiovilla.dyndns.info:2222` | idem |
| `HIPCOM_USER` | `hipcomfull` | idem |
| `HIPCOM_PASS` | `xFyXDciUvM2&$Le$qgpl` | idem |
| `LOJAS_ATIVAS` | todas | `1,2,6` |
| `LOJA_CD` | `2` | `2` |

Banco local em `banco.db`; em produção em `/data/banco.db`.

---

## Cache SQLite (TTLs em `db.js`)

| Dado | TTL |
|---|---|
| Lojas, fornecedores | 24h |
| Produtos, FP | 24h |
| Fiscal (por PLU) | 7 dias |
| Vendas/estoque do dia atual | 5 min |
| Vendas/estoque datas passadas | Infinito* |

*O sync força re-fetch dos **últimos 3 dias** de compras e estoques mesmo com TTL=Infinity, para capturar NFs lançadas com atraso e snapshots desatualizados.

---

## Sincronização

### Sync manual
Botão "Sincronizar Banco" no frontend → `GET /api/sync/iniciar?loja=X&dias=N` → job background → polling em `/api/sync/progresso?job=<id>`.

### Sync automático (06h)
`agendarSyncDiario()` é chamado dentro de `server.listen()`. Usa `setTimeout` para agendar 06h do dia seguinte. Se o servidor reiniciar após 06h sem ter sincronizado hoje (verifica `config.ultimo_sync` no SQLite), executa o sync imediatamente.

### O que o sync faz por loja
1. Produtos + fornecedores + FP (Hipcom, TTL 24h)
2. `prod_emb` — mapa de embalagem de todos os produtos (sem filtro de rentabilidade). Detecta reajustes de custo comparando com valor anterior.
3. Vendas: datas faltando no banco
4. Compras: datas faltando + **últimos 3 dias sempre re-buscados**
5. Estoques: início do histórico + **últimos 3 dias sempre re-buscados**
6. Grava `config.ultimo_sync = today()` ao concluir

---

## Estoque

- Hipcom não disponibiliza estoque do dia corrente até o fechamento → análise usa `daysAgo(1)` como data fim
- `lojaRef` (primeira loja de venda) usa `prod.qtd_estoque_atual` (tempo real do cadastro de produtos) em vez do snapshot
- `getEstoqueExato` (sem fallback) usado no sync; `getEstoque` (com fallback para snapshot mais recente não-vazio) usado na análise

---

## Aba Transferência CD

Fluxo:
1. Comprador seleciona período → `GET /api/transferencia/nfs?data_inicio&data_fim` → lista NFs do CD agrupadas por `numero_nf|serie_nf|codigo_fornecedor`
2. Clica numa NF → `GET /api/transferencia/sugestao` → job `rodarAnaliseTransferencia`
3. Sistema lê itens da NF no banco + `prod_emb` (local) + vendas/estoques históricos → calcula distribuição proporcional
4. Comprador ajusta e confirma → `POST /api/transferencia/confirmar` → salva na tabela `transferencias`
5. Romaneio imprimível via `GET /api/transferencia/ver/:id`

### Cálculo de distribuição

```
totalCD    = estoque_cd_snapshot + qtd_recebida_NF
disponivel = floor(totalCD / qtd_embalagem) * qtd_embalagem

peso_loja  = venda_loja / total_vendas_todas_lojas  (histórico 90 dias)
qtd_loja   = floor(disponivel * peso_loja / qtd_embalagem) * qtd_embalagem

// Garantia para loja com estoque zero: recebe 1 embalagem da sobra real
sobra_real = disponivel - sum(qtd_lojas)
se loja.estoque == 0 e loja.qtd == 0 e sobra_real >= qtd_embalagem:
    loja.qtd = qtd_embalagem

saldo_cd = totalCD - sum(qtd_transferidas)
```

Nota: `estoque_cd_snapshot` pode ser 0 se o sync rodou antes da NF chegar (manhã cedo). Usar o botão **"Atualizar NFs do CD"** (`POST /api/transferencia/atualizar-compras`) para re-buscar compras do CD na Hipcom sem fazer sync completo.

---

## Aba Pedidos

- Criado a partir da análise de compras
- Comprador edita quantidades e custo negociado
- Recalcula custo real e margem: `custo_real_novo = custo_negociado × custo_real_atual / custo_hipcom`
- Salvo na tabela `pedidos` (SQLite)
- Comparativo Pedido vs NF: `GET /api/pedidos/comparar?id=X` — cruza itens do pedido com compras do banco pelo fornecedor no período

---

## Alertas (Dashboard)

- **Ruptura iminente**: `GET /api/alertas/ruptura` — produtos com `dias_sem_estoque > 30%` do período analisado
- **Reajustes de custo**: `GET /api/alertas/reajustes?dias=7` — variações detectadas durante o sync (tabela `historico_custos`)

---

## Jobs (background)

`proxy.js` mantém um `Map` in-memory. Jobs são **perdidos no restart**. Frontend faz polling em `/api/*/progresso?job=<id>`. Resultado fica em memória até próximo job do mesmo tipo ser criado.

---

## Autenticação

Sessões via cookie `sess` (HttpOnly, 8h). Tabela `sessoes` no SQLite.
- Rotas públicas: `GET /login`, `POST /auth/login`
- Todas as outras exigem sessão válida
- Admin padrão criado automaticamente se não existir nenhum usuário (`admin` / `villa2025`)

---

## Cálculo fiscal (`calcLucroReal` em `proxy.js`)

Aplica créditos de entrada (ICMS, PIS, COFINS) e débitos de saída para chegar ao custo real e margem líquida. Cruza com `ncm_fiscal.json` para detectar:
- ST removida → gera `cenario_anterior` com custo estimado pré-remoção (ICMS por dentro: `custo_NF / (1 - alq_entrada)`)
- PIS/COFINS monofásico ou isento
- Divergência de CST vs NCM
- Projeções da reforma tributária 2025-2033

Meta de margem: **30–35% líquida**.

---

## Conversão de embalagem nas vendas

A API Hipcom retorna `qtd_embalagem=1` para todos os produtos. Para converter "scans de caixa" em unidades:
1. Tabela `prod_emb` tem `custo_unit`. Se `custo_scan / custo_unit > 1` → fator = nº de unidades por caixa.
2. Se PLU não está em `prod_emb`, usa custo do scan diretamente (fator = 1).

Produtos com `entra_rentabilidade=N` não aparecem no endpoint padrão — são buscados sem filtro na análise quando necessário.

---

## Rotas API principais

| Rota | Método | Descrição |
|---|---|---|
| `/api/lojas` | GET | Lista lojas ativas |
| `/api/fornecedores` | GET | Lista fornecedores |
| `/api/banco/status` | GET | Stats do banco (qtd registros, última sync) |
| `/api/sync/iniciar` | GET | Inicia sync de uma loja |
| `/api/sync/progresso?job=` | GET | Polling do sync |
| `/api/analise/iniciar` | GET | Inicia análise de compras |
| `/api/analise/progresso?job=` | GET | Polling da análise |
| `/api/analise/resultado?job=` | GET | Resultado JSON da análise |
| `/api/alertas/ruptura` | GET | Produtos com ruptura iminente |
| `/api/alertas/reajustes?dias=` | GET | Reajustes de custo detectados no sync |
| `/api/pedidos/salvar` | POST | Salva pedido de compra |
| `/api/pedidos/listar` | GET | Lista pedidos |
| `/api/pedidos/ver?id=` | GET | Detalhe de um pedido |
| `/api/pedidos/deletar?id=` | DELETE | Remove pedido |
| `/api/pedidos/comparar?id=` | GET | Compara pedido vs NF recebida |
| `/api/transferencia/nfs` | GET | NFs recebidas no CD no período |
| `/api/transferencia/sugestao` | GET | Inicia análise de distribuição de NF |
| `/api/transferencia/progresso?job=` | GET | Polling da análise de transferência |
| `/api/transferencia/resultado?job=` | GET | Resultado da análise |
| `/api/transferencia/confirmar` | POST | Confirma e salva transferência |
| `/api/transferencia/historico` | GET | Histórico de transferências confirmadas |
| `/api/transferencia/ver/:id` | GET | Detalhe de transferência (romaneio) |
| `/api/transferencia/atualizar-compras` | POST | Re-busca compras do CD na Hipcom para datas selecionadas |
| `/api/transferencia/debug` | GET | Debug de compras do CD numa data |
| `/api/margem/analise` | GET | Análise de margem por produto |
| `/api/margem/divergencias` | GET | Produtos com divergência fiscal |
| `/api/contaspagar/importar` | POST | Importa contas a pagar |
| `/api/contaspagar/status` | GET | Resumo de contas a pagar |
| `/api/contaspagar/calendario` | GET | Calendário de vencimentos |
| `/api/prazos/get?fornecedor=` | GET | Prazo de pagamento do fornecedor |
| `/api/prazos/set` | POST | Define prazo de pagamento |

---

## Hipcom API

REST com Basic Auth (`Authorization: Basic ...`). Paginação: `?limite=200&offset=N`. `hGetAll()` pagina até batch < 200. Timeout por request: 45s com 3 tentativas.

Endpoints usados: `lojas`, `fornecedores`, `produtos`, `vendasprodutos`, `estoquesprodutos`, `comprasprodutos`, `tributacaoprodutos`, `fornecedoresprodutos`.

- Produtos `fracionado: N` (unitários): EAN-13 real em `codigo_barra`
- Produtos `fracionado: S` (pesados/granel): PLU em `codigo_barra`

---

## Tabelas SQLite

| Tabela | Conteúdo |
|---|---|
| `lojas` | Cache de lojas (TTL 24h) |
| `fornecedores` | Cache de fornecedores (TTL 24h) |
| `produtos` | Cache de produtos por loja (TTL 24h) |
| `fornecedor_produtos` | Cache FP por loja (TTL 24h) |
| `vendas` | Vendas por loja/data (TTL infinito datas passadas) |
| `estoques` | Snapshots de estoque por loja/data |
| `compras` | Compras por loja/data (NFs) |
| `prod_emb` | Mapa de embalagem e custo unitário de todos os produtos |
| `fiscal` | Dados fiscais por PLU (TTL 7 dias) |
| `pedidos` | Pedidos de compra criados pelo comprador |
| `historico_custos` | Reajustes de custo detectados no sync |
| `transferencias` | Transferências CD→lojas confirmadas |
| `usuarios` | Usuários do sistema |
| `sessoes` | Sessões ativas (cookie `sess`) |
| `contaspagar` | Contas a pagar importadas |
| `fornecedor_prazos` | Prazo e forma de pagamento por fornecedor |
| `config` | Configurações gerais (chave/valor), ex: `ultimo_sync` |

---

## Deploy (Render)

- Disco persistente em `/data` → banco em `/data/banco.db`
- `PORT=10000` obrigatório
- Env vars: `PORT`, `DATA_DIR`, `HIPCOM_BASE`, `HIPCOM_USER`, `HIPCOM_PASS`, `LOJAS_ATIVAS`, `LOJA_CD`
- Auto-deploy ao push em `main`
- Render pode reiniciar o servidor a qualquer momento — o sync de recuperação (`config.ultimo_sync`) garante que o sync diário não seja perdido
