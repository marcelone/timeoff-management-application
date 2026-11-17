# Fase 1 — Auditoria i recuperació

**Projecte:** TimeOff.Management (`marcelone/timeoff-management-application`)
**Branca de treball:** `feature/modernization-node24` (base `master` @ `a2df602`, intacta)
**Data:** 2026-11-17
**Abast d'aquest document:** auditoria d'arquitectura, dependències, BD, autenticació, seguretat, tests, Docker/CI i recuperació d'execució en contenidor aïllat. **Cap dependència del projecte ha estat modificada.** Les proves de recuperació s'han fet en un sandbox `/tmp` separat.

---

## 0. Resum executiu

- L'aplicació és un **Node.js + Express 4 + Handlebars + Sequelize 3** (~10.800 LOC a `lib/`, 79 vistes `.hbs`, front-end jQuery/Bootstrap 3). Funcionalitat completa de gestió d'absències.
- **El `package.json` original NO s'instal·la netament en cap versió de Node** (demostrat): `sqlite3@4.0.1` només té binari precompilat per a Node 8/10 (ABI 57/64); `node-sass@8` exigeix Node ≥14 amb `engine-strict=true`. Són mútuament excloents.
- **Recuperació viable provada:** Node 18 + `sqlite3@5.1.7` (únic canvi mínim, en sandbox) + Sequelize 3.35.1 → l'app arrenca, registra empreses, autentica, serveix calendari i aplica control d'accés. **Suite de regressió 14/14 en verd** (`t/regression/smoke.js`).
- **86 vulnerabilitats npm** (14 crítiques, 49 altes) al lockfile actual.
- **Risc P0 de CI/CD:** els dos workflows es disparen amb `push` a **qualsevol branca** i un executa `terraform apply -auto-approve` real sobre GCP. **Cal neutralitzar-los abans de qualsevol push.**
- Seguretat crítica: contrasenyes **MD5** amb sal estàtica commitejada, token de reset **determinista sense caducitat**, **secret de sessió hardcoded**, **sense CSRF**, credencials LDAP en clar, feed públic amb token.

---

## 1. Arquitectura

| Capa | Fitxers | Notes |
|---|---|---|
| Entrypoint | `bin/wwww` (sic), `bin/wwww_cluster` | `sequelize.sync()` puis `app.listen(PORT‖3000)`. **No executa migracions** a l'arrencada. |
| App Express | `app.js` | Handlebars (`express-handlebars@3`), `body-parser`, `cookie-parser`, `morgan('dev')`, estàtics `public/`. Passport local + bearer. Rutes muntades per prefix. |
| Config | `lib/config.js` (`nconf`) | Llegeix `config/app.json` + `config/localisation.json` (621 KB). **Secrets commitejats**, sense capa env. |
| Models | `lib/model/db/*.js` (13 models, 2.407 LOC) | Sequelize 3: `sequelize.import`, `instanceMethods`/`classMethods`, scopes (`loadScope`/`scopeAssociate`). |
| Lògica de negoci | `lib/model/*.js` | leave, team_view, calendar_month, user_allowance, carry-over, importer/exporter, audit, Report. |
| Rutes | `lib/route/*.js` | login, dashboard, calendar, requests, users, settings, departments, bankHolidays, feed, integration_api, api, audit, reports. |
| Auth | `lib/passport/*` | LocalStrategy (MD5/LDAP), BearerStrategy (token empresa→primer admin). |
| Sessions | `lib/middleware/withSession.js` | `connect-session-sequelize@3` (taula `Sessions`) o Redis opcional (`connect-redis@6`, `redis@3`). |
| Email | `lib/email.js` | `nodemailer@6` + `nodemailer-smtp-transport@1` (obsolet), plantilles Handlebars, `send_emails=false` per defecte. |
| Vistes | `views/*.hbs` (79) | UX Bootstrap 3 + jQuery + bootstrap-datepicker. **Es conserva.** |

**Anti-patrons estructurals:**
- `bin/wwww` usa `sync()` com a font d'esquema → **doble font de veritat** amb `migrations/`. Risc de drift.
- `migrations/*.js` fan `require('../lib/model/db')` → carreguen els **models actuals**, no l'esquema històric. Trencarà en migrar a Sequelize 6.
- 146 usos de Bluebird (`promisifyAll`, `Promise.join/map`, `.tap/.spread`), `Promise` global ombrejat per `bluebird@2`.
- 44 operadors string Sequelize 3 (`$ne`, `$gt`, `$in`, `$or`…) en 7 fitxers; 15 `.find(` (alias v3 de `findOne`); 23 patrons `import/instanceMethods/classMethods`.
- 2 `new Buffer(` (deprecated) a `lib/model/db/user.js:337,434`.

---

## 2. Dependències (estat i deute)

`npm audit` (lockfile actual, Node 18): **total 86 → critical 14, high 49, moderate 14, low 9.**
Crítiques: `form-data`, `handlebars`, `html-to-text`, `json-schema`, `jsprim`, `lodash`, `minimist`, `nodemailer`, `optimist`, `proxy-addr`, `request`, `sequelize`, `tar`, `underscore`.

| Dependència | Versió | Estat / acció proposada |
|---|---|---|
| `sequelize` | ^3.19.2 (3.35.1) | **EOL**, deprecated explícit → Sequelize 6 (progressiu). |
| `sequelize-cli` | 2.5.1 | Arrossega `graceful-fs@1.x`/`natives` → **`primordials is not defined`** a Node ≥12. Trenca `db-update`. → CLI 6 / umzug. |
| `sqlite3` | ^4.0.1 | Precompilat només ABI 57/64. → **5.1.7** (NAPI, provat) o `better-sqlite3` (avaluar dialecte). |
| `node-sass` | ^8.0.0 | **Abandonat**, sense binari ABI ≥115. → **Dart Sass (`sass`)**. |
| `bluebird` | ^2.10.2 | Molt antic; 146 usos. → Promise natiu (progressiu) o bluebird 3 interim. |
| `express` | ^4.13.4 | → 4 latest / avaluar 5. `body-parser` separat ja integrat a Express ≥4.16. |
| `express-handlebars` | ^3.0.0 | Antic; warning prototype-access. → 7/8. |
| `handlebars` | ^4.7.7 | Vuln crítica al lockfile; pujar. |
| `joi` | ~12.0.0 | Deprecated (hapi). → 17. |
| `formidable` | ~1.0.17 | CVEs (DoS/file write). → 3. |
| `nodemailer` | ^6.8.0 | Vuln; pujar 6 latest. |
| `nodemailer-smtp-transport` | ^1.1.0 | **Obsolet** (nodemailer 6 ja porta SMTP). Eliminar. |
| `node-uuid` | ^1.4.7 | **Deprecated** → `uuid` (ja present ^3.3.2, pujar a 9/11). |
| `optimist` | ^0.5.2 | **Abandonat** → `commander`/`yargs` (scripts `bin/`). |
| `request-promise` (dev) | ^4.2.2 | **Deprecated** (`request` EOL) → `undici`/`got` (tests). |
| `ldapauth-fork` | ^4.0.2 | Usa `ldapjs@1.0.2` **decommissioned**. → ldapjs 3 / alternativa mantinguda. |
| `ical-generator` | ^0.2.7 | API ancient (0.x). → 7/8 (reescriptura `feed.js`). |
| `moment` / `moment-timezone` | ^2.11 / ^0.5.14 | Maintenance-mode. Curt termini: mantenir per paritat UX; pla `dayjs` separat. |
| `connect-session-sequelize` | 3.0.0 | Lligat a Sequelize 3 → 7 (Sequelize 6). |
| `connect-redis` / `redis` | ^6 / ^3.1.2 | redis 3 antic → redis 4/5 + connect-redis 7/8 (si s'usa Redis). |
| `underscore` | ^1.8.3 | Vuln crítica; → lodash o natiu. |
| `csv` | ^6.2.5 | Pujar 6 latest. |
| `validator` | ^13.7.0 | Pujar latest. |
| `chai` (dev) | ^2.2.0 | Molt antic → 4/5. |
| `mocha` (dev) | ^10.2.0 | OK. |
| `selenium-webdriver` (dev) | ^4.7.1 | Tests usen API eliminada (`/testing`). → Playwright o supertest. |
| `preinstall: npx npm-force-resolutions` + `resolutions.graceful-fs` | — | Hack yarn-style **ineficaç** (graceful-fs 1.2.3 igualment instal·lat). Eliminar; usar `overrides` npm. |
| `.npmrc engine-strict=true` + `engines.node>=13` | — | Bloqueja instal·lacions; alinear amb objectiu Node 24. |

---

## 3. Base de dades i migracions

- **Dev:** SQLite (`config/db.json` development, `./db.development.sqlite`). **Test/Prod:** MySQL. Sequelize 3 dialecte sqlite.
- 15 taules creades per `sync()` (verificat): `BankHolidays, Companies, DepartmentSupervisor, Departments, EmailAudit, LeaveTypes, Leaves, Sessions, UserFeeds, Users, audit, comment, schedule, user_allowance_adjustment` (+ `sqlite_sequence`).
- 18 migracions (2017–2020). **Riscos:**
  - Carreguen models actuals (`require('../lib/model/db')`) → no històriques.
  - Reconstruccions de taula SQLite **dins de `up()`** (backup→copy→`dropTable`→rename) amb llistes de columnes hardcoded i `PRAGMA foreign_keys=off`:
    - `20171220-drop-adjustment-column-from-user.js` → reconstrueix **Users**.
    - `20190118-chnage-type-value-for-api-token.js` → reconstrueix **Companies** (comprova `type==='UUID'`, fràgil segons dialecte).
    - `20170329060832-rename_allowence_to_allowance.js` → `dropTable(Department)` en reconstrucció.
  - `down()` = "No way back!" (no reversibles).
  - **Pèrdua de dades possible** si el model actual divergeix de l'esquema real en executar migracions antigues.
- **Cal:** desacoblar migracions dels models, snapshot històric, proves up/down sobre còpies seeded, i substituir `sync()` d'arrencada per `migrate` controlat. Verificar preservació de dades (Fase 3).

---

## 4. Autenticació, sessions i permisos

- **Local:** `passport-local`. Hash **MD5** (`crypto.createHash('md5').update(password + crypto_secret, 'binary')`) — `lib/model/db/user.js:421-429`. Sal estàtica a `config/app.json` (`crypto_secret`). **Inacceptable per a 2026.**
- **Reset password:** token = `base64(email + ' ' + md5(password))` (`user.js:334-338`), verificat a `:432-445`. **Determinista, sense aleatorietat ni caducitat**; qui coneix el hash pot forjar tokens. `new Buffer` deprecated.
- **LDAP:** opcional per empresa; `ldapauth-fork`; config desada en **clar** a `Companies.ldap_auth_config` (JSON). `allow_unauthorized_cert` → `rejectUnauthorized:false` (**bypass TLS**) — `company.js:314-328`.
- **Bearer (integration API):** token = UUID d'empresa (`Companies.integration_api_token`, plaintext). `getCompanyAdminByToken` selecciona el **primer admin**. Errors retornen `res.json({error})` amb stack (`integration_api.js`).
- **Sessions:** `express-session` + store Sequelize (taula `Sessions`) o Redis. **Secret hardcoded** `'my dirty secret ;khjsdkjahsdajhasdam,nnsnad,'` (`withSession.js`). Sense `cookie.secure/httpOnly/sameSite`, sense `trust proxy`.
- **Serialització:** només `user.id`; `deserializeUser` recarrega via `reload_with_session_details`.
- **Permisos:** `ensure_user_is_admin` (redirect 303 si no admin) a `/settings/`. Rutes autenticades sota dashboard. Control d'accés verificat (guest → 303).
- **Logout per GET** (`/logout`) → CSRF-able (menor).

---

## 5. Seguretat (vulnerabilitats i mancances)

| Sev | Troballa | Evidència |
|---|---|---|
| P0 | Contrasenyes MD5 + sal estàtica commitejada | `user.js:421`, `config/app.json` |
| P0 | Token reset determinista sense caducitat | `user.js:334,432` |
| P0 | Secret sessió hardcoded; cookies sense flags | `withSession.js` |
| P0 | **Sense CSRF** a tot el formulari POST | cap `csurf`/double-submit |
| P0 | 86 vulns npm (14 crit / 49 high) | `npm audit` |
| P0 | CI/CD auto-deploy + `terraform apply -auto-approve` en push a qualsevol branca | `.github/workflows/*` |
| P1 | Credencials LDAP en clar + bypass TLS | `company.js:44-67,314-328` |
| P1 | Feed token invàlid → **200 "N/A"** (hauria 404); token públic enumerable | `feed.js` (TODO VPP) |
| P1 | Sense rate-limit a login/register/forgot | `login.js` |
| P1 | Stack traces / `err.message` exposats; `morgan('dev')` a prod | `app.js`, `integration_api.js` |
| P1 | `formidable@1` (CVEs) a import CSV | `users/index.js:125` |
| P1 | Handlebars prototype-access warning (superfície pollution) | logs arrencada |
| P1 | `sync()` d'arrencada + migracions no històriques | `bin/wwww`, `migrations/*` |
| P2 | `new Buffer` deprecated; `node-uuid`/`optimist`/`request` abandonats | divers |
| P2 | Dockerfile `alpine:latest` sense pin, install com a root, secrets copiats, sense healthcheck | `Dockerfile` |
| P2 | `.travis.yml` Node 10 + chromedriver 77 (mort) | `.travis.yml` |

**Superfície d'atac addicional a revisar (Fase 3):** IDOR sobre `userId`/`leaveId`/`request_id` (aprovacions/cancel·lacions), session fixation, entropy de tokens de feed/API, validació de dades (joi 12 / validator), open redirect a `redirect_with_session`.

---

## 6. Tests

- **72 fitxers** a `t/`: 52 integració (Selenium), 6 llibreries suport, resta.
- **Suite morta:**
  - `t/lib/build_driver.js` default **phantomjs** (mort); `USE_CHROME` → chrome headless.
  - Tests importen `selenium-webdriver/testing` → **API eliminada a selenium-webdriver 4**.
  - `t/lib/login_with_user.js` asserta flash **"Welcome back"** que està **comentat** a `lib/route/login.js`.
  - `.travis.yml` baixa chromedriver 77 (2019) i arrenca `bin/wwww`.
- **CI:** `deploy-dev-timeoff.yaml` job `test` executa `echo "Dummy execution of tests"` (npm test comentat). **No hi ha proves reals al CI.**
- **Acció Fase 1 (feta):** nova suite de regressió HTTP **sense dependències noves** (`t/regression/smoke.js`, `node:http`), arrenca l'app in-process amb BD SQLite aïllada en temp. **14/14 PASS** sobre la base recuperada. Bloqueja el comportament actual (incloent quirks: feed 200 N/A, MD5) per diffar canvis de Fase 2/3.
- **Fase 3:** ampliar a fluxos complets (book/approve/revoke/cancel, calendaris, permisos, notificacions, admin, feeds) amb supertest + paritat UI opcional (Playwright).

---

## 7. Docker / Helm / CI-CD / Terraform

- **Dockerfile:** multi-stage `alpine:latest` (sense pin), `npm install` com a **root** a l'stage deps, copia tot el repo (inclou `config/` amb secrets), usuari `app` al final, `CMD npm start` (PID 1, sense gestió de senyals), `EXPOSE 3000`, **sense healthcheck**.
- **Helm (`helm-timeoff/`):** chart GKE (ingress, cert-manager issuer/certificate, HPA, serviceaccount). `values.yaml` securityContext buit. Específic de GKE → **substituir per Docker Compose / Coolify** (Fase 4).
- **Terraform (`infrastructure/`):** mòdul GKE `big-liberty-373120`, backend GCS `tf-state-timeoff`. `variables.tfvars` buit.
- **Workflows (P0):**
  - `deploy-infrastructure.yaml`: `on: push: branches:["**"]` paths `infrastructure/**` → `terraform init/plan/`**`apply -auto-approve`** amb `secrets.GOOGLE_CREDENTIALS`.
  - `deploy-dev-timeoff.yaml`: `on: push: branches:["**"]` paths `bin/config/lib/migrations/public/scss/views/**` (+ typo `helm-tiemoff`) → build Docker, push GCR, `helm upgrade --install` a GKE.
  - **Qualsevol push a qualsevol branca amb aquests paths dispara desplegament real i apply de infra.** Cal passar a `workflow_dispatch` manual + protecció de branca, o eliminar/archive abans de push. **No s'ha fet push.**

---

## 8. Recuperació d'execució (provada, en sandbox aïllat)

**Conclusió de viabilitat:** el conjunt original exacte no és instal·lable en cap Node únic.
- `sqlite3@4.0.1` precompilat: **només ABI 57 (Node 8) / 64 (Node 10)** (probe HEAD: 200; resta 403).
- `node-sass@8` precompilat: ABI 72/83/93/108/111 (Node 12–19); `engines node>=14` + `engine-strict`.
- Intersecció buida → build original trencat (coherent amb CI "dummy").

**Recuperació mínima provada (sandbox `/tmp/timeoff-recovery.*`, repo intacte):**
- Node **18.20.8** + `sqlite3@5.1.7` (únic delta) + resta original (Sequelize 3.35.1, node-sass 8).
- `npm install`: **EXIT 0**, 922 paquets, bindings `linux-x64-108` (node-sass) i `node_sqlite3.node` (sqlite3) presents.
- `npm run db-update` (sequelize-cli 2.5.1): **FALLA** → `graceful-fs@1.2.3`/`natives` → `ReferenceError: primordials is not defined`. (El CLI està trencat a Node ≥12; l'app usa `sync()`, no el CLI.)
- App arrencada (`node bin/wwww`, port 3999 loopback):
  - `GET /login` → **200** "Time Off Management".
  - `POST /register` (empresa+admin) → **302 /**; email de registre simulat (`send_emails=false`).
  - `GET /` autenticat → **302 /calendar/** → **200 "Calendar"**.
  - `POST /login` correcte → **302 /**; incorrecte → **302 /login**.
  - Guest `/calendar/`, `/settings/` → **303 /**.
  - `GET /feed/badtoken/ical.ics` → **200 "N/A"** (quirk).
  - 15 taules creades; password desada MD5 hex.
- **Regressió `t/regression/smoke.js`: 14/14 PASS** (Node 18, BD temp aïllada).

**Implicació per a Fase 2:** el primer pas real és arreglar la cadena de build (node-sass→sass, graceful-fs/overrides, sequelize-cli) i sqlite3 5, mantenint Sequelize 3 com a runtime interim fins a la migració progressiva a 6.

---

## 9. Lliurables d'aquesta fase (a la branca)

- `docs/AUDIT.md` (aquest document).
- `docs/FUNCTIONAL_INVENTORY.md` — inventari de funcionalitats.
- `docs/MODERNIZATION_PLAN.md` — seqüència de canvis proposada (Fase 2–4).
- `t/regression/smoke.js` + `t/regression/README.md` — suite de regressió baseline (14/14).

**Pendent d'autorització:** qualsevol modificació de dependències, push, desplegament, canvi d'infraestructura o migració sobre BD real.
