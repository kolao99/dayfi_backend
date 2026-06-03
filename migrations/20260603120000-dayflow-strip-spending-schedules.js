'use strict';

var dbm;
var type;
var seed;

exports.setup = function (options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
};

exports.up = function (db) {
  return db.runSql(
    require('fs').readFileSync(
      __dirname + '/sqls/20260603120000-dayflow-strip-spending-schedules-up.sql',
      'utf8'
    )
  );
};

exports.down = function (db) {
  return db.runSql(
    require('fs').readFileSync(
      __dirname +
        '/sqls/20260603120000-dayflow-strip-spending-schedules-down.sql',
      'utf8'
    )
  );
};

exports._meta = {
  version: 1,
};
