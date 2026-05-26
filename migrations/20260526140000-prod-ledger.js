'use strict';

var fs = require('fs');
var path = require('path');

exports.up = function (db) {
  var filePath = path.join(
    __dirname,
    'sqls',
    '20260526140000-prod-ledger-up.sql'
  );
  return new Promise(function (resolve, reject) {
    fs.readFile(filePath, { encoding: 'utf-8' }, function (err, data) {
      if (err) return reject(err);
      db.runSql(data).then(resolve).catch(reject);
    });
  });
};

exports.down = function (db) {
  var filePath = path.join(
    __dirname,
    'sqls',
    '20260526140000-prod-ledger-down.sql'
  );
  return new Promise(function (resolve, reject) {
    fs.readFile(filePath, { encoding: 'utf-8' }, function (err, data) {
      if (err) return reject(err);
      db.runSql(data).then(resolve).catch(reject);
    });
  });
};

exports._meta = { version: 1 };
