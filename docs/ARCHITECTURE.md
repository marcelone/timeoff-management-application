# Arquitectura — Plataforma SaaS de RRHH (monòlit modular)

## Visió
TimeOff.Management evoluciona cap a una **plataforma SaaS modular de RRHH per a PIMEs**.
Aquest document descriu els fonaments establerts a la Fase 2 perquè els futurs mòduls
(fitxatge, torns, documents, portal de l'empleat, analítica, nòmines, subscripcions)
es puguin construir **sense refer el nucli**.

Decisió: **monòlit modular** (un sol desplegable). No s'introdueixen microserveis,
React ni TypeScript. La interfície actual (Handlebars + Bootstrap) es manté operativa;
el redisseny visual modern és una fase posterior separada.

## Stack (Node 24 LTS)
- Node.js ≥ 24, Express 4, Sequelize 6, SQLite (dev/single-container) o PostgreSQL (prod).
- Handlebars (express-handlebars 8), Passport 0.7 (local + bearer + LDAP via ldapts).
- bcrypt (cost 12), sessions signades (secret via env), CSRF (synchronizer token),
  helmet, express-rate-limit.
- Migracions amb Umzug (esquema net generat des dels models); arrencada = migrar → escoltar.
- Dart Sass per als estils.

## Aïllament per empresa (tenant)
- Cada registre de negoci pertany a una empresa (`companyId`).
- Helpers centralitzats a `lib/auth/tenant.js`:
  - `scopeByCompany(user, where)` — afegeix l'abast d'empresa a una consulta.
  - `ensureTenant` — middleware que exigeix usuari autenticat amb empresa.
  - `assertSameCompany(user, record)` — llença si el record és d'una altra empresa.
- Verificat per `t/regression/isolation.spec.js`: una empresa **no pot llegir ni modificar**
  dades d'una altra via UI, API ni IDs directes (sense modificació a la BD).

## Rols i permisos
- `lib/auth/permissions.js`: catàleg de permisos → rols (`owner`, `admin`, `manager`, `employee`).
- `roleOf(user)` deriva el rol (el boolean `admin` legacy es mapen a `admin`).
- `can(user, permission)` i `requirePermission(permission)` (middleware) són la font
  d'autorització. Els nous mòduls registren els seus permisos aquí.
- Camp `Users.role` (default `employee`) com a base RBAC.

## Centres de treball
- Model `WorkCenter` (`lib/model/db/work_center.js`): `name`, `address`, `timezone`, `companyId`.
- `Users.workCenterId` (opcional) enllaça empleats amb un centre.
- Preparat per a torns i fitxatge multi-centre.

## Mòduls
Registre a `lib/modules/index.js`:
- **Actius:** `core` (empreses, usuaris, departaments, centres, auth), `absences`
  (vacances, aprovacions, calendaris, feeds).
- **Planificats:** `time-tracking`, `shifts`, `documents`, `employee-portal`,
  `analytics`, `payroll`, `subscriptions`.

Cada mòdul futur:
1. Afegeix models/migracions pròpies (scopes per empresa).
2. Registra permisos a `lib/auth/permissions.js`.
3. Munta rutes sota el seu prefix i usa `lib/auth/tenant.js` per a l'aïllament.
4. Es declara al registre de mòduls.

## Auditoria i API
- Auditoria d'operacions existent (`lib/model/audit.js`, `audit/`, `EmailAudit`).
- API d'integració per empresa amb bearer token (`/integration/v1/`), aïllada per tenant.
  Preparada per a integracions de nòmines i connectors.

## Subscripcions (ready)
- `Companies.plan` (default `free`) i `Companies.subscription_status` (default `active`).
- El mòdul `subscriptions` futurs gestionarà plans, límits i facturació sense canviar el nucli.

## Compatibilitat transitòria (a retirar)
Per preservar la lògica funcional existent durant la modernització:
- `lib/promise-shim.js` — subconjunt Bluebird sobre Promise natiu.
- `lib/model/db/compat.js` — adaptador Sequelize 3→6 (define/operators/scope-getters).
- `lib/validator-shim.js` — validator null-safe.
Pla de retirada: refactor progressiu a async/await i idiomes Sequelize 6 (veure MODERNIZATION_PLAN.md).

## Proves
`t/regression/` (mocha + supertest), **BD temporal aïllada obligatòria** (NODE_ENV=test
força SQLite temporal; cap configuració pot apuntar a una BD externa). Asserts reals a la BD,
no només HTTP 200. Cobertura: auth, fluxos de vacances, permisos, aïllament tenant, fonaments.

## Desplegament
Objectiu: **Coolify** amb Docker (Node 24). Veure Dockerfile / docker-compose / .env.example
i docs/DEVELOPMENT.md (Fase 4). Els workflows GKE/Terraform originals estan desactivats (manual-only).
