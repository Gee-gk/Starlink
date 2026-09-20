'use strict';

/**
 * Audit-log file writer: append, rotation and retention pruning.
 *
 * This module owns the only place that touches the audit-log file on disk.
 * security.js keeps the thin, semantic event helpers (logAuth, logPaymentRequest
 * …) and delegates the I/O here, so the storage policy can be reasoned about
 * independently of the audit vocabulary.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'logs', 'audit.log');
const ROTATE_BYTES = parseInt(process.env.AUDIT_ROTATE_BYTES || String(10 * 1024 * 1024), 10);
const RETAIN_DAYS = parseInt(process.env.AUDIT_RETAIN_DAYS || '30', 10);
const ARCHIVE_PATTERN = /^audit-(\d{4}-\d{2}-\d{2})\d*(?:\.\d+)?\.log$/;

/** Ensures the log directory exists. Safe to call repeatedly. */
function init() {
    const logDir = path.dirname(FILE);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
}

/** Appends one JSON line. Never throws — a log failure must not break a request. */
function append(entry) {
    try {
        fs.appendFileSync(FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
        console.error('Audit log write failed:', err.message);
    }
}

/** Deletes archived logs older than RETAIN_DAYS. @returns {number} removed count. */
function pruneArchived() {
    const logDir = path.dirname(FILE);
    const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of fs.readdirSync(logDir)) {
        const match = ARCHIVE_PATTERN.exec(name);
        if (!match) continue;
        if (new Date(`${match[1]}T00:00:00.000Z`).getTime() >= cutoff) continue;
        try {
            fs.unlinkSync(path.join(logDir, name));
            removed++;
        } catch (err) {
            console.error('Audit archive cleanup failed:', err.message);
        }
    }
    return removed;
}

/**
 * Rotates by renaming the completed file aside and letting the writer create a
 * fresh active log. This never rewrites the live file, so lines appended while
 * rotation runs cannot be lost.
 */
function rotate() {
    try {
        if (!fs.existsSync(FILE)) return;
        if (fs.statSync(FILE).size < ROTATE_BYTES) return;

        const date = new Date().toISOString().slice(0, 10);
        const dir = path.dirname(FILE);
        let target = path.join(dir, `audit-${date}.log`);
        for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `audit-${date}.${i}.log`);

        fs.renameSync(FILE, target);
        const pruned = pruneArchived();
        console.log(`Rotated audit log -> ${path.basename(target)}${pruned ? ` (pruned ${pruned} old archive(s))` : ''}`);
    } catch (err) {
        console.error('Audit log rotation failed:', err.message);
    }
}

init();
setInterval(rotate, 24 * 60 * 60 * 1000).unref?.();

module.exports = { FILE, init, append, pruneArchived, rotate };
