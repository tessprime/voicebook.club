// Local ATProto network for Voicebook development: a PLC directory and a PDS,
// seeded with a few test accounts and follow edges.
//
// State is ephemeral: the PLC keeps DIDs in memory and the PDS uses temp dirs,
// so every restart produces fresh DIDs. The current accounts are written to
// localnet.json for the backend and scripts to read.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestNetworkNoAppView, mockMailer } from '@atproto/dev-env'

const PLC_PORT = 2582
const PDS_PORT = 2583
const PASSWORD = 'password'

const ACCOUNTS = ['alice', 'bob', 'carol', 'dave']

// [actor, subject]. dave is a Bluesky user who never uses Voicebook.
const FOLLOWS = [
  ['alice', 'bob'],
  ['alice', 'carol'],
  ['alice', 'dave'],
  ['bob', 'alice'],
  ['carol', 'bob'],
]

const here = path.dirname(fileURLToPath(import.meta.url))
const statePath = path.join(here, 'localnet.json')

const network = await TestNetworkNoAppView.create({
  plc: { port: PLC_PORT },
  pds: { port: PDS_PORT, hostname: 'localhost' },
})
mockMailer(network.pds)

const accounts = {}
for (const name of ACCOUNTS) {
  const handle = `${name}.test`
  const agent = network.pds.getAgent()
  const res = await agent.createAccount({
    handle,
    email: `${name}@example.test`,
    password: PASSWORD,
  })
  accounts[name] = { handle, did: res.data.did, password: PASSWORD, agent }
}

for (const [actor, subject] of FOLLOWS) {
  const { agent, did } = accounts[actor]
  await agent.com.atproto.repo.createRecord({
    repo: did,
    collection: 'app.bsky.graph.follow',
    record: {
      $type: 'app.bsky.graph.follow',
      subject: accounts[subject].did,
      createdAt: new Date().toISOString(),
    },
  })
}

const state = {
  plcUrl: network.plc.url,
  pdsUrl: network.pds.url,
  startedAt: new Date().toISOString(),
  accounts: Object.fromEntries(
    Object.entries(accounts).map(([name, { handle, did, password }]) => [
      name,
      { handle, did, password },
    ]),
  ),
  follows: FOLLOWS,
}
await fs.writeFile(statePath, JSON.stringify(state, null, 2) + '\n')

console.log(`PLC  ${network.plc.url}`)
console.log(`PDS  ${network.pds.url}`)
for (const [name, { handle, did }] of Object.entries(accounts)) {
  console.log(`  ${name.padEnd(6)} ${handle.padEnd(11)} ${did}`)
}
console.log(`password for all accounts: ${PASSWORD}`)
console.log(`wrote ${path.relative(process.cwd(), statePath)}`)
console.log('localnet ready (Ctrl-C to stop)')

const shutdown = async () => {
  await network.close()
  await fs.rm(statePath, { force: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
