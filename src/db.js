'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

class Database {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new sqlite3.Database(file);
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
  }

  async init() {
    await this.run('PRAGMA journal_mode=WAL');
    await this.run('PRAGMA foreign_keys=ON');
    await this.run(`CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await this.run(`CREATE TABLE IF NOT EXISTS topup_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      receipt_chat_id TEXT,
      receipt_message_id INTEGER,
      reviewed_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT,
      FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
    )`);
    await this.run(`CREATE TABLE IF NOT EXISTS servers (
      server_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      duration TEXT NOT NULL,
      sale_price INTEGER NOT NULL,
      upstream_price INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'provisioning',
      public_ip TEXT,
      pending_password TEXT,
      credentials_delivered INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      FOREIGN KEY(owner_id) REFERENCES users(telegram_id)
    )`);
    await this.run('CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id, deleted_at)');
    await this.run('CREATE INDEX IF NOT EXISTS idx_topups_status ON topup_requests(status, id)');
  }

  async touchUser(user) {
    const id = String(user.id);
    await this.run(`INSERT INTO users(telegram_id, username, first_name)
      VALUES(?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username=excluded.username,
        first_name=excluded.first_name,
        updated_at=CURRENT_TIMESTAMP`, [id, user.username || null, user.first_name || null]);
    return this.getUser(id);
  }

  getUser(id) { return this.get('SELECT * FROM users WHERE telegram_id=?', [String(id)]); }

  async credit(id, amount) {
    await this.run('UPDATE users SET balance=balance+?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?', [Math.round(amount), String(id)]);
    return this.getUser(id);
  }

  async debitIfEnough(id, amount) {
    const result = await this.run(
      'UPDATE users SET balance=balance-?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=? AND balance>=?',
      [Math.round(amount), String(id), Math.round(amount)]
    );
    return result.changes === 1;
  }

  async createTopup(id, amount, receiptChatId, receiptMessageId) {
    const out = await this.run(
      'INSERT INTO topup_requests(telegram_id, amount, receipt_chat_id, receipt_message_id) VALUES(?,?,?,?)',
      [String(id), Math.round(amount), String(receiptChatId), Number(receiptMessageId)]
    );
    return this.get('SELECT * FROM topup_requests WHERE id=?', [out.lastID]);
  }

  pendingTopups(limit = 20) {
    return this.all(`SELECT t.*, u.username, u.first_name FROM topup_requests t
      LEFT JOIN users u ON u.telegram_id=t.telegram_id
      WHERE t.status='pending' ORDER BY t.id ASC LIMIT ?`, [Number(limit)]);
  }

  async reviewTopup(id, status, adminId) {
    if (!['approved', 'rejected'].includes(status)) throw new Error('invalid topup status');
    await this.run('BEGIN IMMEDIATE');
    try {
      const row = await this.get('SELECT * FROM topup_requests WHERE id=?', [Number(id)]);
      if (!row || row.status !== 'pending') {
        await this.run('ROLLBACK');
        return { changed: false, request: row };
      }
      await this.run(
        `UPDATE topup_requests SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`,
        [status, String(adminId), Number(id)]
      );
      if (status === 'approved') {
        await this.run('UPDATE users SET balance=balance+?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?', [row.amount, row.telegram_id]);
      }
      await this.run('COMMIT');
      return { changed: true, request: { ...row, status } };
    } catch (error) {
      await this.run('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  async addServer({ serverId, ownerId, planId, duration, salePrice, upstreamPrice, status, publicIp }) {
    await this.run(`INSERT INTO servers(server_id, owner_id, plan_id, duration, sale_price, upstream_price, status, public_ip)
      VALUES(?,?,?,?,?,?,?,?)`, [String(serverId), String(ownerId), planId, duration, Math.round(salePrice), Math.round(upstreamPrice || 0), status || 'provisioning', publicIp || null]);
    return this.getServer(serverId);
  }

  getServer(id) { return this.get('SELECT * FROM servers WHERE server_id=?', [String(id)]); }

  async getOwnedServer(id, ownerId) {
    return this.get('SELECT * FROM servers WHERE server_id=? AND owner_id=? AND deleted_at IS NULL', [String(id), String(ownerId)]);
  }

  listUserServers(ownerId) {
    return this.all('SELECT * FROM servers WHERE owner_id=? AND deleted_at IS NULL ORDER BY created_at DESC', [String(ownerId)]);
  }

  pendingProvisioning() {
    return this.all(`SELECT * FROM servers
      WHERE deleted_at IS NULL AND credentials_delivered=0
      ORDER BY created_at ASC LIMIT 50`);
  }

  async updateServerState(id, { status, publicIp } = {}) {
    if (status !== undefined) await this.run('UPDATE servers SET status=? WHERE server_id=?', [status, String(id)]);
    if (publicIp !== undefined) await this.run('UPDATE servers SET public_ip=? WHERE server_id=?', [publicIp || null, String(id)]);
  }

  async savePendingPassword(id, password) {
    await this.run('UPDATE servers SET pending_password=? WHERE server_id=?', [String(password), String(id)]);
  }

  async markCredentialsDelivered(id) {
    await this.run('UPDATE servers SET credentials_delivered=1, pending_password=NULL, status=CASE WHEN status="provisioning" THEN "active" ELSE status END WHERE server_id=?', [String(id)]);
  }

  async markDeleted(id) {
    await this.run('UPDATE servers SET status="deleted", deleted_at=CURRENT_TIMESTAMP, pending_password=NULL WHERE server_id=?', [String(id)]);
  }

  async stats() {
    const users = await this.get('SELECT COUNT(*) AS n, COALESCE(SUM(balance),0) AS balance FROM users');
    const servers = await this.get('SELECT COUNT(*) AS n FROM servers WHERE deleted_at IS NULL');
    const pending = await this.get('SELECT COUNT(*) AS n FROM topup_requests WHERE status="pending"');
    return { users: users?.n || 0, localBalance: users?.balance || 0, servers: servers?.n || 0, pendingTopups: pending?.n || 0 };
  }

  close() { return new Promise(resolve => this.db.close(() => resolve())); }
}

module.exports = Database;
