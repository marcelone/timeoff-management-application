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


---

## Mòdul `time-tracking` — bloc 1 (registre bàsic de jornada)

Implementat com el primer mòdul de negoci real sobre aquest contracte.

**Fitxers**

- `lib/model/db/time_entry.js` — jornada (estat, modalitat, inici/fi UTC, `companyId`, `userId`).
- `lib/model/db/time_entry_event.js` — log append-only d'esdeveniments (`in`/`out`, `source` = direct|declared|auto).
- `lib/model/db/work_schedule_day.js` — hores previstes per dia (`scope_type` =
  company|department|user). Cada dia té **tres estats explícits**: heretar (cap fila),
  laborable amb hores, o **no laborable** (`is_working_day = false`, que atura
  l'herència — necessari per a jornades parcials).
- `lib/modules/time/schedule.js` — resolució única de la jerarquia `user > department > company` + timezone i format.
- `lib/modules/time/clock.js` — servei d'inici/fi amb hora de servidor i transaccions.
- `lib/route/time.js` — `/time/`, `/time/start`, `/time/stop`, `/time/schedule/`.
- `views/time/index.hbs`, `views/time/schedule.hbs`.
- `migrations/20260104000000-time-tracking.js`.
- `t/regression/time-tracking.spec.js`.

**Decisions**

- **Jornada separada d'esdeveniments**: l'estat viu a `time_entries` i els fets a
  `time_entry_events`, de manera que pauses, correccions i tancaments automàtics
  s'afegiran com a esdeveniments nous sense sobrecarregar la fila mutable.
- **Una sola jornada oberta**: garantida per un **índex únic parcial**
  (`time_entries_one_open_per_user ... WHERE status='open'`) present a PostgreSQL i
  SQLite, no només per codi. Verificat a PG: el segon INSERT falla.
- **Sortida > entrada**: `CHECK` a PostgreSQL; validació de model per a SQLite
  (que no pot afegir CHECK a taules existents).
- **Hora del servidor**: les rutes no llegeixen cap hora del cos de la petició;
  es desa UTC i es presenta amb la timezone del centre o de l'empresa.
- **Permisos**: `time.clock` (tothom) i `time.schedules.manage` (owner/admin).
  No s'assumeix que `Department.boss` tingui el rol RBAC `manager`.
- **Sense dades fictícies**: cap empresa existent rep horaris; la plantilla
  d'oficina només s'aplica quan un administrador la desa explícitament.
- **Dia de la setmana en la timezone efectiva** (centre > empresa > UTC), no en UTC.
- **Eliminació d'empleat**: `User.remove` és transaccional i es bloqueja si hi ha
  fitxatges (l'historial es preserva; la FK és NO ACTION com a xarxa de seguretat).
  Abans, un error de FK podia deixar l'empleat viu amb les absències ja esborrades.
- **CSRF i multipart**: només `/users/import/` pot enviar `multipart/form-data`
  (i valida el token del body); qualsevol altre endpoint amb multipart es rebutja.
- **Handlers async**: `/time/*` embolcalla els handlers perquè un rebuig arribi al
  middleware d'errors en lloc de tombar el procés (Express 4 no ho fa sol).
- **Tancament de jornada**: es comprova `endedAt > startedAt` al servei, perquè
  SQLite no pot afegir el CHECK que sí té PostgreSQL.

**Zones horàries (bloc 1, completat)**

- Jerarquia: **centre de treball > empresa > UTC**. `WorkCenter.timezone` és
  opcional i NULL significa «hereta de l'empresa» (sense canvi d'esquema).
- Selector de centre a `/settings/workcenters/` (permís `workcenters.manage`,
  `ensureTenant`): crear centre i triar zona IANA o «Heretar de l'empresa».
  Validació al servidor amb la mateixa llista que valida l'empresa
  (`moment-timezone`), també per a peticions manipulades.
- `/time/` i `/time/schedule/` mostren sempre zona efectiva **i origen**. En
  configurar l'horari d'un empleat concret es mostra la zona efectiva d'aquell
  empleat (el seu centre), no la de l'administrador que edita.
- `resolveWeekForUser` construeix les dates de referència **dins la zona**, així
  el dilluns continua sent el primer element a `Pacific/Auckland` i
  `Pacific/Kiritimati`.
- Els fitxatges són instants UTC generats pel servidor: canviar la configuració
  no reescriu cap registre, només canvia com es mostra.
- `Company.get_today()` fa fallback a UTC si l'empresa no té zona (abans llançava
  i provocava un 500 a qualsevol pàgina).

**Pauses i còmput (bloc 2)**

- Taules noves: `break_policies` (per empresa i tipus: computa o no) i `time_breaks`
  (una pausa amb inici/fi, tipus i **snapshot** de la política).
- Tres tipus: `regular`, `personal`, `justified`; per defecte **cap computa**.
  Configuració a `/settings/breaks/` (permís `company.settings`).
- **Històric estable per construcció**: la pausa desa `counts_as_work` en començar,
  així canviar la política no recalcula jornades ja tancades.
- Una sola pausa activa per jornada: **índex únic parcial**
  (`... WHERE ended_at IS NULL`), verificat a PostgreSQL.
- No es pot tancar la jornada amb una pausa activa (`ACTIVE_BREAK`); l'empleat
  l'ha de finalitzar primer. Sense autotancaments.
- Esdeveniments `break_start` / `break_end` al mateix log append-only del bloc 1.
- Còmput (`lib/modules/time/compute.js`): transcorregut, pauses, pauses computables,
  i **computat = transcorregut − pauses no computables**, en ms i arrodonit al final
  (sense errors per DST). Una pausa no computable activa es descuenta fins a "ara".
- Comparació amb l'horari previst **només quan és fiable**: si el dia no té horari,
  és no laborable, és festiu de l'empresa o té una absència aprovada, es mostra
  «diferència no disponible» amb el motiu. Una absència no és temps treballat i un
  dia no laborable no genera dèficit. La diferència no és hores extres.

**Correccions de l'auditoria del bloc 2**

- **F01/F02 — serialització**: `lib/modules/time/locks.js` bloqueja la fila de la
  jornada (`SELECT ... FOR UPDATE` a PostgreSQL; `UPDATE` no-op a SQLite) abans de
  llegir l'estat, tant a l'inici/fi de pausa com al tancament. Així no pot existir
  una jornada tancada amb una pausa activa, i una pausa no pot començar abans del
  final de l'anterior (`OVERLAPS_PREVIOUS`).
- **F07 — ordre temporal**: sota el mateix bloqueig, el tancament rebutja una hora
  anterior al final d'una pausa ja tancada (`BREAK_AFTER_END`). Una petició que ha
  esperat pot tornar-se a provar amb una hora de servidor actualitzada.
- **Política i transaccions**: la lectura de política d'una mutació utilitza la seva
  mateixa transacció; així veu les escriptures pròpies i no necessita una segona
  connexió mentre manté la primera ocupada. Les desades simultànies se serialitzen
  per empresa per evitar que es barregin valors de formularis diferents.
- **F03 — política**: l'estat de les caselles es resol a la ruta (`counts` per tipus)
  en lloc de fer cerques de context dins del bucle de Handlebars.
- **F04 — agregació diària**: la comparació suma totes les sessions del dia local i
  retalla sessions i pauses a la finestra `[inici del dia, mitjanit següent)`, així
  que diverses sessions se sumen i una sessió que travessa mitjanit no s'atribueix
  sencera a un dia.
- **F05 — dates civils**: festius i absències es desen com a dates civils a les
  00:00 UTC; es comparen en la mateixa representació (rang del dia civil en UTC),
  mentre que la zona efectiva decideix QUIN dia es consulta.
- **F06 — migració atòmica**: tota la DDL de `20260105000000-time-breaks.js` va en
  una transacció; una fallada intermitja fa rollback complet i el reintent funciona.

**Fora d'abast (blocs següents)**: pauses, correccions, incidències,
autoresolució, recordatoris, scheduler, estadístiques.
