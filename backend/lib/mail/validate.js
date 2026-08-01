'use strict';
// ============================================================
//  TecXPaneL — lib/mail/validate.js — validadores de email/dominio/contraseña
// ============================================================

function isValidEmail(addr) {
  if (typeof addr !== 'string') return false;
  if (/[\s\n\r]/.test(addr)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

function isValidMailDomain(d) {
  if (typeof d !== 'string' || /[\s\n\r]/.test(d)) return false;
  return /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/.test(d);
}

function isValidMailPassword(p) {
  return typeof p === 'string' && p.length >= 6 && !/[\s\n\r]/.test(p);
}

module.exports = { isValidEmail, isValidMailDomain, isValidMailPassword };