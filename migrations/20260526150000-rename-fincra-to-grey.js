'use strict';

var fs = require('fs');
var path = require('path');

function runSql(db, filename) {
  var filePath = path.join(__dirname, 'sqls', filename);
  return new Promise(function (resolve, reject) {
    fs.readFile(filePath, { encoding: 'utf-8' }, function (err, data) {
      if (err) return reject(err);
      db.runSql(data).then(resolve).catch(reject);
    });
  });
}

exports.up = function (db) {
  return runSql(db, '20260526150000-rename-fincra-to-grey-up.sql');
};

exports.down = function (db) {
  return runSql(db, '20260526150000-rename-fincra-to-grey-down.sql');
};

exports._meta = { version: 1 };
