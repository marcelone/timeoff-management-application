'use strict';

/*
 * Clean initial schema (generated from Sequelize 6 models).
 * Replaces all legacy migrations. Dialect-agnostic (SQLite + PostgreSQL).
 * No historical data compatibility is required (project is pre-production).
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("Companies", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "name": { type: Sequelize.STRING(255), allowNull: false },
      "country": { type: Sequelize.STRING(255), allowNull: false },
      "start_of_new_year": { type: Sequelize.INTEGER, allowNull: false },
      "share_all_absences": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      "is_team_view_hidden": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      "ldap_auth_enabled": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      "ldap_auth_config": { type: Sequelize.STRING(255) },
      "date_format": { type: Sequelize.STRING(255), allowNull: false, defaultValue: "YYYY-MM-DD" },
      "company_wide_message": { type: Sequelize.TEXT, defaultValue: null },
      "mode": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      "timezone": { type: Sequelize.TEXT, defaultValue: "Europe/London" },
      "integration_api_enabled": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      "integration_api_token": { type: Sequelize.UUID, allowNull: false, defaultValue: Sequelize.UUIDV4 },
      "carry_over": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      "createdAt": { type: Sequelize.DATE, allowNull: false },
      "updatedAt": { type: Sequelize.DATE, allowNull: false },
    }, { indexes: [{"fields":["id"],"unique":false,"name":"companies_id"}] });
    await queryInterface.createTable("Departments", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "name": { type: Sequelize.STRING(255), allowNull: false },
      "allowance": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 20 },
      "include_public_holidays": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      "is_accrued_allowance": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      "createdAt": { type: Sequelize.DATE, allowNull: false },
      "updatedAt": { type: Sequelize.DATE, allowNull: false },
      "companyId": { type: Sequelize.INTEGER, references: { model: "Companies", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
      "bossId": { type: Sequelize.INTEGER },
    }, { indexes: [{"fields":["companyId"],"unique":false,"name":"departments_company_id"},{"fields":["id"],"unique":false,"name":"departments_id"}] });
    await queryInterface.createTable("Users", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "email": { type: Sequelize.STRING(255), allowNull: false },
      "password": { type: Sequelize.STRING(255), allowNull: false },
      "name": { type: Sequelize.STRING(255), allowNull: false },
      "lastname": { type: Sequelize.STRING(255), allowNull: false },
      "activated": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      "admin": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      "auto_approve": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      "start_date": { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      "end_date": { type: Sequelize.DATE, defaultValue: null },
      "createdAt": { type: Sequelize.DATE, allowNull: false },
      "updatedAt": { type: Sequelize.DATE, allowNull: false },
      "companyId": { type: Sequelize.INTEGER, references: { model: "Companies", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
      "DepartmentId": { type: Sequelize.INTEGER, references: { model: "Departments", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    }, { indexes: [{"fields":["companyId"],"unique":false,"name":"users_company_id"},{"fields":["lastname"],"unique":false,"name":"users_lastname"}] });
    await queryInterface.createTable("audit", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "entity_type": { type: Sequelize.STRING(255), allowNull: false },
      "entity_id": { type: Sequelize.INTEGER, allowNull: false },
      "attribute": { type: Sequelize.STRING(255), allowNull: false },
      "old_value": { type: Sequelize.STRING(255) },
      "new_value": { type: Sequelize.STRING(255) },
      "at": { type: Sequelize.DATE, allowNull: false },
      "company_id": { type: Sequelize.INTEGER, references: { model: "Companies", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
      "by_user_id": { type: Sequelize.INTEGER, references: { model: "Users", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    });
    await queryInterface.createTable("BankHolidays", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "name": { type: Sequelize.STRING(255), allowNull: false },
      "date": { type: Sequelize.DATE, allowNull: false },
      "createdAt": { type: Sequelize.DATE, allowNull: false },
      "updatedAt": { type: Sequelize.DATE, allowNull: false },
      "companyId": { type: Sequelize.INTEGER, references: { model: "Companies", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    }, { indexes: [{"fields":["companyId"],"unique":false,"name":"bank_holidays_company_id"}] });
    await queryInterface.createTable("comment", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "entity_type": { type: Sequelize.STRING(255), allowNull: false },
      "entity_id": { type: Sequelize.INTEGER, allowNull: false },
      "comment": { type: Sequelize.STRING(255), allowNull: false },
      "at": { type: Sequelize.DATE, allowNull: false },
      "company_id": { type: Sequelize.INTEGER, references: { model: "Companies", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
      "by_user_id": { type: Sequelize.INTEGER, references: { model: "Users", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    });
    await queryInterface.createTable("DepartmentSupervisor", {
      "created_at": { type: Sequelize.DATE, allowNull: false },
      "department_id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, references: { model: "Departments", key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" },
      "user_id": { type: Sequelize.INTEGER, primaryKey: true, references: { model: "Users", key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" },
    }, { indexes: [{"fields":["department_id"],"unique":false,"name":"department_supervisor_department_id"},{"fields":["user_id"],"unique":false,"name":"department_supervisor_user_id"}] });
    await queryInterface.createTable("EmailAudit", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "email": { type: Sequelize.STRING(255), allowNull: false },
      "subject": { type: Sequelize.TEXT, allowNull: false },
      "body": { type: Sequelize.TEXT, allowNull: false },
      "created_at": { type: Sequelize.DATE, allowNull: false },
      "company_id": { type: Sequelize.INTEGER, references: { model: "Companies", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
      "user_id": { type: Sequelize.INTEGER, references: { model: "Users", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    }, { indexes: [{"fields":["created_at"],"unique":false,"name":"email_audit_created_at"},{"fields":["user_id"],"unique":false,"name":"email_audit_user_id"}] });
    await queryInterface.createTable("LeaveTypes", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "name": { type: Sequelize.STRING(255), allowNull: false },
      "color": { type: Sequelize.STRING(255), allowNull: false, defaultValue: "#ffffff" },
      "use_allowance": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      "limit": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      "sort_order": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      "auto_approve": { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      "createdAt": { type: Sequelize.DATE, allowNull: false },
      "updatedAt": { type: Sequelize.DATE, allowNull: false },
      "companyId": { type: Sequelize.INTEGER, references: { model: "Companies", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    });
    await queryInterface.createTable("Leaves", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "status": { type: Sequelize.INTEGER, allowNull: false },
      "employee_comment": { type: Sequelize.STRING(255) },
      "approver_comment": { type: Sequelize.STRING(255) },
      "decided_at": { type: Sequelize.DATE },
      "date_start": { type: Sequelize.DATE, allowNull: false },
      "day_part_start": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      "date_end": { type: Sequelize.DATE, allowNull: false },
      "day_part_end": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      "createdAt": { type: Sequelize.DATE, allowNull: false },
      "updatedAt": { type: Sequelize.DATE, allowNull: false },
      "userId": { type: Sequelize.INTEGER, references: { model: "Users", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
      "approverId": { type: Sequelize.INTEGER, references: { model: "Users", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
      "leaveTypeId": { type: Sequelize.INTEGER, references: { model: "LeaveTypes", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    }, { indexes: [{"fields":["userId"],"unique":false,"name":"leaves_user_id"},{"fields":["leaveTypeId"],"unique":false,"name":"leaves_leave_type_id"},{"fields":["approverId"],"unique":false,"name":"leaves_approver_id"}] });
    await queryInterface.createTable("schedule", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "monday": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      "tuesday": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      "wednesday": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      "thursday": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      "friday": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      "saturday": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 2 },
      "sunday": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 2 },
      "created_at": { type: Sequelize.DATE, allowNull: false },
      "updated_at": { type: Sequelize.DATE, allowNull: false },
      "company_id": { type: Sequelize.INTEGER, references: { model: "Companies", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
      "user_id": { type: Sequelize.INTEGER, references: { model: "Users", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    }, { indexes: [{"fields":["user_id"],"unique":false,"name":"schedule_user_id"},{"fields":["company_id"],"unique":false,"name":"schedule_company_id"}] });
    await queryInterface.createTable("user_allowance_adjustment", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "year": { type: Sequelize.INTEGER, allowNull: false, defaultValue: "2026" },
      "adjustment": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      "carried_over_allowance": { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      "created_at": { type: Sequelize.DATE, allowNull: false },
      "user_id": { type: Sequelize.INTEGER, references: { model: "Users", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    }, { indexes: [{"fields":["user_id","year"],"unique":true,"name":"user_allowance_adjustment_user_id_year"}] });
    await queryInterface.createTable("UserFeeds", {
      "id": { type: Sequelize.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true },
      "name": { type: Sequelize.STRING(255), allowNull: false },
      "feed_token": { type: Sequelize.STRING(255), allowNull: false },
      "type": { type: Sequelize.ENUM("calendar", "wallchart", "teamview", "company"), allowNull: false },
      "createdAt": { type: Sequelize.DATE, allowNull: false },
      "updatedAt": { type: Sequelize.DATE, allowNull: false },
      "userId": { type: Sequelize.INTEGER, references: { model: "Users", key: "id" }, onDelete: "SET NULL", onUpdate: "CASCADE" },
    });
    await queryInterface.createTable("Sessions", {
      "sid": { type: Sequelize.STRING, allowNull: false, primaryKey: true },
      "expires": { type: Sequelize.DATE },
      "data": { type: Sequelize.TEXT },
      "createdAt": { type: Sequelize.DATE, allowNull: false },
      "updatedAt": { type: Sequelize.DATE, allowNull: false },
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable("Sessions");
    await queryInterface.dropTable("UserFeeds");
    await queryInterface.dropTable("user_allowance_adjustment");
    await queryInterface.dropTable("schedule");
    await queryInterface.dropTable("Leaves");
    await queryInterface.dropTable("LeaveTypes");
    await queryInterface.dropTable("EmailAudit");
    await queryInterface.dropTable("DepartmentSupervisor");
    await queryInterface.dropTable("comment");
    await queryInterface.dropTable("BankHolidays");
    await queryInterface.dropTable("audit");
    await queryInterface.dropTable("Users");
    await queryInterface.dropTable("Departments");
    await queryInterface.dropTable("Companies");
  },
};
