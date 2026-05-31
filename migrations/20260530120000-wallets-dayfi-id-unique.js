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
      __dirname + '/sqls/20260530120000-wallets-dayfi-id-unique-up.sql',
      'utf8'
    )
  );
};

exports.down = function (db) {
  return db.runSql(
    require('fs').readFileSync(
      __dirname + '/sqls/20260530120000-wallets-dayfi-id-unique-down.sql',
      'utf8'
    )
  );
};

exports._meta = {
  version: 1,
};
