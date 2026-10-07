// Recordings made in the browser are kept in IndexedDB until they are saved
// to the user's PDS. Chunks are written while recording, so a closed tab or a
// failed upload never loses audio.

import fixWebmDuration from 'fix-webm-duration'

export type Draft = {
  id: string
  /** When recording started; becomes the record's createdAt. */
  startedAt: string
  mimeType: string
  /** Recorded (unpaused) time so far. */
  durationMs: number
  /** False if recording was interrupted (e.g. the tab closed). */
  finished: boolean
  work: string
  chapter: string
  notes: string
}

type Chunk = { draftId: string; seq: number; blob: Blob }

const DB_NAME = 'voicebook-drafts'
const DRAFTS = 'drafts'
const CHUNKS = 'chunks'

let dbPromise: Promise<IDBDatabase> | undefined

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => {
      const db = open.result
      db.createObjectStore(DRAFTS, { keyPath: 'id' })
      db.createObjectStore(CHUNKS, { keyPath: ['draftId', 'seq'] }).createIndex('draftId', 'draftId')
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  return dbPromise
}

async function run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const tx = (await db()).transaction(stores, mode)
  const request = body(tx)
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(request ? request.result : undefined)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function createDraft(mimeType: string, fields: Pick<Draft, 'work' | 'chapter' | 'notes'>): Promise<Draft> {
  const draft: Draft = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    mimeType,
    durationMs: 0,
    finished: false,
    ...fields,
  }
  await run([DRAFTS], 'readwrite', (tx) => tx.objectStore(DRAFTS).put(draft))
  return draft
}

/** Stores one chunk and the duration recorded so far, atomically. */
export async function appendChunk(draft: Draft, seq: number, blob: Blob, durationMs: number): Promise<void> {
  await run([DRAFTS, CHUNKS], 'readwrite', (tx) => {
    tx.objectStore(CHUNKS).put({ draftId: draft.id, seq, blob } satisfies Chunk)
    tx.objectStore(DRAFTS).put({ ...draft, durationMs })
  })
}

export async function updateDraft(draft: Draft): Promise<void> {
  await run([DRAFTS], 'readwrite', (tx) => tx.objectStore(DRAFTS).put(draft))
}

export async function listDrafts(): Promise<Draft[]> {
  const drafts = (await run([DRAFTS], 'readonly', (tx) => tx.objectStore(DRAFTS).getAll() as IDBRequest<Draft[]>)) ?? []
  return drafts.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

/** The draft's audio as one file, with its duration written into the header. */
export async function draftAudio(draft: Draft): Promise<Blob> {
  const chunks =
    (await run([CHUNKS], 'readonly', (tx) => tx.objectStore(CHUNKS).index('draftId').getAll(draft.id) as IDBRequest<Chunk[]>)) ?? []
  chunks.sort((a, b) => a.seq - b.seq)
  const blob = new Blob(
    chunks.map((c) => c.blob),
    { type: draft.mimeType },
  )
  // Chrome's MediaRecorder writes WebM without a duration, which leaves
  // players unable to show a length or seek.
  if (draft.mimeType.startsWith('audio/webm') && draft.durationMs > 0) {
    return fixWebmDuration(blob, draft.durationMs, { logger: false })
  }
  return blob
}

export async function deleteDraft(id: string): Promise<void> {
  const keys =
    (await run([CHUNKS], 'readonly', (tx) => tx.objectStore(CHUNKS).index('draftId').getAllKeys(id))) ?? []
  await run([DRAFTS, CHUNKS], 'readwrite', (tx) => {
    tx.objectStore(DRAFTS).delete(id)
    for (const key of keys) tx.objectStore(CHUNKS).delete(key)
  })
}

export function fileExtension(mimeType: string): string {
  if (mimeType.startsWith('audio/webm')) return 'webm'
  if (mimeType.startsWith('audio/ogg')) return 'ogg'
  if (mimeType.startsWith('audio/mp4')) return 'm4a'
  return 'audio'
}
