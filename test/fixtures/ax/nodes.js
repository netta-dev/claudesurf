// Accessibility nodes built by hand in the shape that Accessibility.getFullAXTree returns,
// for the trees that the recorded fixtures beside this file don't hold. A node's `id`
// doubles as the backend id of the DOM node behind it.

// Returns one node with the type tags that Chrome puts on its role, name, and
// properties; `children` lists the ids of its child nodes.
function node(id, role, { name = '', properties = {}, children = [] } = {}) {
  const built = {
    nodeId: String(id),
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name },
    backendDOMNodeId: id,
  };
  const entries = Object.entries(properties);
  if (entries.length) built.properties = entries.map(([key, value]) => ({ name: key, value: { type: 'value', value } }));
  if (children.length) built.childIds = children.map(String);
  return built;
}

// Returns one node without the type tags, with `extra`'s fields, such as childIds and
// properties, spread over it.
function bareNode(id, role, name, extra = {}) {
  return { nodeId: String(id), role: { value: role }, name: { value: name }, backendDOMNodeId: id, ...extra };
}

module.exports = { node, bareNode };
