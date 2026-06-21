# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comandos

```bash
npm start          # inicia o servidor (node proxy.js) na porta 3000
```

Em produção roda no **Render** (auto-deploy via GitHub `main`). Não há testes automatizados nem lint configurado.

Localmente: abrir `http://localhost:3000` após `npm start`. Login padrão: `admin` / `villa2025`.

## Arquitetura

Sistema de **Sugestão de Compras** para o Empório Villa Borghese (Lucro Real / SP). Stack: Node.js puro (sem framework), SQLite via `better-sqlite3`, frontend HTML+JS inline (sem bundler).

### Arquivos principais

| Arquivo | Responsabilidade |
|---|---|
| `proxy.js` | Servidor HTTP, todas as rotas API, jobs de sync e análise, lógica fiscal |
| `db.js` | Camada SQLite — cache Hipcom + tabelas de negócio |
| `index.html` | SPA completa — toda a UI em um arquivo (JS inline, sem framework) |
| `login.html` | Página de login |
| `ncm_fiscal.json` | Tabela de tributação por NCM (ICMS SP, PIS/COFINS, ST, reforma tributária 2025-2033) |

### Fluxo de dados

```
Hipcom REST API ──► rodarSync() ──► SQLite (banco.db)
                                         │
                                    rodarAnalise() ──► resultado JSON ──► index.html
```

**Sincronizar Banco** (`rodarSync`): chama a Hipcom e grava no SQLite — vendas, estoques, compras por loja/dia, produtos, fornecedores.

**Analisar** (`rodarAnalise`): lê **apenas do SQLite**, nunca chama a Hipcom. Usa as compras do banco para derivar quais PLUs pertencem a cada fornecedor.

### Regras de negócio críticas

- **Loja 2 = CD** (depósito central): entra no estoque total mas **não** entra no cálculo de vendas
- **Lojas 1 e 6** = lojas de venda: venda média calculada só por elas
- **Estoque total** = loja 1 + loja 2 + loja 6
- **Vínculo fornecedor→produto** vem das compras reais no banco (não do endpoint `fornecedoresprodutos` da Hipcom, que tem 96k registros históricos)
- **`LOJAS_ATIVAS`** env var filtra quais lojas aparecem (Render: `1,2,6`)
- **`LOJA_CD`** env var define a loja depósito (default: `2`)

### Jobs (async background)

`proxy.js` mantém um `Map` in-memory de jobs. Jobs são **perdidos no restart** do servidor. O frontend faz polling em `/api/analise/progresso?job=<id>` e `/api/sync/progresso?job=<id>`.

### Autenticação

Sessões via cookie `sess` (HttpOnly, 8h). Tabela `sessoes` no SQLite. Rotas públicas: `/login`, `POST /auth/login`. Todas as outras rotas exigem sessão válida. Admin padrão criado automaticamente se não existir nenhum usuário.

### Cache SQLite (TTLs em `db.js`)

| Dado | TTL |
|---|---|
| Lojas, fornecedores | 24h |
| Produtos, FP | 24h |
| Fiscal (por PLU) | 7 dias |
| Vendas/estoque do dia atual | 5 min |
| Vendas/estoque datas passadas | Infinito |

### Cálculo fiscal (`calcLucroReal` em `proxy.js`)

Recebe custo, preço e dados fiscais da Hipcom. Aplica créditos de entrada (ICMS, PIS, COFINS) e débitos de saída para chegar ao custo real e margem líquida. Cruza com `ncm_fiscal.json` para detectar:
- ST removida → gera `cenario_anterior` com custo estimado pré-remoção e calcula ST retida pelo fornecedor
- PIS/COFINS monofásico ou isento
- Divergência de CST vs NCM
- Projeções da reforma tributária por ano (2025-2033)

### Aba Pedidos

Permite ao comprador criar pedido de compra a partir da análise, editar quantidades e custo negociado. Sistema recalcula custo real e margem com o novo custo proporcionalmente (`custo_real_novo = custo_negoc × custo_real_atual / custo_hipcom`). Pedidos salvos em tabela `pedidos` no SQLite (persistente).

### Deploy (Render)

- Disco persistente em `/data` — banco em `/data/banco.db` (`DATA_DIR=/data`)
- `PORT=10000` (obrigatório no Render)
- Env vars necessárias: `PORT`, `DATA_DIR`, `HIPCOM_BASE`, `HIPCOM_USER`, `HIPCOM_PASS`, `LOJAS_ATIVAS`, `LOJA_CD`
- Auto-deploy ao push em `main`

### Hipcom API

REST com Basic Auth. Paginação via `?limite=200&offset=N`. `hGetAll()` pagina automaticamente até acabar. Endpoints usados: `lojas`, `fornecedores`, `produtos`, `vendasprodutos`, `estoquesprodutos`, `comprasprodutos`, `tributacaoprodutos`.

Produtos com `fracionado: N` (unitários) têm EAN-13 real no campo `codigo_barra`. Produtos `fracionado: S` (pesados/a granel) têm o PLU no `codigo_barra`.
