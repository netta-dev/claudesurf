// Runs in the browser, in one unit's isolated world, after the three libraries it uses
// have been evaluated there; sent as source by action-support.js. Never require() this
// file.
//
// Renders one document — a page or one of its frames — as markdown: an annotated clone
// of the scoped subtree, optionally through Readability, then Turndown, with every node
// the daemon resolved placed inline as a marker carrying its ref. `descriptors[i]`
// describes `nodes[i]`, the live element behind it; the live element is what a value is
// read from, since a clone's value is the element's default rather than what was typed.
//
// The daemon decides what is a control, a landmark, a group, a frame, an overlay, and
// the scope root; this script decides where each marker goes and what the prose around
// it reads like. An `overlay` descriptor names a dialog, a menu, or a message that the
// daemon renders as a block of its own, so the clone leaves it out wherever it sits.
// Under `options.overlay`, { role }, the render is that block's own, rooted at the
// overlay, and a root that is hidden, gone, or a screen-reader announcement renders
// empty.
function claudesurfRender(options, descriptors, ...nodes) {
  // @include state.js

  const REF_ATTR = 'data-cs-ref';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const ANNOUNCEMENT_ROLES = new Set(['alert', 'status']);
  // The size in CSS pixels, in either dimension, at or below which an alert or a status
  // is a message for screen readers alone, such as a router's route announcer.
  const ANNOUNCER_PX = 2;
  const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
  // Turndown discards an element whose text is blank before any rule sees it, unless
  // the element is one of these or holds one — its `voidElements` and its
  // `meaningfulWhenBlankElements` as one selector, `script` aside, which the clone
  // drops. A control this says Turndown would discard takes a filler, so a copy that
  // drifts from Turndown's own lists costs an empty button its marker. The filler is a
  // private-use character rather than the frame placeholder's NUL: a blank control
  // padding page text inside a fenced block — `<pre><code><button></button>frame:e9<
  // button></button></code></pre>` — has its filler read as raw text by the fencing
  // rules below, which run no control rule on the buttons inside; a NUL filler there
  // would spell the frame placeholder over page text no frame rule ever emitted it for.
  // Page text is stripped of the filler wherever it is stripped of the NUL, so the one
  // strip over the finished markdown takes the renderer's own fillers and nothing else.
  const TURNDOWN_KEEPS_WHEN_BLANK = 'area,base,br,col,command,embed,hr,img,input,keygen,link,meta,param,source,track,wbr,a,table,thead,tbody,tfoot,th,td,iframe,audio,video';
  // The class a syntax-highlighted block carries, with the language in it. The pattern
  // is the GFM plugin's, since the rule below is a copy of the plugin's rule.
  const HIGHLIGHT_CLASS = /highlight-(?:text|source)-([a-z0-9]+)/;
  // The class a <code> names its language in, which Turndown's own rule matches as
  // `language-(\S+)`: the characters a fence line can carry safely, and no others.
  const INFO_CLASS = /language-([a-z0-9_+-]+)/i;
  const FILLER = '\uE000';
  const stripFiller = (text) => text.split(FILLER).join('');
  // encodeURIComponent leaves these two alone; it encodes everything else safeUrl
  // covers, multi-byte whitespace included.
  const URL_ESCAPES = { '(': '%28', ')': '%29' };
  const labelMax = options.labelMax;
  const maxUrl = options.urlMax;
  const indexed = options.links === 'index';

  const entries = new Map();
  const refs = new Map();
  descriptors.forEach((descriptor, index) => {
    entries.set(descriptor.ref, { descriptor, node: nodes[index] || null });
    if (nodes[index]) refs.set(nodes[index], descriptor.ref);
  });

  // The refs the annotating walk stamped on the clone. REF_ATTR is the page's to write
  // as well, and cloneNode carries it over, so the attribute alone does not name a
  // described node: a ref the page stamped on an element of its own would otherwise
  // render the control, the group, or the frame the daemon described for that ref a
  // second time, wherever the page put the attribute.
  const stamped = new Set();
  const emitted = new Set();
  const links = [];
  const seenLinks = new Set();

  // The two characters the renderer reserves, taken out of every string the page
  // controls: a name, a value, an alt, or a URL carrying the placeholder's NUL could
  // forge a frame of its own, and one carrying the filler could hide a ref token from
  // the guard below, which the final strip would then close up into a marker. The
  // clone's text nodes are stripped as they are cloned.
  const RESERVED = /[\0\uE000]/g;
  const plain = (value) => (value || '').replace(RESERVED, '');
  const collapse = (value) => plain(value).replace(/\s+/g, ' ').trim();

  function cap(value) {
    const text = collapse(value);
    if (text.length <= labelMax) return text;
    // The cut never lands between the halves of a surrogate pair, whose lone half
    // renders as a replacement character; action-support.js holds the daemon's copy.
    const end = labelMax - 1;
    const code = text.charCodeAt(end);
    return `${text.slice(0, code >= 0xdc00 && code <= 0xdfff ? end - 1 : end)}…`;
  }

  // A field a marker carries: capped, then its brackets and backslashes escaped the way
  // Turndown escapes them in text. Turndown escapes text nodes and passes a rule's
  // return value through as it stands, so a `]` here would otherwise close the marker
  // the field sits in and leave what followed it reading as a marker of its own. The
  // backslash goes with them: a page-supplied `\]` escaped as brackets alone reads as
  // an escaped backslash followed by a live `]`, which closes the marker all the same.
  const escapeField = (value) => value.replace(/[\\[\]]/g, '\\$&');
  const field = (value) => escapeField(cap(value));

  // The ref a clone carries, or null when the attribute is one the page wrote.
  function refOf(node) {
    const ref = node.nodeType === 1 && node.getAttribute(REF_ATTR);
    return ref && stamped.has(ref) ? ref : null;
  }

  function descriptorOf(node) {
    const ref = refOf(node);
    return ref ? entries.get(ref).descriptor : null;
  }

  function isKind(node, kind) {
    const descriptor = descriptorOf(node);
    return Boolean(descriptor) && descriptor.kind === kind;
  }

  // The clone the libraries work on: hidden elements, scripts, and the characters the
  // renderer reserves are gone, every described node carries its ref, and an open shadow
  // tree replaces the light children it paints over, each slot standing for what it was
  // assigned.
  function annotate(source, target, dropText) {
    for (const child of childrenOf(source)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!dropText) target.appendChild(document.createTextNode(plain(child.data)));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(child.tagName)) continue;
      if (isOverlay(child)) continue;
      // An element with no box of its own paints through its children, so the walk
      // descends it and judges them instead — a float-only card that is itself a link
      // included, whose marker and prose both hang off it.
      if (skipped(child)) continue;
      const label = labelRule(child);
      if (label === 'drop') continue;
      cloneInto(child, target, dropText || label === 'dropText');
    }
  }

  function skipped(element) {
    return claudesurfSkipped(claudesurfState(element));
  }

  function isOverlay(element) {
    const ref = refs.get(element);
    return Boolean(ref) && entries.get(ref).descriptor.kind === 'overlay';
  }

  function cloneInto(element, target, dropText) {
    const clone = element.cloneNode(false);
    const ref = refs.get(element);
    clone.removeAttribute(REF_ATTR);
    if (ref) {
      clone.setAttribute(REF_ATTR, ref);
      stamped.add(ref);
    }
    target.appendChild(clone);
    annotate(element, clone, dropText);
    if (ref && entries.get(ref).descriptor.kind === 'control' && droppedWhenBlank(clone)) {
      clone.appendChild(document.createTextNode(FILLER));
    }
    return clone;
  }

  function childrenOf(node) {
    if (node.shadowRoot) return [...node.shadowRoot.childNodes];
    if (node.tagName === 'SLOT') return node.assignedNodes({ flatten: true });
    return [...node.childNodes];
  }

  function droppedWhenBlank(element) {
    return /^\s*$/.test(element.textContent)
      && !element.matches(TURNDOWN_KEEPS_WHEN_BLANK)
      && !element.querySelector(TURNDOWN_KEEPS_WHEN_BLANK);
  }

  // A control's marker carries its accessible name, so a label whose text is that name
  // renders once, in the marker: a label beside its control goes, a label around it
  // keeps the control and loses its own text. The label is compared as a marker field,
  // cut at the cap the daemon cut the name at, since past the cap the two are equal
  // only there.
  function labelRule(element) {
    if (element.tagName !== 'LABEL' || !element.control) return null;
    const ref = refs.get(element.control);
    if (!ref || field(element.textContent) !== entries.get(ref).descriptor.name) return null;
    // A control the clone skips places no marker, so dropping its label would take the
    // name out of the render altogether.
    if (skipped(element.control)) return null;
    return element.contains(element.control) ? 'dropText' : 'drop';
  }

  // Readability strips and moves nodes in the document it is handed, so it gets a whole
  // document of its own: the head unchanged, for the title, the byline, and the base,
  // and the body annotated like any other scope.
  function documentClone() {
    const clone = document.cloneNode(false);
    const html = document.documentElement.cloneNode(false);
    clone.appendChild(html);
    if (document.head) html.appendChild(document.head.cloneNode(true));
    const body = document.body ? document.body.cloneNode(false) : document.createElement('body');
    html.appendChild(body);
    // The <html>, <head>, and <body> copied here are the page's own elements, so a ref
    // the page stamped on one of them came over with the clone; it goes as it goes from
    // every other clone, before the walk stamps the daemon's under the body. No test
    // would fail if this call went: Readability returns its article as a fragment of
    // what lies under the body, so none of the three reaches the markdown today. It
    // holds the clone's invariant, that a marker keys on a ref this script stamped
    // alone.
    unstamp(html);
    if (document.body) annotate(document.body, body, false);
    return clone;
  }

  function unstamp(root) {
    root.removeAttribute(REF_ATTR);
    for (const element of root.querySelectorAll(`[${REF_ATTR}]`)) element.removeAttribute(REF_ATTR);
  }

  function scopedClone(root) {
    const holder = document.createElement('div');
    cloneInto(root, holder, false);
    return holder;
  }

  // A marker replaces its control's own text, so an editable region renders what it
  // holds as its value, as a text field does.
  function valueOf(descriptor, node) {
    if (!node || !(VALUE_ROLES.has(descriptor.role) || node.isContentEditable)) return null;
    if (claudesurfMasked(node)) return CLAUDESURF_MASK;
    if (node.tagName === 'SELECT') {
      const selected = node.selectedOptions && node.selectedOptions[0];
      return selected ? field(selected.textContent) : null;
    }
    const value = typeof node.value === 'string' ? node.value : node.textContent;
    return field(value) || null;
  }

  // Returns the `(options: …)` text of a control's marker. A native <select>'s options
  // print by name, since `select` takes one by its label; any other control's print
  // with their refs, so the agent can click a custom list's option.
  function optionsOf(descriptor, node) {
    if (!descriptor.options) return null;
    const native = Boolean(node) && node.tagName === 'SELECT';
    const names = descriptor.options.names.map(({ name, ref }) => (native || !ref ? name : `${name} [${ref}]`));
    if (descriptor.options.more) names.push(`… and ${descriptor.options.more} more`);
    return `(options: ${names.join(', ')})`;
  }

  // An anchor the tree gives a role other than link — a role=button, a menu item — is
  // the control its role names; the link rule leaves it to the control rule so its role
  // and state survive, and the control marker carries its target.
  function anchorControl(node) {
    const descriptor = descriptorOf(node);
    return Boolean(descriptor) && descriptor.kind === 'control' && descriptor.role !== 'link';
  }

  // The tree reports a url property for links alone, so the target comes from the
  // element; under links=index it joins the index, as a link's does.
  function controlTarget(ref, node) {
    if (!node || node.nodeName !== 'A' || !node.hasAttribute('href')) return '';
    const href = absolute(node);
    if (!href) return '';
    links.push({ ref, url: href });
    return indexed ? '' : `(${linkTarget(href)})`;
  }

  function controlMarker(ref, clone) {
    const { descriptor, node } = entries.get(ref);
    const parts = [`${ref} ${descriptor.role} ${JSON.stringify(descriptor.name)}`];
    const value = valueOf(descriptor, node);
    if (value !== null) parts.push(`= ${JSON.stringify(value)}`);
    if (descriptor.range) parts.push(`(${descriptor.range.min}–${descriptor.range.max})`);
    if (descriptor.state && descriptor.state.length) parts.push(`(${descriptor.state.join(', ')})`);
    const listed = optionsOf(descriptor, node);
    if (listed) parts.push(listed);
    emitted.add(ref);
    const marker = `[${parts.join(' ')}]${controlTarget(ref, node)}`;
    // A control the page lays out as a block gets a line of its own, so two of them
    // in a row do not read as one — except inside a table cell, where a row is one
    // line of the markdown and a blank line would break it in two.
    return node && isBlockLevel(node) && !inCell(clone) ? `\n\n${marker}\n\n` : marker;
  }

  // Whether the markdown the marker joins is a row's one line. The clone answers it,
  // not the live element: the clone rendered, so under a scope root inside a
  // cell there is no row around the marker to keep on its line.
  function inCell(clone) {
    return Boolean(clone.closest('td, th'));
  }

  function isBlockLevel(node) {
    const display = getComputedStyle(node).display;
    return !display.startsWith('inline') && display !== 'contents' && display !== 'none';
  }

  function boundaryMarker(ref, content, clone) {
    const { descriptor } = entries.get(ref);
    const name = descriptor.name ? ` ${JSON.stringify(descriptor.name)}` : '';
    emitted.add(ref);
    const open = `[${ref} ${descriptor.role}${name}]`;
    const close = `[/${descriptor.role}]`;
    if (inCell(clone)) return `${open} ${content} ${close}`;
    return `\n\n${open}\n\n${content}\n\n${close}\n\n`;
  }

  function grouped(count) {
    return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // A URL of the unit's own document renders as its path, any other absolute; one too
  // long to be navigable renders as its length, and the ref stays clickable. A URL the
  // parser refuses renders as the page wrote it, with its whitespace collapsed.
  function linkTarget(href) {
    // The URL is collapsed before it is measured, as render.js collapses a frame's
    // URL, so the two print the same length for the same URL.
    const text = collapse(href);
    if (/^data:/i.test(text) || text.length > maxUrl) return `url omitted: ${grouped(text.length)} chars`;
    try {
      const url = new URL(text, document.baseURI);
      return safeUrl(url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : url.href);
    } catch {
      return safeUrl(text);
    }
  }

  // A URL made safe to sit inside a marker: the brackets and parentheses the marker
  // forms are built out of are percent-encoded, since the URL parser leaves all four in
  // a path as the page wrote them and a crafted href would otherwise close its own
  // marker and open one for a ref the page does not own; whitespace is encoded with
  // them, since a newline would break the line that the marker sits on. action-support.js
  // holds the daemon's copy of this rule, for the URLs that the daemon prints itself.
  function safeUrl(url) {
    return url.replace(/[()[\]\s]/g, (c) => URL_ESCAPES[c] || encodeURIComponent(c));
  }

  // The absolute form of a link's target: what the links index carries and what
  // linkTarget shortens. A URL the parser refuses is the page's own text with its
  // whitespace collapsed, since the index keys one line on this string.
  function absolute(node) {
    const href = plain(node.getAttribute('href'));
    try {
      return new URL(href, document.baseURI).href;
    } catch {
      return collapse(href);
    }
  }

  // The ref grammar dispatch.js and MARKED_REF also match. A link's own text, or the
  // name it falls back to when it has none, is page text placed directly after a `[` of
  // its own — `[e12 button "Delete"](/x)[e40]` is byte-identical to a marker for e12
  // plus the link's bare ref. A backslash ahead of the token keeps it out of that
  // grammar without touching the rest of the text: MARKED_REF requires an unescaped `[`
  // immediately followed by the token, and the backslash breaks that adjacency.
  const REF_TOKEN = /^(f\d+)?e\d+(?=[ \]]|$)/;
  const guardToken = (text) => (REF_TOKEN.test(text) ? `\\${text}` : text);

  function linkMarker(content, node) {
    const ref = refOf(node);
    const entry = ref ? entries.get(ref) : null;
    const inner = collapse(content);
    const text = inner || (entry ? entry.descriptor.name : '');
    // A linked image is its own marker with the link's target after it, rather than a
    // marker wrapped in link brackets; its bracket opens on the literal word "image",
    // so it never reads as a ref token and the guard is unnecessary.
    const label = /^\[image ".*"\]$/.test(inner) ? inner : `[${guardToken(text)}]`;
    const href = absolute(node);
    const suffix = ref ? `[${ref}]` : '';
    if (ref) emitted.add(ref);
    if (!href) return text;
    if (ref) links.push({ ref, url: href });
    if (indexed && ref) return `${label}${suffix}`;
    // A pair already rendered keeps its ref and drops its URL, which is on the line
    // the first occurrence rendered.
    const pair = `${text}\0${href}`;
    if (seenLinks.has(pair)) return `${label}(…)${suffix}`;
    seenLinks.add(pair);
    return `${label}(${linkTarget(href)})${suffix}`;
  }

  // The GFM plugin's own heading-row rule, copied clause for clause — the blank <thead>
  // its first-tbody test steps over included — so a table this renders as rows is
  // exactly one the plugin's table rule leaves alone. The daemon's rules are matched
  // first, so the two drifting apart renders a GFM table as rows.
  function hasHeadingRow(table) {
    const row = table.rows[0];
    if (!row) return false;
    const parent = row.parentNode;
    if (parent.nodeName === 'THEAD') return true;
    return parent.firstChild === row
      && (parent.nodeName === 'TABLE' || isFirstBody(parent))
      && [...row.childNodes].every((cell) => cell.nodeName === 'TH');
  }

  function isFirstBody(element) {
    const previous = element.previousSibling;
    if (element.nodeName !== 'TBODY') return false;
    return !previous || (previous.nodeName === 'THEAD' && /^\s*$/.test(previous.textContent));
  }

  // Text the page wrote, fenced by a run one backtick longer than the longest the block
  // holds, as CommonMark requires: that text arrives unescaped, so a ``` line inside it
  // would otherwise close the fence and leave what followed reading as prose, a forged
  // marker included.
  function fencedBlock(text, info = '') {
    const body = text.replace(/\n+$/, '');
    const runs = (body.match(/`+/g) || []).map((run) => run.length + 1);
    const fence = '`'.repeat(Math.max(3, ...runs));
    return `\n\n${fence}${info}\n${body}\n${fence}\n\n`;
  }

  // The language a code block names, for the fence line to open with. The class is the
  // page's to write and the info string sits outside every escape the prose has, so the
  // language is matched against a restricted pattern rather than escaped: a block whose
  // class fits none of it opens a bare fence.
  function infoString(pre) {
    const code = pre.firstElementChild;
    const className = code && code.nodeName === 'CODE' ? code.getAttribute('class') || '' : '';
    const match = className.match(INFO_CLASS);
    return match ? match[1].toLowerCase() : '';
  }

  function inLayoutTable(node) {
    const table = node.closest('table');
    return Boolean(table) && !hasHeadingRow(table);
  }

  function converter(landmarkBoundaries) {
    const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    const gfm = turndownPluginGfm;
    service.use([gfm.strikethrough, gfm.taskListItems, gfm.tables]);
    // A rule added later is matched first, so everything below takes precedence over
    // the plugin's rules and over Turndown's own.
    //
    // The plugin's highlightedCodeBlock rule, copied clause for clause but fenced by
    // fencedBlock: the plugin opens three backticks whatever the block holds, so a
    // syntax-highlighted block carrying a ``` line of its own closes the fence from
    // inside. It is the first rule added, so every marker rule below takes a node it
    // would otherwise swallow.
    service.addRule('claudesurfHighlightedCode', {
      filter: (node) => node.nodeName === 'DIV' && HIGHLIGHT_CLASS.test(node.className)
        && node.firstChild && node.firstChild.nodeName === 'PRE',
      replacement: (content, node) => fencedBlock(node.firstChild.textContent, node.className.match(HIGHLIGHT_CLASS)[1]),
    });
    // A group carries its boundary pair wherever it renders; a landmark carries one
    // where the chain renders the whole document. The <pre> rule below declines the
    // same nodes, so a <pre> among them keeps the marker this rule places.
    const boundary = (node) => isKind(node, 'group') || (landmarkBoundaries && isKind(node, 'landmark'));
    service.addRule('claudesurfBoundary', {
      filter: boundary,
      replacement: (content, node) => boundaryMarker(refOf(node), content.trim(), node),
    });
    service.addRule('claudesurfControl', {
      filter: (node) => isKind(node, 'control'),
      replacement: (content, node) => controlMarker(refOf(node), node),
    });
    service.addRule('claudesurfLink', {
      filter: (node) => node.nodeName === 'A' && node.hasAttribute('href') && !anchorControl(node),
      replacement: linkMarker,
    });
    // A rule added later is matched first, so this one sees an image the daemon
    // described as a control ahead of the control rule; declining it leaves that rule
    // to place the marker.
    service.addRule('claudesurfImage', {
      filter: (node) => node.nodeName === 'IMG' && !refOf(node),
      replacement: (content, node) => {
        const alt = field(node.getAttribute('alt'));
        return alt ? `[image ${JSON.stringify(alt)}]` : '';
      },
    });
    service.addRule('claudesurfFrame', {
      filter: 'iframe',
      replacement: (content, node) => {
        const ref = refOf(node);
        if (!ref) return '';
        emitted.add(ref);
        return `\u0000frame:${ref}\u0000`;
      },
    });
    // Every <pre> a marker does not have to reach — a code block, and the one Chrome
    // wraps a JSON or plain-text response in — fences as it stands, so its newlines and
    // punctuation arrive unescaped; one holding a described node renders as the block it
    // is, so the markers inside it are placed. This rule takes both shapes because
    // Turndown's own <pre><code> rule is unusable for either: it prints the `language-`
    // class on the fence line as the page wrote it, where a `[e12]` reads as a marker
    // and a backtick run leaves the line no fence at all and the block's text reading as
    // prose, and it fences the block's raw text, which drops the markers inside it. A
    // <pre> a rule above marks — a control, a group, a landmark where boundaries render
    // — declines to that rule. The daemon also describes a <pre> no rule marks, as the
    // scope root or as a landmark a scoped read renders bare; that one fences like any
    // other, since no marker carries its ref into the payload, so the filter reads the
    // kind rather than the attribute every described node carries.
    service.addRule('claudesurfPre', {
      filter: (node) => node.nodeName === 'PRE' && !isKind(node, 'control') && !boundary(node),
      replacement: (content, node) => (node.querySelector(`[${REF_ATTR}]`)
        ? `\n\n${content}\n\n`
        : fencedBlock(node.textContent, infoString(node))),
    });
    // Turndown's own inline-code rule, copied clause for clause, with its content
    // escaped before the delimiter is picked: an `isCode` text node reaches Turndown's
    // own text rule unescaped, by design, so a bracket or a backslash inside a code
    // span would otherwise close the marker it sits in or open one for a ref the page
    // does not own, the way page text elsewhere is escaped at its cap.
    service.addRule('claudesurfInlineCode', {
      filter: (node) => {
        const hasSiblings = node.previousSibling || node.nextSibling;
        const isCodeBlock = node.parentNode.nodeName === 'PRE' && !hasSiblings;
        return node.nodeName === 'CODE' && !isCodeBlock;
      },
      replacement: (content) => {
        if (!content) return '';
        const escaped = escapeField(content.replace(/\r?\n|\r/g, ' '));
        const extraSpace = /^`|^ .*?[^ ].* $|`$/.test(escaped) ? ' ' : '';
        let delimiter = '`';
        const runs = escaped.match(/`+/gm) || [];
        while (runs.includes(delimiter)) delimiter += '`';
        return `${delimiter}${extraSpace}${escaped}${extraSpace}${delimiter}`;
      },
    });
    // A table the page uses for layout renders one line per row, since its columns
    // assert nothing; the plugin's rules keep the tables that have a heading row.
    service.addRule('claudesurfLayoutTable', {
      filter: (node) => node.nodeName === 'TABLE' && !hasHeadingRow(node),
      replacement: (content) => `\n\n${content.replace(/^\n+|\n+$/g, '')}\n\n`,
    });
    service.addRule('claudesurfLayoutRow', {
      filter: (node) => node.nodeName === 'TR' && inLayoutTable(node),
      replacement: (content) => `\n${content.replace(/[ \t]+$/, '')}\n`,
    });
    // A cell that is itself a control is declined the way an image is; the marker the
    // control rule places keeps the row's line, since it sits in a cell.
    service.addRule('claudesurfLayoutCell', {
      filter: (node) => (node.nodeName === 'TD' || node.nodeName === 'TH') && inLayoutTable(node) && !isKind(node, 'control'),
      replacement: (content) => `${content} `,
    });
    return service;
  }

  const rootEntry = descriptors.find((descriptor) => descriptor.kind === 'root' || descriptor.root === true);
  const rootNode = rootEntry ? entries.get(rootEntry.ref).node : null;
  // A scope root that disappeared between the tree pull and the render — one that the
  // daemon could not resolve, or one that Chrome resolved detached — falls through to
  // the body, and the reported chain says so, since the Scope: header names what
  // rendered; the daemon is told, since a render that has to match an earlier one of
  // that root can't use the body.
  const lostRoot = Boolean(rootEntry) && !(rootNode && rootNode.isConnected);
  const overlayRole = options.overlay ? options.overlay.role : null;
  const skip = overlayRole ? overlaySkip() : null;
  if (skip) return { markdown: '', links: [], chain: options.chain, refs: [], hiddenRefs: [], article: null, lostRoot, skipped: skip };
  const root = rootNode && !lostRoot ? rootNode : document.body;
  // A frame is reported alongside the controls, so the daemon can tell a frame the
  // page hides from one the render dropped.
  const hiddenRefs = descriptors
    .filter((descriptor) => descriptor.kind === 'control' || descriptor.kind === 'iframe')
    .filter((descriptor) => {
      const { node } = entries.get(descriptor.ref);
      return node && skipped(node);
    })
    .map((descriptor) => descriptor.ref);

  const readability = options.chain === 'auto' || options.chain === 'forced-article';
  const article = { found: false, title: '', byline: '' };
  let source = null;
  let chain = lostRoot ? 'body' : options.chain;
  if (readability) {
    const clone = documentClone();
    const parsed = options.chain === 'forced-article' || isProbablyReaderable(clone) ? new Readability(clone).parse() : null;
    if (parsed && parsed.content) {
      chain = 'readability';
      source = parsed.content;
      article.found = true;
      // The Article: header line is built out of brackets as a marker is, and both of
      // these are the page's to write — the byline comes from a meta tag — so both are
      // capped and escaped as a marker's fields are.
      article.title = field(parsed.title);
      article.byline = field(parsed.byline);
    } else if (!lostRoot) {
      chain = options.fallback || 'body';
    }
  }
  // Landmark boundaries render whenever a whole document does: under `all`, under a
  // fall-through to `body`, and for a frame a ref scope reads whole, which the daemon
  // reports as `landmarks` since the chain there names the ref.
  //
  // The fillers are stripped over the finished markdown, in one pass: a fencing rule
  // reads its block's raw text, where no control rule ever runs, so the filler a blank
  // control inside it carries arrives with the text around it.
  const markdown = stripFiller(converter(options.landmarks === true || chain === 'all' || chain === 'body')
    .turndown(source === null ? scopedClone(root) : source)).trim();

  return {
    markdown,
    links,
    chain,
    refs: [...emitted],
    hiddenRefs,
    article: readability ? article : null,
    lostRoot,
  };

  // Returns why an overlay's root renders empty, or null: it has disappeared since the
  // tree was pulled, the shared rule hides it, or it is an announcement too small to
  // see, which a boxless wrapper isn't.
  function overlaySkip() {
    if (lostRoot) return 'lost';
    const state = claudesurfState(rootNode);
    if (claudesurfSkipped(state)) return 'hidden';
    if (!ANNOUNCEMENT_ROLES.has(overlayRole) || state.boxless) return null;
    const rect = rootNode.getBoundingClientRect();
    return rect.width <= ANNOUNCER_PX || rect.height <= ANNOUNCER_PX ? 'tiny' : null;
  }
}
