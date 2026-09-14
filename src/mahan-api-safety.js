'use strict';

// The grace-expiry worker must never hide a local server if the upstream
// deletion failed. Track delete outcome across the shared CoreApi/Database
// prototypes so markDeleted only proceeds after a confirmed delete (or an
// already-absent upstream server).
const Database = require('./db');
const { CoreApi } = require('./core-api');

const deleteOutcome = new Map();
const originalDelete = CoreApi.prototype.deleteServer;
const originalMarkDeleted = Database.prototype.markDeleted;

CoreApi.prototype.deleteServer = async function guardedDeleteServer(serverId) {
  const id = String(serverId);
  try {
    const result = await originalDelete.call(this, serverId);
    deleteOutcome.set(id, 'ok');
    return result;
  } catch (error) {
    if (error && error.code === 'SERVER_NOT_FOUND') {
      deleteOutcome.set(id, 'ok');
      return { ok: true, already_absent: true };
    }
    deleteOutcome.set(id, 'failed');
    throw error;
  }
};

Database.prototype.markDeleted = async function guardedMarkDeleted(serverId) {
  const id = String(serverId);
  const outcome = deleteOutcome.get(id);
  deleteOutcome.delete(id);
  if (outcome === 'failed') {
    console.error('[mahan-delete-safety] upstream delete failed; local server kept visible', { server_id: id });
    const error = new Error('UPSTREAM_DELETE_NOT_CONFIRMED');
    error.code = 'UPSTREAM_DELETE_NOT_CONFIRMED';
    throw error;
  }
  return originalMarkDeleted.call(this, serverId);
};
