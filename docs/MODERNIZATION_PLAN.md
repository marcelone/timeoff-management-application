# Pla de modernització (seqüència proposada)

**Objectiu:** TimeOff.Management reproduïble, segur, mantenible i desplegable a **Coolify** el 2026, sobre **Node.js 24 LTS** (avaluar 26 quan les deps ho permetin), **conservant funcionalitats i UX**. Sense React/TypeScript/frameworks nous sense justificació tècnica.

**Principis d'execució:**
- Cada pas és un **commit propi** a `feature/modernization-node24`; `master` intacte.
- **Porta de regressió:** `t/regression/smoke.js` (i suites ampliades) ha de quedar en verd abans i després de cada pas.
- **Cap push / desplegament / canvi d'infra / migració sobre BD real sense autorització explícita.**
- BD: totes les proves de migració sobre **còpies seeded**, mai dades reals.
- Dependències: es modifiquen **només després d'autorització** d'aquest pla.

---

## Fase 2 — Modernització (ordre proposat)

### Pas 0 — Seguretat de CI/CD (abans de qualsevol push) · P0
- Passar `deploy-infrastructure.yaml` i `deploy-dev-timeoff.yaml` a **`workflow_dispatch` manual** (eliminar `on: push: branches:["**"]`) o moure'ls a `legacy/` desactivat.
- Eliminar `terraform apply -auto-approve` automàtic; requerir revisió manual.
- Corregir typo de path filter `helm-tiemoff` → `helm-timeoff` (o eliminar el workflow GKE).
- **No es fa push fins autorització.** Aquest pas es prepara en local.
- *Verificació:* `actionlint`/revisió; cap trigger `push` actiu.

### Pas 1 — Cadena de build sana (Node 18 interim)
- `node-sass@8` → **`sass` (Dart Sass)**; script `compile-sass` → `sass scss/main.scss public/css/style.css`. Compilar i comparar CSS (paritat visual).
- Eliminar `preinstall: npm-force-resolutions` i `resolutions`; usar **`overrides`** npm per forçar `graceful-fs@^4`.
- Arreglar CLI de migracions: `sequelize-cli@2.5.1` → **6** (o `umzug`) per evitar `natives`/`primordials`.
- Mantenir **Sequelize 3 com a runtime interim** (encara no migrar models).
- *Verificació:* `npm install` net a Node 18; `sass` compila; `smoke.js` 14/14; CLI arrenca (encara que migracions es reescriuran al Pas 4).

### Pas 2 — SQLite modern
- `sqlite3@4.0.1` → **`5.1.7`** (ja provat en sandbox). Activar `PRAGMA foreign_keys=ON`, mode WAL.
- Avaluar `better-sqlite3` (no suportat per dialecte Sequelize 3/6 estàndard → descartat salvo justificació).
- *Verificació:* smoke 14/14; taules i integritat referencial.

### Pas 3 — Enduriment de seguretat (sense majors de deps)
- **Secrets a env:** `.env.example`; `crypto_secret`, session secret, SMTP, LDAP bind creds via `process.env`; `nconf.env()` prioritzat. Treure secrets de `config/app.json`.
- **Sessions:** secret des d'env; `cookie { httpOnly:true, secure:prod, sameSite:'lax' }`; `trust proxy` configurable; store Sequelize/Redis.
- **CSRF:** protecció a tots els POST de formulari (csurf o double-submit token). Logout per POST.
- **Passwords:** introduir **bcrypt/argon2** amb **rehash transparent en login** (verificació MD5 legacy com a fallback durant transició; columna `password_algo`). Migració de hashes sense forçar reset.
- **Reset token:** aleatori (`crypto.randomBytes`) + **caducitat** + un sol ús (columna/migració). Substituir `new Buffer` → `Buffer.from`.
- **Helmet**, rate-limit a login/register/forgot, `morgan` segons env, error handler sense stack a prod.
- **Feed:** token invàlid → **404**; revisar entropy/enumerabilitat.
- **LDAP:** `rejectUnauthorized:true` per defecte; credencials xifrades o via env/secret store.
- **Integration API:** no exposar stacks; token amb entropy suficient; limitar a admin actiu.
- *Verificació:* smoke ampliat (CSRF, cookie flags, 404 feed, rate-limit); rehash MD5→bcrypt provat; cap secret al repo.

### Pas 4 — Sequelize 3 → 6 (progressiu, model a model)
- **4a.** Pujar `sequelize@6`, `sequelize-cli@6`, `connect-session-sequelize@7`. Convertir models:
  - `sequelize.import` → `sequelize.define` / `class extends Model`.
  - `instanceMethods`/`classMethods` → mètodes de classe/instància.
  - Operadors string (`$ne`…) → **`Op`** (44 usos, 7 fitxers).
  - `.find(` → `findOne` (15). Scopes `loadScope`/`scopeAssociate` → `addScope`.
  - Associacions `associate` revisades; `underscored`/timestamps segons esquema real.
  - **Un model per commit**, smoke + tests de model després de cadascun.
- **4b. Migracions:**
  - **Desacoblar dels models actuals** (snapshot històric de l'esquema).
  - Reescriure reconstruccions SQLite (Users/Companies/Departments) amb `queryInterface` de v6, **preservant dades**, `down()` real quan sigui possible.
  - Substituir `sync()` d'arrencada per **`migrate` controlat** (umzug/CLI) abans d'escoltar.
  - **Proves up/down sobre còpies seeded** + comptatge de files/checksums abans/després (Fase 3).
- *Verificació:* smoke 14/14 després de cada model; migracions idempotents i no destructives en còpia; esquema idèntic al baseline.

### Pas 5 — Neteja de dependències majors
- `express` 4 latest (avaluar 5 amb compat handlebars/passport); `express-handlebars` 7/8; `handlebars` latest; `body-parser` → integrat Express.
- `joi` 17; `formidable` 3; `nodemailer` 6 latest + **eliminar `nodemailer-smtp-transport`**; `validator`/`csv` latest.
- `node-uuid` → `uuid` 9/11; `optimist` → `commander`/`yargs` (bin); `request-promise` → `undici`/`got` (tests); `underscore` → lodash/natiu.
- `ical-generator` 0.2 → 7/8 (**reescriptura `feed.js`**, paritat iCal verificada).
- `ldapauth-fork`/`ldapjs` 1 → alternativa mantinguda (ldapjs 3).
- `bluebird` 2 → Promise natiu progressiu (146 usos) o bluebird 3 interim.
- `moment`/`moment-timezone`: mantenir curt termini per paritat; **pla `dayjs` separat** (no bloqueja Node 24).
- `redis`/`connect-redis` actualitzats si s'usa Redis.
- *Verificació:* `npm audit` sense critical/high; smoke + fluxos; iCal/feed paritat.

### Pas 6 — Node 24 LTS + Docker professional
- `engines.node >=24`; `.npmrc` engine-strict alineat.
- **Dockerfile** multi-stage `node:24-slim` (pin digest), usuari **no-root**, `npm ci --omit=dev`, `COPY` selectiu (excloure secrets), **HEALTHCHECK**, `CMD ["node","bin/wwww"]` (senyals), graceful shutdown.
- **docker-compose.yml**: app + volum persistent (SQLite) + opcional **PostgreSQL**/Redis.
- **`.env.example`**, `.dockerignore`, instruccions de desenvolupament.
- Endpoint `/healthz` (DB ping) per a Coolify.
- Avaluar **Node 26** quan deps compatibles.
- *Verificació:* build des de zero en entorn net; arrencada i smoke dins el contenidor Node 24; healthcheck OK.

### Pas 7 — Motor de BD per a producció
- Mantenir **SQLite** per a desplegaments petits (Coolify 1 contenidor + volum) i/o oferir **PostgreSQL** via dialecte Sequelize (config env).
- Migracions verificades en **tots dos** dialectes.
- *Verificació:* smoke + migracions en SQLite i PostgreSQL.

---

## Fase 3 — Qualitat i seguretat
- Ampliar regressió: **login, usuaris, sol·licituds, aprovacions, calendaris, permisos, notificacions, administració, feeds** (supertest com a devDep autoritzada; paritat UI opcional Playwright).
- Revisió: **control d'accés/IDOR** (userId/leaveId/request_id), sessions/fixation, **CSRF**, cookies, validació (joi 17), entropy de tokens, open redirect.
- **Integritat de migracions:** up/down sobre còpies seeded, comptatge/checksum, cap pèrdua.
- **Build net des de zero** verificat (contenidor fresc, `npm ci`, migrate, smoke).
- `npm audit` net; dependències mantingudes.

## Fase 4 — Resultat final (Coolify)
- App reproduïble: Dockerfile + compose + `.env.example` + README dev + healthcheck + volum persistent.
- Documentació d'operació i desplegament a **Coolify** (build pack Docker / compose).
- GKE/Helm/Terraform **arxivats o eliminats** (fora del camí de desplegament).
- UX i funcionalitats conservades; redisseny visual separat.

---

## Riscos i mitigacions
| Risc | Mitigació |
|---|---|
| Migracions Sequelize 3→6 trenquen dades | Snapshot històric, proves up/down en còpies seeded, checksums, un model per commit. |
| Rehash de contrasenyes bloqueja usuaris | Fallback MD5 en login + rehash transparent; sense reset forçat. |
| Canvi iCal/express trenca UX | Tests de paritat (feed iCal, vistes), smoke + UI opcional. |
| CI/CD desplega accidentalment | Pas 0 abans de qualsevol push; workflows manuals; protecció de branca. |
| Node 24 incompatible amb alguna dep | Interim Node 18/22; pujar deps abans de bump d'engines; avaluar 26 després. |
| Regressions ocultes | Porta de regressió verda a cada pas; baseline tag. |

## Rollback
- Tag `baseline` (estat original). Cada pas és revertible (`git revert`).
- BD: migracions provades en còpia; cap BD real tocada sense autorització.
- Contenidors de prova aïllats (loopback, volums temp), sense afectar serveis existents.
