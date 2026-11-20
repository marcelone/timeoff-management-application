
"use strict";

const
  Joi       = require('joi'),
  Exception = require('../../error'),
  Models    = require('../db');

const
  schemaPromiseToRemove = Joi.object().required().keys({
    company     : Joi.object().required(), //.type(Models.Company.constructor),
    byUser      : Joi.object().required(), //.type(Models.User.constructor),
    confirmName : Joi.string().required().trim(),
  });


class CompanyRemover {

  static promiseToRemove(args){

    args = Joi.attempt(
      args,
      schemaPromiseToRemove,
      "Param validation failed for promiseToRemove"
    );

    const
      company      = args.company,
      byUser       = args.byUser,
      confirmName  = args.confirmName;

    // Ensure that confirm name is correct
    let normalizedNames = [company.name, confirmName]
      .map(s => s.trim())
      .map(s => s.replace(/\s+/g, ''))
      .map(s => s.toUpperCase());

    if (normalizedNames[0] !== normalizedNames[1]) {
      Exception.throw_user_error({
        system_error : `Confirmed name does not match one on company record: ${ normalizedNames.join(', ') }`,
        user_error   : `Provided name confirmation does not match company one`,
      });
    }

    return Models.sequelize.transaction(async (transaction) => {
      const count = await Models.User.count({
        where : {
          id        : byUser.id,
          companyId : company.id,
          admin     : true,
        }, transaction,
      });
      if (count === 0) {
        Exception.throw_user_error({
          system_error : `An attempt to remove company [${company.id}] by unrelated user [${byUser.id }]`,
          user_error : `User does not have permissions to remove company`,
        });
      }
      const users = await company.getUsers({ transaction });
      await Models.EmailAudit.destroy({ where: { company_id: company.id }, transaction });
      for (const user of users) {
        await Models.Leave.destroy({ where: { userId: user.id }, transaction });
      }
      // Every deletion belongs to the same transaction: a later FK failure
      // must never leave an existing company without its clock history.
      for (const model of [Models.TimeCorrection, Models.TimeEntryEvent,
        Models.TimeBreak, Models.TimeEntry, Models.WorkScheduleDay,
        Models.TimeCorrectionPolicy, Models.BreakPolicy]) {
        await model.destroy({ where: { companyId: company.id }, transaction });
      }
      await Models.User.destroy({ where: { companyId: company.id }, transaction });
      await Models.WorkCenter.destroy({ where: { companyId: company.id }, transaction });
      return company.destroy({ transaction });
    });
  }
}

module.exports = CompanyRemover;
