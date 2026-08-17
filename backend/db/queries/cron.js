'use strict';

// queries/cron.js — tareas programadas (fuente de la verdad para el crontab de root).
const { db } = require('../client');

module.exports = {
  listCronJobs:       db.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC'),
  getCronJob:         db.prepare('SELECT * FROM cron_jobs WHERE id = ?'),
  insertCronJob:      db.prepare(`
    INSERT INTO cron_jobs (name, command, minute, hour, dom, month, dow, enabled)
    VALUES (@name, @command, @minute, @hour, @dom, @month, @dow, @enabled)`),
  insertCronJobWithId: db.prepare(`
    INSERT INTO cron_jobs (id, name, command, minute, hour, dom, month, dow, enabled, created_at)
    VALUES (@id, @name, @command, @minute, @hour, @dom, @month, @dow, @enabled, @created_at)`),
  updateCronJob:      db.prepare(`
    UPDATE cron_jobs SET name=@name, command=@command, minute=@minute, hour=@hour,
      dom=@dom, month=@month, dow=@dow, enabled=@enabled WHERE id=@id`),
  setCronJobEnabled:  db.prepare('UPDATE cron_jobs SET enabled=@enabled WHERE id=@id'),
  deleteCronJob:      db.prepare('DELETE FROM cron_jobs WHERE id = ?'),
};
