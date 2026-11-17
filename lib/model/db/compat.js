'use strict';

/*
 * Sequelize 6 compatibility adapter (transitional).
 *
 * The legacy models are written in Sequelize 3 style:
 *   sequelize.define(name, attrs, { classMethods, instanceMethods, indexes })
 *   Model.find / Model.findById, this.Model, string operators ($ne, $or, ...).
 *
 * Rather than rewrite 13 models + mixins + ~10.8k LOC of functional logic at
 * once (high regression risk), this adapter lets that functional code run on
 * Sequelize 6 unchanged:
 *   - define(): attaches classMethods as statics and instanceMethods on the
 *     prototype (v6 dropped these options).
 *   - find -> findOne, findById -> findByPk aliases.
 *   - instance.Model getter -> this.constructor (v3 `this.Model`).
 *   - sequelize.import() shim.
 *   - string operators are enabled via the constructor `operatorsAliases` map
 *     (see OP_MAP) so legacy `$ne/$or/...` queries keep working, including on
 *     scoped models and nested includes.
 *
 * THIS IS A TRANSITIONAL BRIDGE. New models MUST use Sequelize 6 idioms
 * (class extends Model / sequelize.define without classMethods, Op symbols,
 * findOne/findByPk). Removal plan: docs/MODERNIZATION_PLAN.md.
 */

const { Op } = require('sequelize');

// Legacy string-operator -> Sequelize 6 Op symbol map.
const OP_MAP = {
  $ne: Op.ne, $eq: Op.eq, $gt: Op.gt, $gte: Op.gte, $lt: Op.lt, $lte: Op.lte,
  $in: Op.in, $notIn: Op.notIn, $not: Op.not, $or: Op.or, $and: Op.and,
  $like: Op.like, $notLike: Op.notLike, $iLike: Op.iLike, $notILike: Op.notILike,
  $between: Op.between, $notBetween: Op.notBetween,
  $contains: Op.contains, $contained: Op.contained, $overlap: Op.overlap,
  $startsWith: Op.startsWith, $endsWith: Op.endsWith, $substring: Op.substring,
  $col: Op.col, $regexp: Op.regexp, $notRegexp: Op.notRegexp,
  $any: Op.any, $all: Op.all, $is: Op.is,
};

function install(sequelize) {
  const origDefine = sequelize.define.bind(sequelize);

  sequelize.define = function (name, attributes, options = {}) {
    const { classMethods, instanceMethods, ...rest } = options;
    const Model = origDefine(name, attributes, rest);

    if (classMethods) Object.assign(Model, classMethods);
    if (instanceMethods) Object.assign(Model.prototype, instanceMethods);

    // v3 finder aliases.
    if (!Model.find) Model.find = Model.findOne;
    if (!Model.findById) Model.findById = Model.findByPk;

    // v3 `this.Model` / `self.Model` reference.
    if (!Object.getOwnPropertyDescriptor(Model.prototype, 'Model')) {
      Object.defineProperty(Model.prototype, 'Model', {
        get() { return this.constructor; },
        configurable: true,
      });
    }
    return Model;
  };

  // v3 sequelize.import(path) -> module(sequelize, DataTypes).
  sequelize.import = function (modelPath) {
    const define = require(modelPath);
    return define(sequelize, require('sequelize').DataTypes);
  };

  return sequelize;
}

module.exports = { install, OP_MAP, enableScopeGetters };

/*
 * Sequelize 3 allowed passing `{ scope: [...] }` to association getters
 * (e.g. user.getCompany({ scope: ['with_leave_types'] })). Sequelize 6 ignores
 * that option. This wraps every association getter so a `scope` option is
 * resolved against the target model's scopes and merged into include/where/order,
 * preserving the legacy call sites unchanged. Transitional bridge.
 */
function enableScopeGetters(sequelize) {
  for (const modelName of Object.keys(sequelize.models)) {
    const Model = sequelize.models[modelName];
    const associations = Model.associations || {};
    for (const assocName of Object.keys(associations)) {
      const assoc = associations[assocName];
      const getter = assoc.accessors && assoc.accessors.get;
      if (!getter || typeof Model.prototype[getter] !== 'function') continue;
      if (Model.prototype[getter].__scopeWrapped) continue;
      const orig = Model.prototype[getter];
      const target = assoc.target;

      const wrapped = function (options, ...rest) {
        if (options && options.scope) {
          const names = Array.isArray(options.scope) ? options.scope : [options.scope];
          const mergedInclude = [];
          const mergedOrder = [];
          let mergedWhere = null;
          for (const n of names) {
            let sc = target.options.scopes && target.options.scopes[n];
            if (typeof sc === 'function') sc = sc();
            if (!sc) continue;
            if (sc.include) mergedInclude.push(...(Array.isArray(sc.include) ? sc.include : [sc.include]));
            if (sc.order) mergedOrder.push(...(Array.isArray(sc.order) ? sc.order : [sc.order]));
            if (sc.where) mergedWhere = Object.assign(mergedWhere || {}, sc.where);
          }
          const newOpts = Object.assign({}, options);
          delete newOpts.scope;
          if (mergedInclude.length) {
            const existing = options.include ? (Array.isArray(options.include) ? options.include : [options.include]) : [];
            newOpts.include = [...existing, ...mergedInclude];
          }
          if (mergedOrder.length) newOpts.order = [...(options.order || []), ...mergedOrder];
          if (mergedWhere) newOpts.where = Object.assign({}, options.where || {}, mergedWhere);
          return orig.call(this, newOpts, ...rest);
        }
        return orig.call(this, options, ...rest);
      };
      wrapped.__scopeWrapped = true;
      Model.prototype[getter] = wrapped;
    }
  }
}
