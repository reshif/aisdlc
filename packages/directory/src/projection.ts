import {
  IDENTITY_EVENT,
  PrincipalCreatedPayload,
  PrincipalStatusChangedPayload,
  PrincipalUpdatedPayload,
  TeamCreatedPayload,
  TeamUpdatedPayload,
  type RecordEvent,
} from '@aisdlc/contracts';
import type { Executor, Projection, Tx } from '@aisdlc/record';

// The directory read models (PLAN M4.2, DM §8 gap 10): `Principal(handle, display, kind, status)`
// and `Team(id, name, idp_group?)`, folded from the identity journal on the record. Core reads
// these for name resolution and pickers instead of calling identity. They hold no access
// information (memberships and bindings stay in identity); only what a name lookup needs.

const idOf = (stream: string): string => stream.slice(stream.indexOf(':') + 1);

async function applyPrincipal(tx: Tx, e: RecordEvent): Promise<void> {
  const id = idOf(e.stream_id);
  if (e.type === IDENTITY_EVENT.principal_created) {
    const p = PrincipalCreatedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO directory.principal (principal_id, handle, display, kind, status)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (principal_id) DO NOTHING`,
      [p.principal_id, p.display_handle, p.display_name, p.kind, p.status],
    );
  } else if (e.type === IDENTITY_EVENT.principal_updated) {
    const u = PrincipalUpdatedPayload.parse(e.payload);
    if (u.display_handle !== undefined) {
      await tx.query('UPDATE directory.principal SET handle = $2 WHERE principal_id = $1', [
        id,
        u.display_handle,
      ]);
    }
    if (u.display_name !== undefined) {
      await tx.query('UPDATE directory.principal SET display = $2 WHERE principal_id = $1', [
        id,
        u.display_name,
      ]);
    }
  } else if (e.type === IDENTITY_EVENT.principal_status_changed) {
    const s = PrincipalStatusChangedPayload.parse(e.payload);
    await tx.query('UPDATE directory.principal SET status = $2 WHERE principal_id = $1', [
      id,
      s.status,
    ]);
  }
}

async function applyTeam(tx: Tx, e: RecordEvent): Promise<void> {
  const id = idOf(e.stream_id);
  if (e.type === IDENTITY_EVENT.team_created) {
    const t = TeamCreatedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO directory.team (team_id, name, classification, idp_group)
       VALUES ($1,$2,$3,$4) ON CONFLICT (team_id) DO NOTHING`,
      [t.team_id, t.name, t.classification, t.idp_group],
    );
  } else if (e.type === IDENTITY_EVENT.team_updated) {
    const u = TeamUpdatedPayload.parse(e.payload);
    if (u.name !== undefined) {
      await tx.query('UPDATE directory.team SET name = $2 WHERE team_id = $1', [id, u.name]);
    }
    if (u.classification !== undefined) {
      await tx.query('UPDATE directory.team SET classification = $2 WHERE team_id = $1', [
        id,
        u.classification,
      ]);
    }
    if (u.idp_group !== undefined) {
      await tx.query('UPDATE directory.team SET idp_group = $2 WHERE team_id = $1', [
        id,
        u.idp_group,
      ]);
    }
  }
}

export interface DirectorySnapshot {
  principals: unknown[];
  teams: unknown[];
}

export const directoryProjection: Projection<DirectorySnapshot> = {
  name: 'directory',
  version: 1,
  tables: ['directory.principal', 'directory.team'],

  async apply(tx, event) {
    if (event.stream_id.startsWith('principal:')) await applyPrincipal(tx, event);
    else if (event.stream_id.startsWith('team:')) await applyTeam(tx, event);
  },

  async reset(tx) {
    await tx.query('DELETE FROM directory.principal');
    await tx.query('DELETE FROM directory.team');
  },

  async snapshot(db: Executor) {
    const q = async (sql: string) => (await db.query(sql)).rows;
    return {
      principals: await q('SELECT * FROM directory.principal ORDER BY principal_id'),
      teams: await q('SELECT * FROM directory.team ORDER BY team_id'),
    };
  },
};
