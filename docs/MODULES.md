# Revisió d'arquitectura — modularització real vs declarativa

Auditoria post-modernització. Avaluació honesta de què és **real** (codi integrat i
provat) i què és **declaratiu** (metadades/planificació), i garantia que els futurs
mòduls reutilitzaran les mateixes regles d'autenticació, empresa, permisos, auditoria
i base de dades.

## Què és REAL (integrat i verificat)

1. **Autorització centralitzada** — `lib/auth/permissions.js`
   - Rols (`owner/admin/manager/employee`), catàleg de permisos, `can()`,
     `requirePermission()` (HTML) i `requirePermissionApi()` (JSON 401/403).
   - Integrat als routers `settings` (`company.settings`), `audit` (`audit.view`),
     `users` (`employees.manage`, admin-only preservat) i `workcenters`
     (`workcenters.manage`).

2. **Aïllament per empresa centralitzat** — `lib/auth/tenant.js`
   - `scopeByCompany()`, `ensureTenant()`/`ensureTenantApi()`, `assertSameCompany()`.
   - Integrat a les rutes; verificat amb proves negatives (IDs directes cross-company
     rebutjats sense mutació a BD).

3. **Mòdul WorkCenter complet (exemplar vertical)**
   - Model (`lib/model/db/work_center.js`) + migració + API tenant-guarded
     (`lib/route/workcenters.js`) + guard d'associació al model `User`
     (`beforeSave`: un empleat només es vincula a un centre de la seva empresa).
   - Demostra de punta a punta el patró que seguiran els futurs mòduls, amb proves
     positives i negatives reals.

4. **Infraestructura compartida reutilitzable**
   - BD: Sequelize 6, migracions dialecte-agnòstiques (SQLite + PostgreSQL verificats).
   - Auditoria: `lib/model/audit.js` (+ `EmailAudit`).
   - Seguretat transversal: CSRF, sessions (regeneració/login, destrucció/logout),
     rate-limit (`lib/middleware/auth-rate-limit.js`), helmet+CSP, bcrypt asíncron.

## Què és DECLARATIU / pendent

1. **Registre de mòduls** — `lib/modules/index.js`: metadades (active/planned).
   Declara fronteres i muntatges previstos, però **encara no auto-munta** rutes de
   mòdul. És un índex, no un carregador dinàmic.

2. **Nucli i absències**: la lògica de negoci existent continua a `lib/model/*` i
   `lib/route/*` (estructura plana). **No s'ha encapsulat encara en directoris de
   mòdul amb interfícies públiques explícites.** És un refactor pendent; la
   funcionalitat es preserva i està provada.

3. **Mòduls planificats** (time-tracking, shifts, documents, employee-portal,
   analytics, payroll, subscriptions): declarats, **no construïts** (com es va demanar).

## Contracte per a un nou mòdul (garantia de reutilització)

Un mòdul nou (p.ex. `time-tracking`) es construeix **sense refer el nucli** i
reutilitza exactament les mateixes regles:

1. **Model(s)** a `lib/model/db/` amb `companyId` i migració dialecte-agnòstica.
2. **Rutes** que usen `ensureTenant(Api)` + `requirePermission(Api)` +
   `scopeByCompany` + `assertSameCompany` (mateixos helpers que WorkCenter).
3. **Permisos** registrats a `lib/auth/permissions.js`.
4. **Auditoria** d'operacions via `lib/model/audit.js`.
5. **Registre** al catàleg `lib/modules/index.js`.
6. **Proves** amb BD temporal aïllada + casos negatius cross-company (IDs directes).

Això queda **demostrat per WorkCenter**, que ja segueix aquest contracte i passa
les proves d'aïllament. Cap mòdul nou necessita microserveis ni frameworks addicionals.

## Recomanacions (següent fase, sense construir mòduls ara)

- Convertir el registre en un carregador que munti rutes/permisos de cada mòdul
  (reduir el caràcter declaratiu).
- Encapsular progressivament `core` i `absences` en directoris de mòdul amb
  interfícies públiques, preservant les proves de regressió.
- Retirar els shims transitoris (Promise/Sequelize/validator) cap a async/await i
  idiomes Sequelize 6 nadius.

## Conclusió

La modularització és **parcialment real**: les regles compartides d'autenticació,
empresa, permisos, auditoria i BD són efectives i reutilitzables (provades via
WorkCenter i els routers integrats). El registre de mòduls i l'encapsulació del
nucli/absències en directoris de mòdul són la part declarativa/pendent. Es garanteix
que els futurs mòduls podran usar les mateixes regles sense refer el nucli.
