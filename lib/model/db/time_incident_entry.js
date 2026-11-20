'use strict';

/*
 * TimeIncidentEntry — one entry of the activity thread of an incident (block 4).
 *
 * APPEND-ONLY BY DESIGN: the service only ever INSERTs an entry. Nothing updates
 * it, nothing deletes it, and the routes expose no edit or delete action. The
 * original message of the employee, the answers of the responsible person and
 * every state change stay exactly as they were written, so the conversation can
 * always be reconstructed.
 *
 *   kind = 'comment'    -> text written by a participant
 *   kind = 'in_review'  -> the incident was taken into review
 *   kind = 'resolved'   -> resolved, with the answer as body
 *   kind = 'dismissed'  -> dismissed, with the reason as body
 *   kind = 'link'       -> a correction request of block 3 was linked
 *
 * `body` is plain text (never HTML): the templates render it escaped and honour
 * the line breaks with CSS, so no rich-text editor and no markup are needed.
 * `fromStatus` / `toStatus` describe the transition when the entry is a state
 * change, which is what makes the thread self-explanatory.
 *
 * The entry carries its own `companyId` so the composite foreign key
 * (incidentId, companyId) can make a cross-company thread impossible.
 */

const ENTRY_KINDS = ['comment', 'in_review', 'resolved', 'dismissed', 'link'];

module.exports = function (sequelize, DataTypes) {
  const TimeIncidentEntry = sequelize.define('TimeIncidentEntry', {
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    incidentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    authorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    kind: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [ENTRY_KINDS] },
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    fromStatus: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    toStatus: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  }, {
    underscored: true,
    freezeTableName: true,
    tableName: 'time_incident_entries',
    // `at` is the business instant; created_at is the row timestamp. Both are
    // kept so the ordering never depends on the database clock alone.
    timestamps: true,

    indexes: [
      { fields: ['incident_id', 'at', 'id'] },
      { fields: ['company_id'] },
      { fields: ['author_id'] },
      { fields: ['kind'] },
    ],

    classMethods: {
      associate: function (models) {
        TimeIncidentEntry.belongsTo(models.Company, { as: 'company', foreignKey: 'companyId' });
        TimeIncidentEntry.belongsTo(models.TimeIncident, {
          as: 'incident', foreignKey: 'incidentId',
        });
        TimeIncidentEntry.belongsTo(models.User, { as: 'author', foreignKey: 'authorId' });
      },
      kinds: function () { return ENTRY_KINDS.slice(); },
    },
  });

  TimeIncidentEntry.ENTRY_KINDS = ENTRY_KINDS;

  return TimeIncidentEntry;
};