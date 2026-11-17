# Inventari de funcionalitats (baseline a conservar)

Extret de `lib/route/*`, `lib/model/*`, `views/*.hbs` i `config/`. La modernització **ha de preservar** aquestes funcionalitats i l'experiència d'usuari (Bootstrap 3 + jQuery). Qualsevol redisseny visual significatiu queda **fora** de la modernització tècnica.

## Autenticació i comptes
- Login local (email + contrasenya) — `lib/route/login.js`, `lib/passport`.
- Login **LDAP** opcional per empresa — `company.get_ldap_server()`.
- Logout (GET `/logout`).
- Registre d'empresa + usuari admin (`/register`), commutable via `allow_create_new_accounts`.
- Forgot password (`/forgot-password/`) + reset per token (`/reset-password/?t=`).
- API d'integració **Bearer** per empresa (`/integration/v1/`), token UUID commutable (`integration_api_enabled`).
- Activació automàtica d'usuari al primer login (`maybe_activate`).

## Empresa / configuració general (admin)
- Dades d'empresa, país, **timezone**, format de data (`date_format`).
- Missatge global d'empresa (`company_wide_message`).
- Mode d'empresa (`mode`, incl. *readonly holidays*).
- Compartir totes les absències (`share_all_absences`).
- Ocultar team view per a no-admins (`is_team_view_hidden`).
- **Carry-over** de dies (`carry_over`, configuració per any).
- Inici d'any nou (`start_of_new_year`).
- Autenticació LDAP (URL, bind DN, credencials, search base, TLS).
- Token d'API d'integració (regenerable).

## Departaments
- CRUD departaments (`/settings/departments`), supervisors (`DepartmentSupervisor`).
- Actualització massiva (`departments_bulk_update`).
- Allowance accrued per departament (`is_accrued_allowance`).

## Usuaris / empleats
- CRUD usuaris (`/users/`), alta (`user_add`), import **CSV** (`users_import`, formidable).
- Activar/desactivar (`activated`), drets d'admin (`admin`).
- Auto-aprovació per usuari (`auto_approve`).
- Dates d'alta/baixa (`start_date`, `end_date`).
- Ajust d'allowance per any (`user_allowance_adjustment`).
- Horari específic d'usuari (`schedule`).
- Resum per empleat (`users/summary`), filtre per departament.
- Protecció: no es poden treure drets admin a l'últim admin (test existent).

## Tipus d'absència (Leave Types)
- CRUD (`leave_type`), colors al calendari, ordre (`sort_order`).
- Límit de dies per tipus/any, flag d'allowance, auto-aprovació (`auto_approve`).
- Eliminar tipus en ús (gestió de dependències).

## Sol·licituds d'absència (Leave)
- Reserva amb **mitjos dies** (matí/tarda), solapaments detectats.
- Guard de sobre-reserva d'allowance.
- Aprovació / rebuig per supervisor o admin (`/requests/approve/`, `/reject/`).
- Cancel·lació (`/requests/cancel/`), revocació (`/requests/revoke/`).
- Auto-aprovació (usuari o tipus).
- Comentaris (`comment`).
- Sol·licituds per a altres usuaris (segons permisos).
- Notificacions per email de decisió/cancel·lació/revocació.

## Calendaris i vistes
- Calendari personal (`/calendar/`), any complet.
- **Team view** (wall chart) amb columnes deducted i controls de visibilitat.
- Vistes d'absències per equip / departament.

## Festius (Bank Holidays)
- CRUD festius (`/settings/bankHolidays`), formats de data no estàndard.
- Horari company-wide (`schedule`).

## Feeds iCal (públics per token)
- Feed de calendari personal (`/feed/:token/ical.ics`).
- Feed de team whereabout (OOO) amb finestres de mesos passats/futurs.
- Integració Outlook / Google Calendar / iCal.

## Informes
- Informe d'allowance (UI + API `/integration/v1/report/allowance`).
- Informe d'absències (`/integration/v1/report/absence`, `lib/model/Report.js`).
- Resum exportable (`lib/model/company/exporter`).

## Auditoria i notificacions
- Auditoria d'accions (`audit`, `/audit/`, API `/integration/v1/audit/`).
- Auditoria d'emails (`EmailAudit`, compressió migració 20191030).
- Notificacions de sol·licituds pendents (`/api/v1/notifications/`).

## Tasques periòdiques / scripts
- Càlcul de carry-over per a tots els usuaris (`bin/calculate_carry_over_allowance_for_all_users.js`, `npm run carry-over-allowance`).
- Utilitats `bin/fetch_user_stat.js`, `bin/check_where_i_am_on_google.js` (revisar/eliminar).

## Localització i email
- `config/localisation.json` (621 KB) — països, strings.
- Emails: registre, forgot/reset, decisió/cancel·lació/revocació de sol·licituds (nodemailer, `send_emails`).
- Sessions en Redis opcional (`docs/SessionStoreInRedis.md`).

## UX a conservar
- 79 vistes Handlebars, Bootstrap 3, jQuery, bootstrap-datepicker, Font Awesome.
- Flash messages, modal de reserva, navegació per menú segons rol.
