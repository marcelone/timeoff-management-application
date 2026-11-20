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


**Correccions de fitxatges i aprovacions (bloc 3)**

- Taules noves: `time_correction_policies` (mode per empresa) i `time_corrections`
  (la sol·licitud). Columnes noves: `time_entries.source` (`direct`|`declared`) i
  `time_entries.version`, `time_entry_events.correction_id` i
  `time_entry_events.payload`. Migració `20260106000000-time-corrections.js`, amb
  tota la DDL en una transacció (com el bloc 2).
- **Mai no s'esborra l'original**: la correcció és una *sol·licitud* que conserva
  valor original, valor proposat, motiu, política aplicada i qui resol i quan.
  Aplicar-la canvia la projecció efectiva (`time_entries` / `time_breaks`) i
  **afegeix** un esdeveniment `correction` al timeline; els esdeveniments
  `in` / `out` / `break_start` / `break_end` originals no es reescriuen mai. El
  còmput del dia original sempre es pot reconstruir.
- **Política per empresa** (`/settings/corrections/`): `self_service` (s'aplica
  immediatament) o `approval_required` (per defecte, el prudent). La política es
  **captura a la sol·licitud**: canviar-la no aprova pendents, no reverteix
  aplicades i no toca l'historial.
- **Casos**: entrada, sortida, sortida oblidada (jornada oberta), jornada
  completament oblidada, inici/final de pausa, tipus de pausa, pausa oblidada i
  modalitat. El formulari és en passos (tipus → registre → valors), de manera que
  només es mostren els camps del tipus triat i no cal JavaScript (la CSP només
  permet scripts amb nonce).
- **Validació al servei** (no només a les rutes): instant construït pel servidor
  a partir de data + hora local **en la zona efectiva** (el navegador no envia
  instants); un horari inexistent pel canvi d'hora es rebutja; no es pot tancar
  una jornada amb una pausa activa; no hi pot haver solapaments de jornades ni de
  pauses; cap valor futur; cap jornada declarada oberta sense fi.
- **Conflictes**: cada sol·licitud es fa contra una *instantània* del valor que
  corrigeix. En resoldre-la, el valor actual es compara amb aquesta instantània
  **dins de la mateixa transacció** que bloqueja la fila. Si no coincideix, la
  correcció **no s'aplica**, la sol·licitud es conserva amb estat `conflict` i un
  humà la resol. És el mecanisme proporcional que demana el producte (no cal un
  versionat complex); `time_entries.version` queda com a dada auditable.
- **Resolució atòmica i segura en repetició**: les mutacions de jornades es
  serialitzen per empleat abans de validar solapaments; la sol·licitud es reclama amb un
  `UPDATE ... WHERE status='pending'`, de manera que dues aprovacions (o una
  aprovació i un rebuig) concurrents no poden guanyar les dues i una sol·licitud
  no pot acabar aprovada i rebutjada alhora.
- **Autorització**: el servei decideix qui pot resoldre (cap ruta ho fa per
  compte del servei): el cap de departament (`Department.boss`) o un
  `DepartmentSupervisor` del departament de l'empleat, o un owner/admin de
  l'empresa. El rol RBAC `manager` **no** significa supervisor.
- **Autoaprovació administrativa** (ajust del bloc 3): el sol·licitant **sí** pot
  resoldre la seva pròpia sol·licitud, però només com a excepció administrativa
  explícita: ha de tenir el rol administratiu vigent (owner/admin) i la
  sol·licitud ha de pertànyer a la seva empresa. **Ni el cap de departament ni un
  `DepartmentSupervisor` s'autoaproven mai**; el rol RBAC `manager` tampoc. La
  condició es comprova al servei, no només a la interfície, i la resolució
  conserva les mateixes validacions temporals i de concurrència que qualsevol
  altra aprovació. En mode `self_service` no hi ha cap aprovació i el
  comportament no canvia. L'excepció es traça en tres llocs: la columna
  `time_corrections.self_approved`, una fila d'auditoria explícita
  (`attribute = 'administrative_self_approval'`) i, si s'aplica, el payload de
  l'esdeveniment `correction` (`administrativeSelfApproval: true`). En un
  `conflict`, l'indicador registra l'intent d'aprovació, sense aplicació.
  Migració
  `20260107000000-time-corrections-self-approval.js` (columna booleana +
  `CHECK` de PostgreSQL `NOT self_approved OR status IN ('applied','conflict')`).
- **Auditoria**: fila a la taula `audit` (`entity_type = 'TIME_CORRECTION'` amb
  estat, tipus, política, motiu, valor original, valor proposat i resolutor) i
  esdeveniment `correction` al timeline amb la referència explícita a la
  sol·licitud i el payload del canvi.
- **Garanties de base de dades**: índex únic parcial
  (`time_corrections_one_pending_per_target ... WHERE status='pending'`) — una
  sol·licitud pendent per objectiu i empleat; `CHECK` de PostgreSQL sobre
  `status`, `type`, `policy`, `source` i el tipus d'esdeveniment; FK
  `time_entry_events.correction_id → time_corrections` (`ON DELETE SET NULL`).
  Verificat a PostgreSQL 16.
- **Tipus de pausa i el seu criteri de còmput**: en canviar el tipus, el
  `counts_as_work` **es conserva** (és el criteri que va regir quan la pausa va
  passar) perquè la política històrica no es pot reconstruir de manera fiable
  (no hi ha historial deVersions de `break_policies`) i reaplicar la política
  d'avui reescriuria el passat. La regla queda documentada a la sol·licitud, a
  l'esdeveniment i a la interfície.
- **Jornada declarada**: una jornada reconstruïda es desa amb `source='declared'`
  i es presenta com a declarada, mai com un fitxatge verificat. Exigeix hora de
  fi (regla explícita: una sessió oberta s'ha de tancar amb el fitxatge normal).
- **Sortida declarada**: es distingeixen tres instants — el moment de registrar
  la declaració, l'hora declarada i l'hora efectiva acceptada. El servidor mai no
  atribueix a la persona treballadora una hora que no ha declarat.
- **Eliminació d'empleat / d'empresa**: `User.remove` ja es bloqueja si hi ha
  fitxatges; el `CompanyRemover` ara esborra explícitament les taules del
  mòdul de temps i les polítiques de pauses en una única transacció: si falla,
  es conserva tot l'historial. Les migracions impedeixen fer `down` quan
  eliminaria sol·licituds o indicadors d'autoaprovació existents.
- **Compatibilitat**: el bloc 1 (entrada/sortida), el bloc 2 (pauses i còmput) i
  els blocs anteriors de l'aplicació es mantenen; les sessions i pauses
  existents es poden corregir sense migrar-les.

**Fora d'abast (blocs següents)**: recordatoris automàtics, correus
interactius, scheduler, autotancament provisional, detecció de patrons,
alertes per excés de correccions, dashboard analític de supervisió,
geolocalització, nòmines, hores extres aprovades i integracions externes.

**Incidències de jornada i autogestió (bloc 4)**

- Taules noves: `time_incidents` (la incidència) i `time_incident_entries` (el
  fil d'activitat). Migració `20260108000000-time-incidents.js`, amb tota la DDL
  en una transacció (com els blocs 2 i 3) i `down` reversible.
- **Una incidència comunica, no corregeix.** És la diferència essencial amb el
  bloc 3: una *correcció* diu «vaig entrar a les 09:00 i vaig registrar les
  09:30» i canvia el registre efectiu a través d'una sol·licitud aprovada; una
  *incidència* diu «el sistema no funcionava i necessito explicar què ha passat»
  i **no toca cap fitxatge, cap pausa, cap còmput ni cap saldo d'absències**. Si
  la persona també ha de corregir una hora, la interfície l'adreça al formulari
  de correccions existent: no hi ha un segon sistema de correccions.
- **Tipus tancats** (`clocking_problem`, `work_interruption`,
  `schedule_discrepancy`, `exceptional_circumstance`, `other`): una taxonomia
  inicial fixa, no un sistema lliure de categories per empresa. El text obert
  viu a la descripció. No hi ha categories mèdiques ni dades de salut.
- **Estats i transicions**: `open → in_review`, `open → resolved`,
  `open → dismissed`, `in_review → resolved`, `in_review → dismissed`. Els
  estats finals són terminals (no hi ha reobertura ni escalat en aquest bloc), i
  la matriu es valida al servei i amb un `UPDATE` condicional sobre l'estat
  esperat.
- **Permisos** (decidits al servei, no a la vista): l'empleat crea i llegeix les
  seves incidències i hi afegeix aclariments; un supervisor real
  (`Department.boss` o `DepartmentSupervisor`, llegit a cada petició) les
  consulta, les posa en revisió, respon, resol i descarta; l'owner/admin ho pot
  fer a tota l'empresa. El rol RBAC `manager` **no** dona accés per si sol.
  Com que el vincle es llegeix a cada petició, revocar-lo o canviar la persona de
  departament té efecte immediat.
- **Incidències pròpies**: per coherència amb el bloc 3, un owner/admin pot
  resoldre les seves (excepció administrativa explícita), mentre que un
  supervisor ordinari **no** pot resoldre la seva. L'excepció es traça en tres
  llocs: `time_incidents.self_resolved`, una fila d'auditoria amb
  `attribute='administrative_self_resolution'` i el fil d'activitat.
- **Fil d'activitat append-only**: `time_incident_entries` només s'insereix; cap
  entrada s'edita ni s'esborra, i no hi ha cap ruta que ho permeti. Cada entrada
  porta autor, empresa, incidència, instant UTC, contingut i tipus (`comment`,
  `in_review`, `resolved`, `dismissed`, `link`). Text pla; les plantilles
  escapen el contingut i els salts de línia es respecten amb CSS, sense editor
  enriquit ni JavaScript.
- **Regles del fil**: no es pot comentar una incidència tancada, ni una d'aliena;
  un comentari **no** canvia l'estat; no s'envien correus en aquest bloc i no hi
  ha xat en temps real.
- **Relació amb correccions**: una incidència pot apuntar a una sol·licitud de
  correcció existent (`time_correction_id`), de la mateixa persona i empresa.
  La vinculació només la pot fer el sol·licitant mentre la incidència no és
  final. És una **referència**: no aprova, no aplica, no recalcula res, i una
  correcció en `conflict` no resol la incidència automàticament.
- **Relació amb absències**: si la situació és una absència (vacances, baixa,
  permís), la interfície ho explica i enllaça al procés existent
  (`/calendar/`). Una incidència **no** crea una absència, no toca saldos i no
  marca cap dia com a justificat.
- **Auditoria**: cada acció escriu files a `audit` amb
  `entity_type='TIME_INCIDENT'` (creació amb tipus, títol, data, descripció i
  referències; cada canvi d'estat amb estat anterior i posterior; el comentari
  amb la referència a l'entrada; la resolució amb el text i el resolutor; la
  vinculació amb el valor anterior i el nou; i l'auto-resolució administrativa
  amb qui l'ha fet i el rol que tenia). El registre és append-only a nivell
  funcional: mai s'actualitza una fila existent.
- **Concurrència**: cada mutació bloqueja la fila de la incidència dins de la
  transacció (`SELECT … FOR UPDATE` a PostgreSQL, `UPDATE` no-op a SQLite) i
  després fa un `UPDATE` condicional. Dues resolucions no poden guanyar les
  dues; un comentari o una vinculació que competeixen amb el tancament
  s'emmagatzemen **abans** o es rebutgen, mai després; dues creacions amb el
  mateix testimoni d'idempotència produeixen una sola incidència.
- **Idempotència de creació**: el formulari porta un testimoni aleatori i hi ha
  un índex únic parcial `(user_id, idempotency_key) WHERE idempotency_key IS NOT
  NULL`; un doble clic retorna la incidència que ja existeix en lloc de crear-ne
  una segona.
- **Garanties de base de dades**: `CHECK` de PostgreSQL sobre `type`, `status`,
  `kind`, `to_status`, el títol no buit, la coherència «tancada ⇒ resolutor +
  instant + resposta» i `self_resolved ⇒ resolutor = sol·licitant`. Claus foranes
  reals: empresa, empleat, autor, resolutor, jornada opcional (`ON DELETE SET
  NULL`) i correcció opcional (`ON DELETE SET NULL`). A PostgreSQL, la clau
  forana composta `(incident_id, company_id) → time_incidents (id, company_id)`
  fa **estructuralment impossible** un fil entre empreses; SQLite no pot afegir
  una FK composta amb `ALTER`, i el servei valida la mateixa regla.
- **Conservació de l'historial**: `User.remove` es bloqueja si la persona té
  incidències (encara que no tingui cap fitxatge) i el `CompanyRemover` esborra
  explícitament el fil i les incidències dins la mateixa transacció. Eliminar una
  jornada no destrueix la incidència: la referència queda a `NULL` i el text es
  conserva.
- **Dades per al bloc 5** (sense implementar-lo): `opened_at`,
  `last_activity_at`, `review_started_at`, `resolved_at`, l'estat i el fil amb
  autors i instants ja permeten detectar «incidència creada», «resposta nova»,
  «canvi d'estat», «incidència resolta» i «pendent durant un període». No hi ha
  planificador, ni outbox, ni cap procés en segon pla en aquest bloc.

**Fora d'abast (bloc 4)**: correus automàtics, planificador, autotancament de
fitxatges, notificacions push, WebSockets, xat en temps real, adjunts,
reobertures avançades, SLA, escalats automàtics, hores extres, nòmines,
estadístiques de rendiment, classificació amb IA, un nou sistema d'absències i un
nou sistema de correccions.
