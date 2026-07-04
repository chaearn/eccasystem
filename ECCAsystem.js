function _1(md){return(
md`# ECCAsystem

Prototyping of ECCAsystem Map (In Development)`
)}

async function _2(FileAttachment,d3)
{
  // The "dry" brush relies on feTurbulence/feDisplacementMap filters, which
  // are expensive to rasterize — fine on desktop, but a real cost on phones
  // and small/touch screens. Fall back to "original" (a plain gradient
  // stroke, no filter) there instead.
  const MOBILE_BREAKPOINT = 768;
  function isSmallScreen() {
    return window.innerWidth < MOBILE_BREAKPOINT || window.matchMedia("(pointer: coarse)").matches;
  }
  let brushStyle = isSmallScreen() ? "original" : "dry"; // "original" | "marker" | "dry"
  window.addEventListener("resize", () => {
    const next = isSmallScreen() ? "original" : "dry";
    if (next !== brushStyle) {
      brushStyle = next;
      requestCrossLinksUpdate();
    }
  });

  // Live-adjustable via the settings panel (bottom right) — bandwidth and
  // thresholds control the contour blobs, the max-chars settings control
  // where cross-link/node labels wrap, labelEndOffsetPct controls how far
  // in from each end a cross-link's label sits. Persisted to localStorage
  // so tuning survives a reload — maxContentWPct/HPct specifically *require* a
  // reload to take effect (they drive the whole layout construction, not
  // just a render pass), so those two are saved but not applied live.
  const SETTINGS_STORAGE_KEY = "eccasystem-settings";
  function loadStoredSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }
  const storedSettings = loadStoredSettings();
  const settings = Object.assign({
    bandwidth: 110,
    thresholds: 4,
    crossLabelMaxChars: 18,
    nodeLabelMaxChars: 18,
    labelEndOffsetPct: 28,
    crossLabelFontSize: 12,
    nodeLabelFontSize: 8,
    // % of the actual viewport, not static px — scales proportionally on
    // any screen instead of feeling arbitrary on a much bigger or smaller
    // one. Renamed from maxContentW/H (which were px) so any old stored
    // value from before this change is just ignored, not misread as a %.
    maxContentWPct: 90,
    maxContentHPct: 90,
    // Base info-card width in px (before the mobile cardScale below). Drives
    // the foreignObject width, card positioning/clamping and leader-line
    // geometry — all computed once up front — so like the two maxContent
    // settings it can't be applied live and needs a reload.
    cardWidth: 148,
    // Info-card text sizes, in rem (tied to the root font-size set in
    // index.html, same as the card padding — so text and padding scale
    // together on mobile instead of the text shrinking with the card width).
    // Changing them re-wraps the labels and changes card height, which is
    // measured once at build, so they're reload-required too.
    cardPartnerRem: 0.625,
    cardLabelRem: 0.75,
    cardStageRem: 0.625,
    // Info-card inner padding in rem (top / bottom / horizontal — see
    // cardHTML). Changes the content-box size and card height (measured once
    // at build), so reload-required like the other card-geometry settings.
    cardPadTop: 0.75,
    cardPadBottom: 0.5,
    cardPadH: 0.625
  }, storedSettings);
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {}
  }
  const showLocalLabels = true;
  const showCrossLabels = true;
  const bulletSvgs = await Promise.all([
    FileAttachment("bullet-1.svg").url(),
    FileAttachment("bullet-2.svg").url(),
    FileAttachment("bullet-3.svg").url(),
    FileAttachment("bullet-4.svg").url()
  ]);

  // Canvas fills the actual viewport (100svw x 100svh) rather than a fixed
  // square, so the 4 panels divide that real space evenly instead of
  // getting letterboxed on tall/narrow mobile screens. But on a very wide
  // or tall screen, letting the panel cluster itself keep growing to fill
  // the whole viewport spreads the 4 quadrants out to the corners with a
  // huge dead zone in the middle. So the cluster's own size is capped
  // instead of stretching indefinitely, and centered within the (still
  // full-bleed) canvas — see the initial zoom transform near the bottom.
  const viewportW = Math.max(320, window.innerWidth || 1260);
  const viewportH = Math.max(320, window.innerHeight || 1260);
  const contentW = viewportW * (settings.maxContentWPct / 100);
  const contentH = viewportH * (settings.maxContentHPct / 100);
  const panelGapX = 60;
  const panelGapY = 60;

  const panelW = (contentW - panelGapX) / 2;
  const panelH = (contentH - panelGapY) / 2;

  const layout = {
    width: contentW,
    height: contentH,
    cols: 2,
    panelW,
    panelH,
    gapX: panelGapX,
    gapY: panelGapY,
    marginLeft: 0,
    marginTop: 0,
    // The node-spread distances/radii below were tuned for a ~600px-square
    // panel. On a narrower panel (small screens, or once a gap is carved
    // out of the space) that spread no longer fits, so nodes spill past
    // the panel edge and the gap disappears. Scale it down to match the
    // smaller dimension — capped at 1 so panels bigger than the original
    // reference don't force nodes to spread out further to compensate,
    // they just keep some breathing room instead.
    panelScale: Math.min(1, Math.max(0.35, Math.min(panelW, panelH) / 600))
  };

  // Scaled by screen size (not panelScale — an earlier attempt tied it to
  // panel size instead and crushed the text column down to ~1 word per
  // line on a small panel, which looked broken). w is genuinely used for
  // layout (foreignObject width + the card's own min-width); h is only a
  // generous *estimate* for the off-canvas clamp math below — actual
  // per-card foreignObject height is measured from real rendered content
  // (see measureCardHeights in makePanel), since labels vary a lot in
  // wrapped line count and a fixed height either clips long ones or
  // wastes space on short ones.
  const cardScale = isSmallScreen() ? 0.65 : 1;
  // Width comes from the settings panel (settings.cardWidth, default 172);
  // offsetX keeps the original -208/172 ratio to it so a wider/narrower card
  // still anchors sensibly relative to its node. h/offsetY are height-side
  // and stay tied to the reference dimensions.
  const cardW = settings.cardWidth * cardScale;
  const card = {
    w: cardW,
    h: 160 * cardScale,
    offsetX: -(208 / 172) * cardW,
    offsetY: -80 * cardScale
  };

  const data = await fetch(new URL("./data.json", import.meta.url)).then(r => r.json());

  const charts = await Promise.all(data.charts.map(async chart => ({
    ...chart,
    image: await FileAttachment(chart.image).url()
  })));

  const chartById = new Map(charts.map(d => [d.id, d]));

  const crossLinks = data.crossLinks;

  // A "hub" is a label-only node other charts' nodes can link to — it
  // doesn't belong to any of the 4 quadrant panels, so it needs its own
  // fixed position and its own lookup/color handling in the cross-link code.
  const hubs = data.hubs || [];
  const hubColor = "#22392C";
  const hubPosition = {x: layout.width / 2, y: layout.height / 2};

  function endpointKey(endpoint) {
    return endpoint.hub ? `hub::${endpoint.hub}` : `${endpoint.chart}::${endpoint.node}`;
  }
  function endpointColor(endpoint) {
    return endpoint.hub ? hubColor : chartById.get(endpoint.chart).color;
  }

  const sharedIds = new Set(
    [...d3.rollup(
      charts.flatMap(c => c.nodes.map(n => n.id)),
      v => v.length,
      d => d
    )]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
  );

  const svg = d3.create("svg")
    .attr("viewBox", [0, 0, viewportW, viewportH])
    .style("display", "block")
    .style("width", "100svw")
    .style("height", "100svh")
    .style("background", "#F2F1ED")
    .style("font-family", "system-ui, sans-serif");

  const defs = svg.append("defs");

  defs.append("filter")
    .attr("id", "markerStroke")
    .attr("x", "-20%")
    .attr("y", "-20%")
    .attr("width", "140%")
    .attr("height", "140%")
    .html(`
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.075" numOctaves="1" seed="7" result="noise"></feTurbulence>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.9" xChannelSelector="R" yChannelSelector="G"></feDisplacementMap>
    `);

  defs.append("filter")
    .attr("id", "dryBrushStroke")
    .attr("x", "-24%")
    .attr("y", "-24%")
    .attr("width", "148%")
    .attr("height", "148%")
    .html(`
      <feTurbulence type="fractalNoise" baseFrequency="0.036 0.83" numOctaves="2.5" seed="20" result="noise"></feTurbulence>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.8" xChannelSelector="R" yChannelSelector="G"></feDisplacementMap>
    `);

  defs.append("filter")
    .attr("id", "dryBrushStroke2")
    .attr("x", "-20%")
    .attr("y", "-24%")
    .attr("width", "128%")
    .attr("height", "140%")
    .html(`
      <feTurbulence type="fractalNoise" baseFrequency="0.036 0.83" numOctaves="1" seed="7" result="noise"></feTurbulence>
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="0.9" xChannelSelector="R" yChannelSelector="G"></feDisplacementMap>
    `);

  const zoomLayer = svg.append("g");
  const linkOverlay = zoomLayer.append("g")
    .attr("fill", "none")
    .attr("pointer-events", "none");
  const hubLayer = zoomLayer.append("g").attr("pointer-events", "none");
  // Cross-link labels get their own layer, appended dead last (after every
  // panel is built, see below) so they always render above absolutely
  // everything — lines, contours, nodes, cards — not just other lines.
  let crossLabelLayer;

  const panels = [];

  // Each panel's simulation independently asked updateCrossLinks() to redraw
  // on its own tick schedule. Since all 4 panels tick in lockstep, that
  // meant the cross-link redraw (the expensive one — turbulence filters,
  // gradients, cached bboxes) fired up to 4x per frame instead of once.
  // Coalesce all requests into a single per-frame update instead.
  let crossLinksDirty = false;
  function requestCrossLinksUpdate() {
    crossLinksDirty = true;
  }

  // Cross-links (both the stroke and its label) are hidden by default and
  // only reveal when you hover the *node* they touch (a node can have
  // several cross-links at once, hence a Set rather than a single key).
  // A click on a link pins it open so it stays visible without holding.
  const pinnedCrossLinks = new Set();
  const hoveredCrossLinkKeys = new Set();
  function isCrossLabelVisible(key) {
    return pinnedCrossLinks.has(key) || hoveredCrossLinkKeys.has(key);
  }

  // Which node most recently caused a given link to become visible — used
  // to decide which end's label to show. Stores the node's own on-canvas
  // position so the label can pick whichever end of the curve is actually
  // closer to it (handles group-expanded links too, see below, where the
  // hovered node isn't literally one of that specific link's endpoints).
  const linkTriggerPosition = new Map();

  function setCrossLinkVisible(g, visible) {
    const keys = new Set();
    g.each(d => keys.add(d.key));

    crossLabelLayer.selectAll("g.cross-label-group")
      .filter(d => keys.has(d.key))
      .interrupt()
      .transition()
      .duration(120)
      .style("opacity", visible ? 1 : 0);
    g.select(".main")
      .interrupt()
      .transition()
      .duration(120)
      .style("opacity", visible ? 1 : 0);
    g.select(".secondary")
      .interrupt()
      .transition()
      .duration(120)
      .style("opacity", visible ? 1 : 0);
  }

  // Links directly touching this node, plus — for links tagged with a
  // "group" (e.g. a closed triangle like Referral Network) — every other
  // link sharing that same group, even if it doesn't touch this node
  // directly. Hub fan-outs and plain one-to-one links have no group, so
  // they're untouched by this and only ever show their own direct link.
  function crossLinksTouchingNode(nodeId) {
    const direct = linkOverlay
      .selectAll("g.cross-link")
      .filter(d => d.sourceNode === nodeId || d.targetNode === nodeId);

    const groups = new Set();
    direct.each(d => { if (d.group) groups.add(d.group); });
    if (groups.size === 0) return direct;

    return linkOverlay
      .selectAll("g.cross-link")
      .filter(d => (d.sourceNode === nodeId || d.targetNode === nodeId) || (d.group && groups.has(d.group)));
  }

  function setNodeCrossLinksVisible(nodeId, nodePos, visible) {
    const links = crossLinksTouchingNode(nodeId);
    if (visible) {
      links.each(d => {
        hoveredCrossLinkKeys.add(d.key);
        linkTriggerPosition.set(d.key, nodePos);
      });
      setCrossLinkVisible(links, true);
      // Once the simulation has settled, nothing else re-runs
      // updateCrossLinks() — without this, linkTriggerPosition changes
      // above would never actually move the label to the new end.
      requestCrossLinksUpdate();
    } else {
      // Un-mark hover for all touching links, but only actually fade out
      // the ones that aren't pinned open by a click.
      const toHide = links.filter(d => {
        hoveredCrossLinkKeys.delete(d.key);
        return !pinnedCrossLinks.has(d.key);
      });
      setCrossLinkVisible(toHide, false);
    }
  }

  // The turbulence/displacement filters on cross-links are the expensive
  // part — the browser re-rasterizes them every time the filtered path's
  // geometry changes. That's fine once things are still (a one-time cost),
  // but brutal while nodes are actively settling in or being dragged, since
  // it forces a full filter recompute every frame. So: render cross-links
  // as plain (unfiltered) strokes while anything is moving, and only
  // switch the filter on ~220ms after motion stops.
  let crossLinksSettled = false;
  let settleTimer = null;
  function markCrossLinksActive() {
    crossLinksSettled = false;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      crossLinksSettled = true;
      crossLinksDirty = true;
    }, 220);
  }

  d3.timer(() => {
    if (crossLinksDirty) {
      crossLinksDirty = false;
      updateCrossLinks();
    }
  });

  function panelPosition(index) {
    const col = index % layout.cols;
    const row = Math.floor(index / layout.cols);
    return {
      x: layout.marginLeft + col * (layout.panelW + layout.gapX),
      y: layout.marginTop + row * (layout.panelH + layout.gapY)
    };
  }

  const labelBBoxCache = new Map();

  function cachedTextBBox(textNode, key) {
    const cached = labelBBoxCache.get(key);
    if (cached) return cached;
    // getBBox() on an element that isn't attached to the document yet
    // (true for the very first call — the whole SVG is still detached
    // while this cell builds it) returns an all-zero rect. Don't cache
    // that, or the swipe backgrounds stay collapsed forever; only lock
    // in a value once we get a real measurement.
    const b = textNode.getBBox();
    const box = {width: b.width, height: b.height};
    if (b.width > 0 || b.height > 0) labelBBoxCache.set(key, box);
    return box;
  }

  // SVG <text> has no CSS max-width/word-wrap — this is the tspan-based
  // equivalent of "max-width: 18ch", word-wrapping at ~maxChars per line.
  // align "center" (default) centers the block on the text element's own
  // (x,y); align "bottom" keeps the last line at (x,y) and stacks the rest
  // upward — for a label meant to sit just above a fixed point.
  function wrapTextTspans(textSelection, text, maxChars = 18, lineHeight = 22, align = "center") {
    const words = (text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";
    words.forEach(word => {
      const candidate = current ? `${current} ${word}` : word;
      if (current && candidate.length > maxChars) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    });
    if (current) lines.push(current);

    textSelection.selectAll("tspan").remove();
    const startDy = align === "bottom"
      ? -(lines.length - 1) * lineHeight
      : -((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, i) => {
      textSelection.append("tspan")
        .attr("x", 0)
        .attr("dy", i === 0 ? startDy : lineHeight)
        .text(line);
    });
  }

  function markerSwipePath(x, y, w, h) {
    return `
      M ${x - w / 2} ${y - h / 2 + h * 0.16}
      C ${x - w * 0.34} ${y - h * 0.68}, ${x - w * 0.12} ${y - h * 0.44}, ${x} ${y - h * 0.53}
      C ${x + w * 0.20} ${y - h * 0.58}, ${x + w * 0.35} ${y - h * 0.48}, ${x + w / 2} ${y - h / 2 + h * 0.10}
      L ${x + w / 2 - w * 0.035} ${y + h / 2}
      C ${x + w * 0.18} ${y + h * 0.42}, ${x - w * 0.12} ${y + h * 0.57}, ${x - w / 2 + w * 0.04} ${y + h / 2 - h * 0.03}
      Z
    `;
  }

  function easePosition(state, target, factor = 0.18) {
    state.x += (target.titleX - state.x) * factor;
    state.y += (target.titleY - state.y) * factor;
  }

  function crossCurveWithControl(x1, y1, x2, y2, distVal = 0.18) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;

    const curve = dist * distVal;
    const nx = -dy / dist;
    const ny = dx / dist;
    const cx = mx + nx * curve;
    const cy = my + ny * curve;

    return {x1, y1, x2, y2, cx, cy, nx, ny};
  }

  function offsetQuadCurve(curve, offset) {
    return `M ${curve.x1 + curve.nx * offset} ${curve.y1 + curve.ny * offset}
            Q ${curve.cx + curve.nx * offset} ${curve.cy + curve.ny * offset}
              ${curve.x2 + curve.nx * offset} ${curve.y2 + curve.ny * offset}`;
  }

  function quadPoint(x1, y1, cx, cy, x2, y2, t = 0.5) {
    const mt = 1 - t;
    return {
      x: mt * mt * x1 + 2 * mt * t * cx + t * t * x2,
      y: mt * mt * y1 + 2 * mt * t * cy + t * t * y2
    };
  }

  function ensureGradient(id, x1, y1, x2, y2, c1, c2) {
    const mid = d3.interpolateRgb(c2, c1)(0.5);

    const grad = defs.selectAll(`linearGradient#${id}`)
      .data([null])
      .join("linearGradient")
      .attr("id", id)
      .attr("gradientUnits", "userSpaceOnUse")
      .attr("x1", x1)
      .attr("y1", y1)
      .attr("x2", x2)
      .attr("y2", y2);

    grad.selectAll("stop")
      .data([
        {offset: "0%", color: c2},
        {offset: "38%", color: c2},
        {offset: "47%", color: mid},
        {offset: "53%", color: mid},
        {offset: "62%", color: c1},
        {offset: "100%", color: c1}
      ])
      .join("stop")
      .attr("offset", d => d.offset)
      .attr("stop-color", d => d.color);

    return `url(#${id})`;
  }

  function hasCard(d) {
    return !!(d.partner || d.stage || d.label);
  }

  function cardHTML(d, chart) {
    // Everything here is rem (except min-width — card.w is already a
    // JS-computed responsive value, see isSmallScreen() above). Text sizes,
    // padding, gaps and radius are all tied to the root font-size set in
    // index.html (16px desktop, 10px mobile), so on a small screen the whole
    // card — text and spacing together — steps down by the same factor and
    // keeps its proportions. Text sizes come from the settings panel.
    const t = {
      partner: settings.cardPartnerRem,
      label:   settings.cardLabelRem,
      stage:   settings.cardStageRem
    };
    return `
      <div class="poppins" style="
        min-width:${card.w}px;
        min-height:auto;
        box-sizing:border-box;
        background:rgba(247,246,239,0.96);
        border-radius:0.75rem;
        padding:${settings.cardPadTop}rem ${settings.cardPadH}rem ${settings.cardPadBottom}rem;
        color:#111;
        display:flex;
        flex-direction:column;
        gap:0.25rem;
        box-shadow:0 1px 0 rgba(0,0,0,0.02);
      ">
        <div class="poppins" style="
          font-size:${t.partner}rem;
          font-weight:500;
          line-height:1;
          color:${chart.color};
          white-space:pre-line;
        ">${d.partner || ""}</div>

        <div class="poppins" style="
          font-size:${t.label}rem;
          font-weight:700;
          line-height:1.15;
          color:#111;
          white-space:pre-line;
          max-width:18ch;
        ">${d.label || d.id}</div>

        <div style="
          width:100%;
          display: flex;
          border-top: 1px solid ${chart.color};
          padding-top: 0.5rem;
        ">
          ${
            d.stage
              ? `<div class="poppins" style="
                  align-self:flex-start;
                  background:${chart.color}22;
                  color:${chart.color};
                  border-radius:0.1875rem;
                  padding:0.25rem 0.5rem;
                  font-size:${t.stage}rem;
                  font-weight:600;
                  line-height:1;
                ">${d.stage}</div>`
              : ``
          }
        </div>

      </div>
    `;
  }

  

  function makePanel(chart, index) {
    const {x, y} = panelPosition(index);

    const panel = zoomLayer.append("g")
      .attr("transform", `translate(${x},${y})`);

    // Anchor the title badge to this panel's own outer corner (the corner
    // farthest from the canvas center, where the 4 quadrants meet) instead
    // of tracking a node's live position.
    const col = index % layout.cols;
    const row = Math.floor(index / layout.cols);
    const cornerMargin = 24;

    const nodes = chart.nodes.map(d => ({...d}));
    const links = chart.links.map(d => ({...d}));

    function hashString(str) {
      let h = 2166136261;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return Math.abs(h);
    }
    
    nodes.forEach(d => {
      d.icon = bulletSvgs[hashString(`${chart.id}-${d.id}`) % bulletSvgs.length];
    });
    
    // Cap the badge to a reasonable fraction of its own panel — on a
    // narrow panel a full-size badge would overflow into the neighboring
    // one regardless of any gap between them.
    const badgeScale = Math.min(
      1,
      (layout.panelW * 0.5) / (chart.badgeW ?? 112),
      (layout.panelH * 0.35) / (chart.badgeH ?? 78)
    );
    const badgeW = (chart.badgeW ?? 112) * badgeScale;
    const badgeH = (chart.badgeH ?? 78) * badgeScale;

    const cornerTarget = {
      x: col === 0 ? cornerMargin + badgeW / 2 : layout.panelW - cornerMargin - badgeW / 2,
      y: row === 0 ? cornerMargin + badgeH / 2 : layout.panelH - cornerMargin - badgeH / 2
    };
    const titleState = {x: cornerTarget.x, y: cornerTarget.y};
    // Stays at its fixed corner on load; once dragged, this overrides the
    // corner target and the badge stays wherever it's dropped.
    let badgeOverride = null;

    // Badge renders here, before `inner` — so nodes/lines paint on top of
    // it wherever they overlap. Still draggable from any part of the badge
    // that isn't currently covered by a node.
    const titleLayer = panel.append("g").attr("pointer-events", "none");
    const titleBadge = titleLayer.append("g")
      .style("pointer-events", "auto")
      .style("cursor", "grab");

    titleBadge.append("image")
      .attr("href", chart.image)
      .attr("xlink:href", chart.image)
      .attr("width", badgeW)
      .attr("height", badgeH)
      .attr("preserveAspectRatio", "xMidYMid meet");

    titleBadge.call(
      d3.drag()
        .on("start", event => {
          event.sourceEvent.stopPropagation();
          titleBadge.style("cursor", "grabbing");
        })
        .on("drag", event => {
          badgeOverride = {
            x: Math.max(badgeW / 2, Math.min(layout.panelW - badgeW / 2, event.x)),
            y: Math.max(badgeH / 2, Math.min(layout.panelH - badgeH / 2, event.y))
          };
          render();
        })
        .on("end", () => {
          titleBadge.style("cursor", "grab");
        })
    );

    const title = titleLayer.append("text")
      .attr("font-size", 15)
      .attr("font-weight", 700)
      .attr("fill", "transparent")
      .attr("text-anchor", "middle")
      .text(chart.id);

    const inner = panel.append("g");
    const densityLayer = inner.append("g")
      .style("mix-blend-mode", "multiply")
      .style("pointer-events", "none");
    const localLinkLayer = inner.append("g")
      .attr("stroke", "#94a3b8")
      .attr("stroke-opacity", 0.45);
    const localLabelLayer = inner.append("g");
    const nodeLayer = inner.append("g");
    const labelLayer = inner.append("g");

    // Bias the containment strength per axis to match the panel's own
    // aspect ratio, so the cluster settles into an oval that mirrors the
    // panel's own shape (landscape panel -> wide oval, portrait -> tall
    // oval) rather than a uniform circular scatter. A stronger pull on an
    // axis means *less* spread there (nodes held tighter to center), so
    // the axis with more room gets the weaker pull. Clamped so an extreme
    // aspect ratio doesn't collapse nodes onto a line.
    const panelAspect = layout.panelW / layout.panelH;
    const baseAxisStrength = 0.03;
    const forceXStrength = baseAxisStrength * Math.min(1.6, Math.max(0.6, 1 / panelAspect));
    const forceYStrength = baseAxisStrength * Math.min(1.6, Math.max(0.6, panelAspect));

    const simulation = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id).distance(235 * layout.panelScale).strength(0.2))
      .force("charge", d3.forceManyBody().strength(-105 * layout.panelScale))
      .force("center", d3.forceCenter(layout.panelW / 2, layout.panelH / 2 + 8))
      .force("collide", d3.forceCollide().radius(d => {
        const base = hasCard(d) ? 112 : (sharedIds.has(d.id) ? 10 : 22);
        return base * layout.panelScale;
      }))
      .force("x", d3.forceX(layout.panelW / 2).strength(forceXStrength))
      .force("y", d3.forceY(layout.panelH / 2 + 10).strength(forceYStrength));

    const localLinks = localLinkLayer.selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke-width", 1.5)
      .attr("stroke-dasharray", "2,4");

    const localLabelGroups = localLabelLayer.selectAll("g.local-link-label")
      .data(links)
      .join("g")
      .attr("class", "local-link-label")
      .attr("display", d => (showLocalLabels && d.label?.trim()) ? null : "none");

    localLabelGroups.append("path").attr("class", "label-swipe");

    localLabelGroups.append("text")
      .attr("font-size", 10)
      .attr("font-weight", 600)
      .attr("fill", "#334155")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .text(d => d.label || "");

    const nodeSize = d => hasCard(d) ? 42 : sharedIds.has(d.id) ? 28 : 22;

    const node = nodeLayer
      .selectAll("image.node-icon")
      .data(nodes)
      .join("image")
      .attr("class", "node-icon")
      .attr("href", d => d.icon)
      .attr("xlink:href", d => d.icon)
      .attr("width", d => nodeSize(d))
      .attr("height", d => nodeSize(d))
      .attr("preserveAspectRatio", "xMidYMid meet")
      .attr("display", d => hasCard(d) ? null : "none")
      .style("cursor", "grab");

    // Wrapped in its own group (like the cross-link/local-link labels)
    // rather than positioned by attrs directly on <text> — a <tspan> with
    // an explicit x (needed for each wrapped line to start at the same
    // horizontal spot) is positioned in absolute coordinates, ignoring
    // the parent <text>'s own x/y, so per-node positioning has to happen
    // via a translate on a wrapping <g> instead.
    const labelGroupsNode = labelLayer.selectAll("g.node-id")
      .data(nodes)
      .join(enter => {
        const g = enter.append("g")
          .attr("class", "node-id")
          .attr("display", d => hasCard(d) ? null : "none")
          .style("pointer-events", "none");

        const text = g.append("text")
          .attr("class", "poppins")
          .attr("font-size", settings.nodeLabelFontSize)
          .attr("font-weight", 500)
          .attr("fill", "#334155")
          .attr("text-anchor", "middle")
          .style("paint-order", "stroke")
          .style("stroke", "#F2F1ED")
          .style("stroke-width", "3px")
          .style("stroke-linejoin", "round");

        return g;
      });

    // Label text is static per node, so wrap once up front instead of
    // re-wrapping (removing/recreating tspans) on every render frame —
    // refreshNodeLabels() below re-runs this only when the max-width
    // setting actually changes.
    function refreshNodeLabels() {
      labelGroupsNode.select("text")
        .attr("font-size", settings.nodeLabelFontSize)
        .each(function(d) {
          wrapTextTspans(d3.select(this), d.id, settings.nodeLabelMaxChars, settings.nodeLabelFontSize * 1.1, "bottom");
        });
    }
    refreshNodeLabels();
    const labels = labelGroupsNode;

    // Shared by the tick's positioning and the hover/pin emphasis below: the
    // label group is translated to its node, then scaled by a per-node
    // emphasis factor (1 normally, larger when the node is a neighbour of the
    // focused node). Kept in one place so a running simulation's tick and an
    // emphasis transition write the same transform string instead of fighting.
    const NEIGHBOR_LABEL_SCALE = 1.5;
    function labelTransform(d) {
      return `translate(${d.x},${d.y - nodeSize(d) / 2 - 5}) scale(${d.__labelScale ?? 1})`;
    }

    const cardNodes = nodes.filter(hasCard);

    const cardLeaders = labelLayer.selectAll("line.card-leader")
      .data(cardNodes)
      .join("line")
      .attr("class", "card-leader")
      .attr("stroke", chart.color)
      .attr("stroke-opacity", 0)
      .attr("stroke-width", 1.1)
      .attr("pointer-events", "none");

    const infoCards = labelLayer.selectAll("foreignObject.node-card")
      .data(cardNodes)
      .join("foreignObject")
      .attr("class", "node-card")
      .attr("width", card.w)
      .attr("height", card.h)
      .style("overflow", "visible")
      .style("pointer-events", "none")
    .style("opacity", 0);

    infoCards.append("xhtml:div").html(d => cardHTML(d, chart));

    // Clamp to the overall visible canvas (in this panel's local
    // coordinates, hence the +/- x,y — the panel's own global offset)
    // rather than letting the fixed offset push the card off-screen on a
    // small panel. Accepts an optional actual-height override so a card
    // that's been individually measured (see measureCardHeights below)
    // clamps against its own real size instead of the generic estimate.
    function clampedCardPos(d, hOverride) {
      const h = hOverride ?? card.h;
      return {
        x: Math.max(-x, Math.min(d.x + card.offsetX, layout.width - x - card.w)),
        y: Math.max(-y, Math.min(d.y + card.offsetY, layout.height - y - h))
      };
    }

    // iOS Safari's foreignObject clips content to its declared height
    // regardless of `overflow: visible` (a known WebKit quirk) — a card
    // with a long label wraps to more lines than the fixed height budgets
    // for, and the bottom (often the stage pill) gets silently cut off.
    // Rather than trust overflow to save an undersized box, measure each
    // card's actual rendered content and size the foreignObject to match
    // exactly — and re-clamp its position against that real height too,
    // since a taller-than-estimated card could otherwise still hang off
    // the canvas edge even though it's no longer internally clipped.
    //
    // This needs to run more than once: it runs while the SVG may still
    // be detached from the document (offsetHeight reads 0 there, same
    // issue as the bbox/hub measurements elsewhere in this file), *and*
    // the Poppins font used inside the card loads from an external
    // Typekit stylesheet — if that hasn't finished loading yet, the
    // browser measures with a fallback font, locks in the wrong height,
    // and the real font swaps in afterward without ever re-measuring.
    // document.fonts.ready plus a couple of delayed fallbacks covers
    // both a slow font fetch and any other late reflow.
    function measureCardHeights() {
      infoCards.each(function(d) {
        const contentEl = this.firstElementChild;
        const measured = contentEl ? contentEl.offsetHeight : 0;
        if (measured > 0) {
          const h = measured + 4;
          const g = d3.select(this);
          g.attr("height", h);
          const pos = clampedCardPos(d, h);
          g.attr("x", pos.x).attr("y", pos.y);
        }
      });
    }
    measureCardHeights();
    requestAnimationFrame(measureCardHeights);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(measureCardHeights);
    }
    setTimeout(measureCardHeights, 400);
    setTimeout(measureCardHeights, 1800);

    const density = d3.contourDensity()
      .x(d => d.x)
      .y(d => d.y)
      .size([layout.panelW, layout.panelH]);

    const path = d3.geoPath();

    function renderDensity() {
      density.bandwidth(settings.bandwidth).thresholds(settings.thresholds);
      densityLayer.selectAll("path")
        .data(density(nodes))
        .join("path")
        .attr("d", path)
        .attr("fill", chart.color)
        .attr("fill-opacity", 0.07)
        .attr("stroke", "none");
    }

    function render() {
      // Badge position first — local links fan out from here, so this has
      // to be current before anything else references titleState. Ease
      // toward the fixed corner on load, but once the user has dragged it,
      // track the cursor exactly — easing a drag makes it feel laggy.
      if (badgeOverride) {
        titleState.x = badgeOverride.x;
        titleState.y = badgeOverride.y;
      } else {
        easePosition(titleState, {titleX: cornerTarget.x, titleY: cornerTarget.y}, 0.18);
      }

      const badgeX = titleState.x - badgeW / 2;
      const badgeY = titleState.y - badgeH / 2;

      titleBadge.attr("transform", `translate(${badgeX},${badgeY})`);

      title
        .attr("x", badgeX + badgeW / 2)
        .attr("y", badgeY + badgeH / 2 + 6);

      // Fan out from the badge instead of an invisible center node — every
      // local link's source is the badge's current on-screen position.
      localLinks
        .attr("x1", titleState.x)
        .attr("y1", titleState.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);

      localLabelGroups
        .attr("transform", d => {
          const mx = (titleState.x + d.target.x) / 2;
          const my = (titleState.y + d.target.y) / 2;
          const dx = d.target.x - titleState.x;
          const dy = d.target.y - titleState.y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len;
          const ny = dx / len;
          return `translate(${mx + nx * 10},${my + ny * 10})`;
        });

      localLabelGroups.each(function(d) {
        if (!d.label?.trim()) return;
        const g = d3.select(this);
        const t = g.select("text").node();
        if (!t) return;
        const b = cachedTextBBox(t, `local:${d.label}`);
        const w = b.width + 16;
        const h = b.height + 7;

        g.select(".label-swipe")
          .attr("d", markerSwipePath(0, 0, w, h))
          .attr("fill", "#f6e27a")
          .attr("fill-opacity", 0.92);
      });

      node
        .attr("x", d => d.x - nodeSize(d) / 2)
        .attr("y", d => d.y - nodeSize(d) / 2);

      labels
        .attr("transform", d => labelTransform(d));

      infoCards
        .attr("x", d => clampedCardPos(d).x)
        .attr("y", d => clampedCardPos(d).y);

      cardLeaders
        .attr("x1", d => d.x)
        .attr("y1", d => d.y)
        .attr("x2", d => clampedCardPos(d).x + card.w)
        .attr("y2", d => clampedCardPos(d).y + card.h / 2);
    }

    function dragBehavior(simulation) {
      function dragstarted(event, d) {
        event.sourceEvent.stopPropagation();
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      }
      function dragged(event, d) {
        d.fx = Math.max(12, Math.min(layout.panelW - 12, event.x));
        d.fy = Math.max(20, Math.min(layout.panelH - 12, event.y));
        render();
        renderDensity();
        requestCrossLinksUpdate();
        markCrossLinksActive();
        focusVisual(chart.id, d.id, {x: x + d.x, y: y + d.y});
      }
      function dragended(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
        // Drag has no hover to end on, so mirror mouseleave: fall back to the
        // pinned node if one is pinned, otherwise clear.
        if (pinned) {
          focusVisual(pinned.chartId, pinned.nodeId, pinned.getPos());
        } else {
          clearVisual(d.id);
        }
      }
      return d3.drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended);
    }

    node
      .call(dragBehavior(simulation))
      .on("mouseenter", (event, d) => {
        // Hover is a transient preview — it shows a node's neighbourhood but
        // doesn't change what's pinned.
        focusVisual(chart.id, d.id, {x: x + d.x, y: y + d.y});
      })
      .on("mouseleave", (event, d) => {
        // Restore the pinned node's neighbourhood if one is pinned; otherwise
        // clear. Hide the hovered node's own cross-links first (unless it *is*
        // the pinned node, whose links focusVisual re-reveals below).
        if (pinned) {
          if (pinned.nodeId !== d.id) setNodeCrossLinksVisible(d.id, null, false);
          focusVisual(pinned.chartId, pinned.nodeId, pinned.getPos());
        } else {
          clearVisual(d.id);
        }
      })
      .on("click", (event, d) => {
        // Tap/click pins a node's neighbourhood so it persists without a
        // hover (the only way to explore on touch), and lets you walk the
        // graph by tapping a connected node to re-focus on it. Tapping the
        // pinned node again — or empty canvas (see the svg click handler) —
        // clears it. d3-drag suppresses this click after a real drag, so
        // dragging a node to reposition it won't toggle the pin.
        event.stopPropagation();
        const key = `${chart.id}::${d.id}`;
        if (pinned && pinned.key === key) {
          const prev = pinned.nodeId;
          pinned = null;
          clearVisual(prev);
        } else {
          const prevId = pinned && pinned.nodeId;
          pinned = {
            key,
            chartId: chart.id,
            nodeId: d.id,
            getPos: () => ({x: x + d.x, y: y + d.y})
          };
          if (prevId != null && prevId !== d.id) setNodeCrossLinksVisible(prevId, null, false);
          focusVisual(chart.id, d.id, {x: x + d.x, y: y + d.y});
        }
      });

    let frame = 0;
    simulation.on("tick", () => {
      render();
      frame += 1;
      if (frame % 3 === 0) {
        renderDensity();
        requestCrossLinksUpdate();
        markCrossLinksActive();
      }
    });

    render();
    renderDensity();

    // Per-panel half of the focus interaction (driven by the global
    // focusVisual/clearVisual). Neighbours — nodes sharing a cross-link with
    // the focused node — get their id label scaled up and darkened; the
    // focused node shows its info card and hides its own now-redundant label;
    // every other node dims. Cards for neighbours no longer pop.
    function setEmphasis(focusKey, nbrKeys) {
      const keyOf = d => `${chart.id}::${d.id}`;
      node.interrupt().transition().duration(160)
        .attr("opacity", d => nbrKeys.has(keyOf(d)) ? 1 : 0.35);

      labels.each(function(d) {
        const k = keyOf(d);
        const isFocus = k === focusKey;
        const isNbr = nbrKeys.has(k);
        d.__labelScale = (isNbr && !isFocus) ? NEIGHBOR_LABEL_SCALE : 1;
        const g = d3.select(this).interrupt();
        g.transition().duration(160)
          .attr("transform", labelTransform(d))
          .style("opacity", isFocus ? 0 : (isNbr ? 1 : 0.3));
        g.select("text").interrupt().transition().duration(160)
          .attr("fill", (isNbr && !isFocus) ? "#0f172a" : "#334155")
          .attr("font-weight", (isNbr && !isFocus) ? 700 : 500);
      });

      infoCards.interrupt().transition().duration(180)
        .style("opacity", d => keyOf(d) === focusKey ? 1 : 0);
      cardLeaders.interrupt().transition().duration(180)
        .attr("stroke-opacity", d => keyOf(d) === focusKey ? 0.5 : 0);
    }

    function clearEmphasis() {
      node.interrupt().transition().duration(160).attr("opacity", 1);
      labels.each(function(d) {
        d.__labelScale = 1;
        const g = d3.select(this).interrupt();
        g.transition().duration(160)
          .attr("transform", labelTransform(d))
          .style("opacity", 1);
        g.select("text").interrupt().transition().duration(160)
          .attr("fill", "#334155")
          .attr("font-weight", 500);
      });
      infoCards.interrupt().transition().duration(160).style("opacity", 0);
      cardLeaders.interrupt().transition().duration(160).attr("stroke-opacity", 0);
    }

    return {
      chart,
      nodes,
      node,
      labels,
      infoCards,
      cardLeaders,
      localLabelGroups,
      renderDensity,
      refreshNodeLabels,
      setEmphasis,
      clearEmphasis,
      x0: x,
      y0: y
    };
  }

  function relatedCrossNodeKeys(chartId, nodeId) {
    const keys = new Set([`${chartId}::${nodeId}`]);
  
    crossLinks.forEach(l => {
      const a = `${l.source.chart}::${l.source.node}`;
      const b = `${l.target.chart}::${l.target.node}`;
  
      if (a === `${chartId}::${nodeId}`) keys.add(b);
      if (b === `${chartId}::${nodeId}`) keys.add(a);
    });
  
    return keys;
  }

  // Hover previews a node's neighbourhood; a click pins it (see the node
  // handlers in makePanel). Both drive the same visual through every panel's
  // setEmphasis: the focused node's card shows, its cross-link-connected
  // nodes' labels scale up, everything else dims, and the relationship curves
  // touching it reveal. The neighbourhood is exactly the cross-link set —
  // in-panel links are a hidden hub-and-spoke, so they carry no adjacency.
  let pinned = null; // { key, chartId, nodeId, getPos } | null

  function focusVisual(chartId, nodeId, canvasPos) {
    const focusKey = `${chartId}::${nodeId}`;
    const nbrKeys = relatedCrossNodeKeys(chartId, nodeId); // includes focusKey
    panels.forEach(panel => panel.setEmphasis(focusKey, nbrKeys));

    setNodeCrossLinksVisible(nodeId, canvasPos, true);
    linkOverlay.selectAll("g.cross-link").each(function(d) {
      const active = d.sourceNode === nodeId || d.targetNode === nodeId;
      d3.select(this).attr("opacity", active ? 1 : 0.14);
    });
  }

  function clearVisual(prevNodeId) {
    panels.forEach(panel => panel.clearEmphasis());
    if (prevNodeId != null) setNodeCrossLinksVisible(prevNodeId, null, false);
    linkOverlay.selectAll("g.cross-link").attr("opacity", 1);
  }

  function updateCrossLinks() {
    const lookup = new Map();

    panels.forEach(panel => {
      panel.nodes.forEach(d => {
        lookup.set(`${panel.chart.id}::${d.id}`, {
          x: panel.x0 + d.x,
          y: panel.y0 + d.y
        });
      });
    });

    hubs.forEach(h => {
      lookup.set(`hub::${h.id}`, hubPosition);
    });

    const connectors = crossLinks.map((d, i) => {
      const source = lookup.get(endpointKey(d.source));
      const target = lookup.get(endpointKey(d.target));
      if (!source || !target) return null;

      let sx = source.x;
      let sy = source.y;
      let tx = target.x;
      let ty = target.y;

      if (tx < sx) {
        [sx, tx] = [tx, sx];
        [sy, ty] = [ty, sy];
      }

      const curveDist = d.curveDist ?? 0.18;
      const baseCurve = crossCurveWithControl(sx, sy, tx, ty, curveDist);
      const mainPath = offsetQuadCurve(baseCurve, -2.28);
      const secondPath = offsetQuadCurve(baseCurve, 2.28);
      const swapped = tx !== target.x; // did we flip x1/x2 above?

      // Two candidate label spots, near each end of the curve — swap
      // accounted for, so "start" always maps back to the true source.
      const endOffsetT = Math.min(0.49, Math.max(0.01, settings.labelEndOffsetPct / 100));
      const nearStart = quadPoint(baseCurve.x1, baseCurve.y1, baseCurve.cx, baseCurve.cy, baseCurve.x2, baseCurve.y2, endOffsetT);
      const nearEnd = quadPoint(baseCurve.x1, baseCurve.y1, baseCurve.cx, baseCurve.cy, baseCurve.x2, baseCurve.y2, 1 - endOffsetT);
      const sourceEnd = swapped ? nearEnd : nearStart;
      const targetEnd = swapped ? nearStart : nearEnd;

      return {
        key: `${endpointKey(d.source)}->${endpointKey(d.target)}`,
        gradientId: `cross-grad-${i}`,
        sourceNode: d.source.node ?? d.source.hub,
        targetNode: d.target.node ?? d.target.hub,
        group: d.group,
        source,
        target,
        label: d.label || "",
        curveDist: d.curveDist,
        sourceColor: endpointColor(d.source),
        targetColor: endpointColor(d.target),
        mainPath,
        secondPath,
        sourceEnd,
        targetEnd
      };
    }).filter(Boolean);

    const groups = linkOverlay
      .selectAll("g.cross-link")
      .data(connectors, d => d.key)
      .join(enter => {
        const g = enter.append("g")
          .attr("class", "cross-link")
          .attr("fill", "none")
          .attr("stroke-linecap", "round")
          .attr("stroke-linejoin", "round");

        // Wide, invisible stroke purely for hover/tap hit-testing — the
        // visible strokes are too thin (and too fiddly on touch) to hover
        // reliably otherwise.
        g.append("path")
          .attr("class", "hit")
          .attr("stroke", "transparent")
          .attr("stroke-width", 26)
          .style("pointer-events", "stroke")
          .style("cursor", "pointer");

        g.append("path").attr("class", "main").style("opacity", 0);
        g.append("path").attr("class", "secondary").style("opacity", 0);

        // Reveal is node-hover-driven only (see node.on("mouseenter")) —
        // clicking or tapping the line itself must never be what reveals
        // it from cold. On mobile there's no hover phase, so a tap fires
        // "click" directly — if the click handler pinned unconditionally,
        // tapping any invisible line would reveal it, which is exactly
        // the bug this guards against. A click only ever pins a link
        // that's already visible via a node hover; it keeps showing near
        // whichever end most recently triggered it (linkTriggerPosition
        // already has that).
        g.on("click", function(event, d) {
          event.stopPropagation();
          if (pinnedCrossLinks.has(d.key)) {
            pinnedCrossLinks.delete(d.key);
            if (!hoveredCrossLinkKeys.has(d.key)) setCrossLinkVisible(d3.select(this), false);
          } else if (hoveredCrossLinkKeys.has(d.key)) {
            pinnedCrossLinks.add(d.key);
            setCrossLinkVisible(d3.select(this), true);
          }
        });

        return g;
      });

    groups.each(function(d) {
      const g = d3.select(this);

      g.select(".hit").attr("d", d.mainPath);

      const grad = ensureGradient(
        d.gradientId,
        d.source.x, d.source.y,
        d.target.x, d.target.y,
        d.sourceColor, d.targetColor
      );

      if (brushStyle === "original") {
        g.select(".main")
          .attr("d", d.mainPath)
          .attr("stroke", grad)
          .attr("stroke-width", 3.2)
          // .attr("stroke-dasharray", "5,6")
          .attr("filter", null);

        g.select(".secondary")
          .attr("d", null)
          .attr("stroke", "none")
          .attr("filter", null);
      }

      if (brushStyle === "marker") {
        g.select(".main")
          .attr("d", d.mainPath)
          .attr("stroke", grad)
          .attr("stroke-width", 5.2)
          .attr("stroke-dasharray", null)
          .attr("filter", "url(#markerStroke)");

        g.select(".secondary")
          .attr("d", d.secondPath)
          .attr("stroke", grad)
          .attr("stroke-width", 2.1)
          .attr("stroke-dasharray", null)
          .attr("filter", "url(#markerStroke)");
      }

      if (brushStyle === "dry") {
        // Same widths/colors whether settled or not, so there's no visible
        // "pop" — only the noisy filtered edge switches on once still.
        g.select(".main")
          .attr("d", d.mainPath)
          .attr("stroke", grad)
          .attr("stroke-width", 5.8)
          .attr("stroke-opacity", 0.98)
          .attr("stroke-dasharray", null)
          .attr("filter", crossLinksSettled ? "url(#dryBrushStroke)" : null);

        g.select(".secondary")
          .attr("d", d.secondPath)
          .attr("stroke", grad)
          .attr("stroke-width", 3.2)
          .attr("stroke-opacity", 0.92)
          .attr("stroke-dasharray", null)
          .attr("filter", crossLinksSettled ? "url(#dryBrushStroke2)" : null);
      }

      // Keep opacity in sync with hover/pin state across re-renders (e.g.
      // while dragging a node whose link is pinned open).
      const linkVisible = isCrossLabelVisible(d.key) ? 1 : 0;
      g.select(".main").style("opacity", linkVisible);
      g.select(".secondary").style("opacity", linkVisible);
    });

    // Labels live in their own layer, appended after linkOverlay, so they
    // always render above every cross-link line regardless of which links
    // happen to be visible at once.
    const labelGroups = crossLabelLayer
      .selectAll("g.cross-label-group")
      .data(connectors, d => d.key)
      .join(enter => {
        const lg = enter.append("g")
          .attr("class", "cross-label-group")
          .attr("display", showCrossLabels ? null : "none")
          .style("opacity", 0)
          .style("pointer-events", "none");

        lg.append("path").attr("class", "label-swipe");

        lg.append("text")
          .attr("class", "cross-label")
          .attr("font-size", settings.crossLabelFontSize)
          .attr("font-weight", 700)
          .attr("fill", "#334155")
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "middle");

        return lg;
      });

    labelGroups.each(function(d) {
      const lg = d3.select(this);

      // Show the label near whichever end is closest to the node that
      // most recently triggered this link's visibility. For a directly
      // touched link that's obviously its own end; for a link pulled in
      // via group-expansion (e.g. the third side of a triangle) the
      // trigger node isn't literally an endpoint, so pick geometrically.
      const trigger = linkTriggerPosition.get(d.key);
      let pos = d.sourceEnd;
      if (trigger) {
        const dSource = (trigger.x - d.sourceEnd.x) ** 2 + (trigger.y - d.sourceEnd.y) ** 2;
        const dTarget = (trigger.x - d.targetEnd.x) ** 2 + (trigger.y - d.targetEnd.y) ** 2;
        pos = dTarget < dSource ? d.targetEnd : d.sourceEnd;
      }

      lg.attr("display", (showCrossLabels && d.label?.trim()) ? null : "none")
        .attr("transform", `translate(${pos.x},${pos.y})`)
        .style("opacity", isCrossLabelVisible(d.key) ? 1 : 0);

      const textSel = lg.select(".cross-label");

      if (showCrossLabels && d.label?.trim()) {
        wrapTextTspans(textSel, d.label, settings.crossLabelMaxChars, settings.crossLabelFontSize * 1.1);

        const textNode = textSel.node();
        const bbox = cachedTextBBox(textNode, `cross:${d.label}`);
        const w = bbox.width + 18;
        const h = bbox.height + 0;

        lg.select(".label-swipe")
          .attr("d", markerSwipePath(0, 0, w, h))
          .attr("fill", "#D6EDD3")
          .attr("fill-opacity", 0.92);
      }
    });

    syncHubVisibility(connectors);
  }

  function renderHubs() {
    // Same visual language as a cross-link label — the .cross-label class
    // picks up the Contee script font from the stylesheet in cell _4, and
    // the swipe path is the same hand-drawn highlight shape used elsewhere.
    const hubGroups = hubLayer
      .selectAll("g.hub-node")
      .data(hubs, d => d.id)
      .join(enter => {
        const g = enter.append("g").attr("class", "hub-node").style("opacity", 0);
        g.append("path").attr("class", "label-swipe");
        g.append("text")
          .attr("class", "cross-label")
          .attr("font-size", settings.crossLabelFontSize)
          .attr("font-weight", 700)
          .attr("fill", "#D6EDD3")
          .attr("text-anchor", "middle")
          .attr("dominant-baseline", "middle");
        return g;
      });

    hubGroups
      .attr("transform", `translate(${hubPosition.x},${hubPosition.y})`);

    hubGroups.each(function(d) {
      const g = d3.select(this);
      g.select(".cross-label").text(d.id);

      const textNode = g.select(".cross-label").node();
      const bbox = cachedTextBBox(textNode, `hub:${d.id}`);
      const w = bbox.width + 18;
      const h = bbox.height + 0;

      g.select(".label-swipe")
        .attr("d", markerSwipePath(0, 0, w, h))
        .attr("fill", hubColor)
        .attr("fill-opacity", 0.92);
    });
  }

  // Hub label only shows while one of its own connections is active (i.e.
  // a node it's linked to is hovered, or that link is pinned). This runs
  // on every settle/drag frame via updateCrossLinks(), so a plain style
  // set (not a fresh transition each time) avoids restarting mid-fade.
  function syncHubVisibility(connectors) {
    hubLayer.selectAll("g.hub-node").each(function(hub) {
      const visible = connectors.some(c =>
        (c.sourceNode === hub.id || c.targetNode === hub.id) && isCrossLabelVisible(c.key)
      );
      d3.select(this).style("opacity", visible ? 1 : 0);
    });
  }

  const zoom = d3.zoom()
    .scaleExtent([0.6, 3])
    .on("zoom", event => zoomLayer.attr("transform", event.transform));

  svg.style("cursor", "grab").call(zoom);
  svg.on("mousedown", () => svg.style("cursor", "grabbing"));
  svg.on("mouseup", () => svg.style("cursor", "grab"));
  svg.on("mouseleave", () => svg.style("cursor", "grab"));

  // Clicking empty canvas clears any pinned node. Guarded against pans: a
  // drag-to-pan ends in a click event too, so only a click with no
  // intervening zoom move counts. Node and cross-link clicks stopPropagation,
  // so they never reach here.
  // Only a *user* pan counts as a move — the initial centering (and any other
  // programmatic zoom.transform) fires zoom events with a null sourceEvent,
  // and must not leave zoomMoved stuck true or the first canvas click would
  // always be swallowed.
  let zoomMoved = false;
  zoom.on("start.pinclear", () => { zoomMoved = false; })
      .on("zoom.pinclear", (event) => { if (event.sourceEvent) zoomMoved = true; });
  svg.on("click.pinclear", () => {
    if (zoomMoved) { zoomMoved = false; return; }
    if (pinned) {
      const prev = pinned.nodeId;
      pinned = null;
      clearVisual(prev);
    }
  });

  charts.forEach((chart, index) => {
    panels.push(makePanel(chart, index));
  });

  // Bandwidth/thresholds changes need each panel's density re-rendered;
  // node-label max-width needs a re-wrap (it's normally wrapped once, not
  // every frame); cross-link max-width/end-offset flow through the next
  // updateCrossLinks() pass automatically since that already re-wraps
  // every cycle. Clearing the bbox cache covers both max-width settings —
  // a stale cached size from the old wrap width would otherwise stick.
  function refreshAllSettings() {
    labelBBoxCache.clear();
    panels.forEach(p => {
      p.renderDensity();
      p.refreshNodeLabels();
    });
    // Cross-link/hub label font-size is only set once at element creation,
    // not every render pass — update existing elements directly here.
    crossLabelLayer.selectAll(".cross-label").attr("font-size", settings.crossLabelFontSize);
    hubLayer.selectAll(".cross-label").attr("font-size", settings.crossLabelFontSize);
    requestCrossLinksUpdate();
    saveSettings();
  }

  crossLabelLayer = zoomLayer.append("g").attr("pointer-events", "none");

  renderHubs();
  updateCrossLinks();
  // Both calls above run while the SVG is still detached from the document
  // (Observable only attaches the returned node after this cell resolves),
  // so any getBBox() measurement they took is bogus. updateCrossLinks()
  // gets a second, correct pass for free via the crossLinksDirty timer
  // once dragging/settling happens — renderHubs() has no such follow-up,
  // so give it one explicitly once the node is actually on the page.
  requestAnimationFrame(renderHubs);

  // Center the (possibly capped, see settings.maxContentWPct/HPct above)
  // content cluster within the full-bleed canvas, with a small 0.92 scale-down for
  // breathing room from the edges either way.
  const initialScale = 0.92;
  svg.call(
    zoom.transform,
    d3.zoomIdentity
      .translate(
        (viewportW - contentW * initialScale) / 2,
        (viewportH - contentH * initialScale) / 2
      )
      .scale(initialScale)
  );

  // Small dev-facing settings panel — bottom right, collapsed by default —
  // for tweaking the contour/label tuning knobs live without editing code.
  const settingsPanel = d3.create("div")
    .style("position", "fixed")
    .style("right", "12px")
    .style("bottom", "12px")
    .style("z-index", "10")
    .style("font-family", "system-ui, sans-serif")
    .style("font-size", "12px")
    .style("color", "#1b1e23");

  const settingsToggle = settingsPanel.append("button")
    .text("⚙ Settings")
    .style("padding", "7px 12px")
    .style("border-radius", "8px")
    .style("border", "1px solid #d8d5cd")
    .style("background", "#fff")
    .style("box-shadow", "0 2px 8px rgba(0,0,0,0.12)")
    .style("cursor", "pointer");

  const settingsBody = settingsPanel.append("div")
    .style("display", "none")
    .style("margin-top", "8px")
    .style("padding", "14px")
    .style("width", "220px")
    .style("background", "#fff")
    .style("border-radius", "10px")
    .style("box-shadow", "0 4px 20px rgba(0,0,0,0.15)");

  settingsToggle.on("click", () => {
    const hidden = settingsBody.style("display") === "none";
    settingsBody.style("display", hidden ? "block" : "none");
  });

  function addSettingSlider(label, key, min, max, step) {
    const row = settingsBody.append("div").style("margin-bottom", "12px");
    const header = row.append("div")
      .style("display", "flex")
      .style("justify-content", "space-between")
      .style("margin-bottom", "4px");
    header.append("span").text(label);
    const valueLabel = header.append("span").style("color", "#6b7280").text(settings[key]);

    row.append("input")
      .attr("type", "range")
      .attr("min", min)
      .attr("max", max)
      .attr("step", step)
      .property("value", settings[key])
      .style("width", "100%")
      .on("input", function() {
        settings[key] = +this.value;
        valueLabel.text(this.value);
        refreshAllSettings();
      });
  }

  addSettingSlider("Contour bandwidth", "bandwidth", 20, 200, 5);
  addSettingSlider("Contour thresholds", "thresholds", 1, 8, 1);
  addSettingSlider("Cross-link label max-width (ch)", "crossLabelMaxChars", 8, 40, 1);
  addSettingSlider("Node label max-width (ch)", "nodeLabelMaxChars", 8, 40, 1);
  addSettingSlider("Label end offset (%)", "labelEndOffsetPct", 5, 45, 1);
  addSettingSlider("Cross-link label font size", "crossLabelFontSize", 8, 32, 1);
  addSettingSlider("Node label font size", "nodeLabelFontSize", 5, 16, 1);

  // Max content width/height drive the whole layout construction (panel
  // sizes, force simulation targets, badge corners, hub position — all
  // computed once up front), not just a render pass, so unlike the sliders
  // above these can't be applied live. Saved immediately; a reload picks
  // them up (loadStoredSettings() above already merges saved values in).
  settingsBody.append("div")
    .style("margin", "4px 0 12px")
    .style("border-top", "1px solid #eee");

  function addDeferredSettingSlider(label, key, min, max, step) {
    const row = settingsBody.append("div").style("margin-bottom", "12px");
    const header = row.append("div")
      .style("display", "flex")
      .style("justify-content", "space-between")
      .style("margin-bottom", "4px");
    header.append("span").text(label);
    const valueLabel = header.append("span").style("color", "#6b7280").text(settings[key]);

    row.append("input")
      .attr("type", "range")
      .attr("min", min)
      .attr("max", max)
      .attr("step", step)
      .property("value", settings[key])
      .style("width", "100%")
      .on("input", function() {
        settings[key] = +this.value;
        valueLabel.text(this.value);
        saveSettings();
        reloadHint.style("display", "block");
      });
  }

  addDeferredSettingSlider("Card width (px)", "cardWidth", 120, 280, 4);
  addDeferredSettingSlider("Card title font (rem)", "cardLabelRem", 0.375, 1.5, 0.0625);
  addDeferredSettingSlider("Card partner font (rem)", "cardPartnerRem", 0.375, 1.5, 0.0625);
  addDeferredSettingSlider("Card stage font (rem)", "cardStageRem", 0.375, 1.5, 0.0625);
  addDeferredSettingSlider("Card padding top (rem)", "cardPadTop", 0, 1.5, 0.125);
  addDeferredSettingSlider("Card padding bottom (rem)", "cardPadBottom", 0, 1.5, 0.125);
  addDeferredSettingSlider("Card padding H (rem)", "cardPadH", 0, 1.5, 0.125);
  addDeferredSettingSlider("Max panel-cluster width (% of screen)", "maxContentWPct", 20, 100, 1);
  addDeferredSettingSlider("Max panel-cluster height (% of screen)", "maxContentHPct", 20, 100, 1);

  const reloadHint = settingsBody.append("button")
    .text("Reload to apply size change")
    .style("display", "none")
    .style("width", "100%")
    .style("padding", "8px")
    .style("border-radius", "6px")
    .style("border", "1px solid #d8d5cd")
    .style("background", "#F2F1ED")
    .style("cursor", "pointer")
    .on("click", () => location.reload());

  const wrapper = d3.create("div").style("position", "relative");
  wrapper.node().appendChild(svg.node());
  wrapper.node().appendChild(settingsPanel.node());

  return wrapper.node();
}


function _3(html){return(
html`<link rel="stylesheet" href="https://use.typekit.net/syg3laf.css">`
)}

function _4(html){return(
html`<style>

  .poppins {
    font-family: "poppins", sans-serif;
    font-weight: 300;
    font-style: normal;
  }

.cross-label {
font-family: "Contee", sans-serif;
    font-weight: 300;
    font-style: normal;
}
</style>`
)}

function _addFonts(FontFace){return(
(
  fonts // [{ fontFamily, url, style, weight, stretch }]
) => {
  const fontNames = fonts.map((f) => {
    const fontFace = new FontFace(f.fontFamily, `url(${f.url})`, {
      style: f.style ?? "normal",
      weight: f.weight ?? "normal",
      stretch: f.stretch ?? "normal"
    });
    fontFace.load();
    document.fonts.add(fontFace);
    return f;
  });
  return fontNames;
}
)}

async function _6(addFonts,FileAttachment){return(
addFonts([
  {
    fontFamily: "Contee",
    url: await FileAttachment("Contee Script Plus.ttf").url(),
    style: "normal",
    weight: "300",
    stretch: "expanded"
  }
])
)}

function _7(htl){return(
htl.html`<p style="font-family:'Contee';"> ✨ <span style="font-weight:bold;font-stretch:expanded;">Custom</span> Font via FileAttachement and FontFace API. 👻</p> `
)}

export default function define(runtime, observer) {
  const main = runtime.module();
  function toString() { return this.url; }
  const fileAttachments = new Map([
    ["culturalnarrative@1.png", {url: new URL("./files/7191241aa5c27144c921c85b7423715d8bdf1447965d62d20588d2d3549f43de47f02c9568c0f6ae12bc092c1336f886d9a6f4ebb4d17fde455110f83b44bd6e.png", import.meta.url), mimeType: "image/png", toString}],
    ["healthyocean@1.png", {url: new URL("./files/669813c32961b8dbe05210c732c0afb325e4912d5a91739a6cb315b3e9be053fd1c41313260eafd3c912439827b984aac5350da4f0338948cbff90279944c513.png", import.meta.url), mimeType: "image/png", toString}],
    ["inclusivecommu@1.png", {url: new URL("./files/31b81a3dccddc4fa8502d7832655315ae923db3905eea06e716febc50d8903292422e2013bab43cdf47ec16e914b0ad800eacf56ded5dee1297d933bb6583551.png", import.meta.url), mimeType: "image/png", toString}],
    ["regenland@1.png", {url: new URL("./files/a4dad551a2adddb442a460136730dee1d78031e8592b08f7073a4920b87c848cf9d12dfc0db7efdd8efd13fd4abe73d3520fe7187293b6cdc0a6baff8b0fd368.png", import.meta.url), mimeType: "image/png", toString}],
    ["Contee Script Plus.ttf", {url: new URL("./files/f4a0bc9bc707cb1e11d0eb97ab62a66a14f2f2aa320e356c66186ebeba1b6ee6448b341c3de9dceed953aec3c4e0db819ad8c5b8f532fff71811f5ca51b2f7d6.ttf", import.meta.url), mimeType: "font/ttf", toString}],
    ["bullet-4.svg", {url: new URL("./files/eac0c2831435ae2837b28ad11bc75ca79f07e3a6279e73b3f5b96471030ad325bf462b3c147a095bcb2e5908c6a35ef3e8cd66e83129466d88a5e6cf135db98d.svg", import.meta.url), mimeType: "image/svg+xml", toString}],
    ["bullet-1.svg", {url: new URL("./files/686dbab0cb97e7a055a2a16a2a66e009780de57f1386ab7d9ee6abdd75aee055a55a9a30d728d358c82ebbcfa128d6a74762373904e070ca553b4742070765be.svg", import.meta.url), mimeType: "image/svg+xml", toString}],
    ["bullet-3.svg", {url: new URL("./files/c844eb6f66527f62cc17b06b002b384289b1ca8666cf58e3654beb7901789db14bd2110e93f45066cc4b87f317cec73b03e4f5ecfa618b77bc7d887a61f46ed2.svg", import.meta.url), mimeType: "image/svg+xml", toString}],
    ["bullet-2.svg", {url: new URL("./files/3433e3263c31b11c3a5e1e66f95e132da60332c24c695415390f6f0e7e4145f03d434d63d34be0a66dcc2079bbbfe2d0fa5174a1ec72afcce8cabbfa68c34fb3.svg", import.meta.url), mimeType: "image/svg+xml", toString}]
  ]);
  main.builtin("FileAttachment", runtime.fileAttachments(name => fileAttachments.get(name)));
  main.variable(observer()).define(["md"], _1);
  main.variable(observer()).define(["FileAttachment","d3"], _2);
  main.variable(observer()).define(["html"], _3);
  main.variable(observer()).define(["html"], _4);
  main.variable(observer("addFonts")).define("addFonts", ["FontFace"], _addFonts);
  main.variable(observer()).define(["addFonts","FileAttachment"], _6);
  main.variable(observer()).define(["htl"], _7);
  return main;
}
