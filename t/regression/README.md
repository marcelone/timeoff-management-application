# Regressió baseline (Fase 1)

Suite de regressió HTTP **sense dependències noves** (només `node:http`, `node:fs`, `node:path`, `node:os`). Arrenca l'app real in-process sobre una **BD SQLite aïllada en un directori temporal** i bloqueja el comportament actual perquè els canvis de Fase 2/3 es puguin diffar contra una base verda.

## Execució

Requereix `node_modules` instal·lats (base recuperada: Node 18 + `sqlite3@5.1.7` + Sequelize 3).

```bash
# Directament (cwd = arrel del repo, o REPO_ROOT apuntant-hi)
NODE_ENV=development node t/regression/smoke.js

# En contenidor aïllat (recomanat, no toca el Node global):
docker run --rm -u "$(id -u):$(id -g)" \
  -e HOME=/work -e NODE_ENV=development -e REPO_ROOT=/work \
  -v "$PWD:/work" -w /work node:18 node t/regression/smoke.js
```

- `REPO_ROOT` (opcional): arrel del repo si s'executa des d'un altre cwd.
- La BD es crea en un `mkdtemp` i s'elimina en acabar. **Mai toca una BD real.**
- Exit `0` = tot verd; `1` = alguna fallada.

## Assertions actuals (14)

1. `GET /login` → 200 i marca "Time Off Management".
2. `POST /register` (empresa+admin) → 302 `/`.
3. `GET /` autenticat → 302 `/calendar/` → 200 "Calendar".
4. `POST /login` correcte → 302 `/` i sessió arriba a Calendar.
5. `POST /login` incorrecte → 302 `/login`.
6. Guest `/calendar/` → 303 (bloquejat).
7. Guest `/settings/` → 303.
8. Guest `/users/` → 303.
9. `GET /api/v1/notifications/` autenticat → 200 JSON `data[]`.
10. Feed token desconegut → **200 "N/A"** *(quirk baseline; Fase 2 → 404)*.
11. Integration API sense bearer → 401.
12. Hash de contrasenya = **MD5 legacy** *(baseline; Fase 2 → bcrypt/argon2)*.

> Les assertions 10 i 12 bloquegen **comportament actual conegut com a deficient**. Quan Fase 2 les corregeixi, s'actualitzaran assertant el comportament nou (404, bcrypt) i es documentarà el canvi.

## Resultat de referència (2026-11-17)

Base recuperada (Node 18.20.8, sqlite3 5.1.7, sequelize 3.35.1, node-sass 8): **14/14 PASS**.

## Notes

- Els tests Selenium originals (`t/integration/`) estan **morts** (API `selenium-webdriver/testing` eliminada a v4; flash "Welcome back" comentat al codi; phantomjs per defecte). No s'executen. La regressió HTTP substitueix la capa de baseline; Fase 3 ampliarà fluxos amb supertest.
- El CLI `npm run db-update` (sequelize-cli 2.5.1) està trencat a Node ≥12 (`graceful-fs`/`natives` → `primordials`). L'app usa `sync()`; la suite no depèn del CLI.
