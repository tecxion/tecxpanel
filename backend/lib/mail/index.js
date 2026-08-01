'use strict';
// ============================================================
//  TecXPaneL — lib/mail/index.js — reexporta API plana v1
// ============================================================

const config = require('./config');
const validate = require('./validate');
const setup = require('./setup');
const dns = require('./dns');
const webmail = require('./webmail');

module.exports = {
  ...config,
  ...validate,
  ...setup,
  ...dns,
  ...webmail,
};