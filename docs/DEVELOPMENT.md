# Desenvolupament i desplegament

## Requisits
- Node.js **24 LTS** (o Docker).
- SQLite (inclòs) o PostgreSQL opcional.

## Posada en marxa en local (Node 24)
```bash
cp .env.example .env          # genera SESSION_SECRET (openssl rand -hex 32)
npm install                   # aprova scripts natius si cal:
                              # npm install-scripts approve bcrypt sqlite3 @parcel/watcher
npm run db:migrate            # aplica migracions (crea l'esquema net)
npm start                     # escolta a PORT (3000)
```
- Estils: `npm run compile-sass` (Dart Sass) → `public/css/style.css`.
- Proveïdor de BD: `DB_DIALECT=sqlite` (default) o `postgres` (+ `DB_HOST/DB_NAME/DB_USER/DB_PASSWORD`).

## Proves
```bash
npm test                      # mocha + supertest, BD temporal aïllada (NODE_ENV=test)
```
Les proves **mai** toquen una BD externa: `NODE_ENV=test` força un SQLite temporal
i el helper ho asserts. Asserts reals a la BD (operacions i aïllament entre empreses).

## Docker (reproduïble, Coolify-ready)
```bash
# Construcció des de zero
docker build -t timeoff-hr:latest .

# Execució (SQLite en volum persistent)
docker run -d --name timeoff-hr -p 3000:3000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e TRUST_PROXY=true \
  -v timeoff-data:/app/data \
  timeoff-hr:latest

# Healthcheck
curl http://localhost:3000/healthz   # -> {"status":"ok"}
```

### Docker Compose
```bash
cp .env.example .env    # defineix SESSION_SECRET
docker compose up --build -d        # app + SQLite (volum app-data)
# PostgreSQL opcional:
docker compose --profile postgres up --build -d
```

## Desplegament a Coolify
- Build pack: **Dockerfile** (o Docker Compose).
- Port: 3000. Healthcheck: `/healthz`.
- Volum persistent a `/app/data` (SQLite) o servei PostgreSQL gestionat.
- Variables: `SESSION_SECRET` (obligatòria), `TRUST_PROXY=true`, `APPLICATION_DOMAIN`,
  `SMTP_*`, `ALLOW_CREATE_NEW_ACCOUNTS`, i `DB_*` si PostgreSQL.
- Els workflows GKE/Terraform originals estan **desactivats** (manual-only).

## Arquitectura
Veure `docs/ARCHITECTURE.md` (monòlit modular, aïllament per empresa, RBAC, mòduls).

## Notes de modernització
- Capa transitòria de compatibilitat (Promise/Sequelize/validator shims) documentada
  a `docs/MODERNIZATION_PLAN.md` per a la seva retirada progressiva.
- Sense dades productives: l'esquema es reconstrueix amb migracions netes.
