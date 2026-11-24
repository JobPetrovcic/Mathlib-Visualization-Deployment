// Lazily loaded graph data; the format is described in convert_to_js.py.
// graph_data.js (loaded before this file) defines graphManifest; node tables ("n"), out-neighbour
// lists ("a"), in-neighbour lists ("r") and the full name list ("names") are fetched per chunk of
// chunkSize node ids by inserting <script> tags, so the page also works from file://.
const graphDataDir = 'graph_data/' // next to graph_data.js, relative to the page
const chunkSize = graphManifest.chunkSize
const numberOfNodes = graphManifest.nodeCount

var nodes = new Array(numberOfNodes) // node objects, created when their "n" chunk arrives
var shownNodes = []
const nodeChunks = [], adjacencyChunks = [], reverseChunks = []
var allNames = null
const chunkPromises = new Map()   // "kind_k" -> Promise
const chunkResolvers = new Map()
const extraNeighbours = new Map() // id -> [ids] added by InitiallyConnect

function chunkOf(id) {
  return Math.floor(id / chunkSize)
}

// called by every loaded chunk file
function graphChunk(kind, k, payload) {
  if (kind == 'n') {
    nodeChunks[k] = payload
    createNodes(k, payload)
  } else if (kind == 'a') {
    adjacencyChunks[k] = payload
  } else if (kind == 'r') {
    reverseChunks[k] = payload
  } else if (kind == 'names') {
    allNames = payload
  }
  const key = kind + '_' + k
  if (chunkResolvers.has(key)) {
    chunkResolvers.get(key)()
    chunkResolvers.delete(key)
  }
}

function loadChunk(kind, k) {
  const key = kind + '_' + k
  if (chunkPromises.has(key)) return chunkPromises.get(key)
  const promise = new Promise((resolve, reject) => {
    chunkResolvers.set(key, resolve)
    const script = document.createElement('script')
    script.src = graphDataDir + key + '.js'
    script.onerror = () => reject(new Error('could not load ' + script.src))
    document.head.appendChild(script)
  })
  chunkPromises.set(key, promise)
  return promise
}

function createNodes(k, table) {
  const base = k * chunkSize
  for (let j = 0; j < table.name.length; j++) {
    const node = {
      id: base + j,
      name: table.name[j],
      label: graphManifest.labels[table.label[j]],
      parent: table.parent[j],
      nchild: table.nchild[j],
      shown: false,
      expanded: false,
      removed: false,
      numberOfExpandedParents: 0,
      children: [],
      x: 0, y: 0, x0: 0, y0: 0,
    }
    for (const key of graphManifest.stats) node[key] = table[key][j]
    if (InitiallyRemoveNodes.includes(node.name)) node.removed = true
    nodes[base + j] = node
  }
}

// make sure the node objects for these ids exist
function ensureNodes(ids) {
  const needed = new Set()
  for (const id of ids) if (nodes[id] === undefined) needed.add(chunkOf(id))
  return Promise.all([...needed].map(k => loadChunk('n', k)))
}

function ensureAdjacency(u) {
  const k = chunkOf(u)
  return adjacencyChunks[k] ? Promise.resolve() : loadChunk('a', k)
}

function ensureReverse(u) {
  const k = chunkOf(u)
  return reverseChunks[k] ? Promise.resolve() : loadChunk('r', k)
}

function ensureAllNames() {
  return allNames ? Promise.resolve() : loadChunk('names', 0)
}

function csrRow(chunks, u) {
  const c = chunks[chunkOf(u)]
  const j = u % chunkSize
  return c.t.slice(c.o[j], c.o[j + 1])
}

// out-neighbours of u (its adjacency chunk must be loaded)
function neighbours(u) {
  const out = csrRow(adjacencyChunks, u)
  const extra = extraNeighbours.get(u)
  return extra ? out.concat(extra) : out
}

// in-neighbours of u (its reverse chunk must be loaded)
function reverseNeighbours(u) {
  return csrRow(reverseChunks, u)
}

// roots: nodes without incoming edges; the main library is first
var roots = graphManifest.roots.map(r => r.id)
var rootid = graphManifest.root
if (typeof rootName !== 'undefined') {
  const named = graphManifest.roots.find(r => r.name == rootName)
  if (named) rootid = named.id
}

// library specific connections (see librarySpecificSettings.js): u -> v by node name
async function applyInitiallyConnect() {
  if (InitiallyConnect.length == 0) return
  function findLoaded(name) {
    for (const node of nodes) if (node !== undefined && node.name == name) return node.id
    return -1
  }
  for (const [uName, vName] of InitiallyConnect) {
    let u = findLoaded(uName), v = findLoaded(vName)
    if (u < 0 || v < 0) {
      await ensureAllNames()
      if (u < 0) u = allNames.indexOf(uName)
      if (v < 0) v = allNames.indexOf(vName)
      if (u < 0 || v < 0) continue
      await ensureNodes([u, v])
    }
    await ensureAdjacency(u)
    if (neighbours(u).includes(v)) continue
    extraNeighbours.set(u, (extraNeighbours.get(u) || []).concat([v]))
    nodes[u].nchild += 1
    roots = roots.filter(r => r != v)
  }
}

// which nodes depend on the observed one (reverse reachability); filled by getDependencyOn
var dependsOn = new Uint8Array(numberOfNodes)
var isSomeObserved = false

async function getDependencyOn(queryNodeId) {
  dependsOn = new Uint8Array(numberOfNodes)
  dependsOn[queryNodeId] = 1
  const stack = [queryNodeId]
  while (stack.length > 0) {
    const u = stack.pop()
    await ensureReverse(u)
    for (const v of reverseNeighbours(u)) {
      if (!dependsOn[v]) {
        dependsOn[v] = 1
        stack.push(v)
      }
    }
  }
}
