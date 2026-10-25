# Moth Download Flow Visualization — Design Brief

## Purpose

This brief captures the requested visual direction for Moth's download flow
visualization and documents the current implementation for review.

## Target design

### Minimal dedicated window or canvas

- Enter directly into a clean visual stage. Do not put a bulky header,
  Internet Source card, speed-cap form, or explanatory text wall in front of
  the map.
- Make the map the primary surface: dark, focused, and reminiscent of a circuit
  board, interactive node graph, or network topology.
- Use a single compact ingress orb/gateway at the top center, labeled simply
  **WAN** or represented by incoming packets.
- Keep aggregate speed and file count in a tiny floating HUD pill in a corner.
  Put exit/back in a similarly unobtrusive action.
- Preserve a way to return to Moth's ordinary download list without making the
  visualization feel like another settings page.

### Main pipeline and splitting flow

- Draw the Internet ingress at the top (or visually central), feeding one
  prominent conduit/trunk downward through the canvas.
- Make the moving flow respond to real aggregate download bandwidth: particle
  speed, pulse intensity, or conduit thickness should communicate current
  throughput rather than play as unrelated decoration.
- Use smooth cubic Bezier curves for the trunk splits and branches. Avoid rigid
  90-degree org-chart connectors.
- Animate light streaks or particles along the trunk. Active download branches
  should carry their own moving particles; paused/idle branches should dim to a
  faint wire and stop flowing.
- Show state in the branch itself. Active transfers can glow or carry moving
  particles; paused, queued, or otherwise idle downloads should have dim or
  still connections so they are distinguishable at a glance.

### File nodes as terminal blocks

- Make each file a clearly wired endpoint node or terminal block, not a generic
  web card pinned beside a timeline.
- Use compact, balanced square/rounded cards, roughly 200–220 px per side as a
  starting point. Arrange them in a balanced tree or staggered two-column
  layout; avoid wide stretched list rows and large empty side gaps.
- Put a file-type icon and truncated bold filename at the top.
- In the middle, show a circular progress ring or distinctive fill block, with
  percentage and current rate available without overwhelming the visual.
- Keep micro-controls at the bottom: round pause/resume, cancel, and a compact
  settings/menu affordance for speed caps and details.
- Reveal controls contextually when a node is hovered, focused, or clicked.
  Depending on the interaction, show pause/resume, speed cap, details, and
  other quick actions inline or in a compact node overlay.
- Keep download management available from the visualization while letting the
  map—not a permanent panel of buttons—remain the focus.

### Pipeline organization to decide

The proposed sketch shows files in multiple levels: the trunk splits into a
pair of nodes, then their connections curve back toward a lower trunk before
splitting again. Decide whether downloads should instead attach as branches
along one continuous top-to-bottom trunk, or be placed as repeated/radial
clusters in a tree. Whichever pattern is chosen, the curves should remain
clearly connected, organic, and easy to follow.

### Interaction and accessibility

- Nodes and contextual controls must be keyboard reachable and have accessible
  names; hover cannot be the only way to reveal or operate controls.
- Respect reduced-motion preferences while retaining clear active/paused
  state and progress cues.
- Keep the layout legible as the number of downloads grows and adapt the graph
  for narrow windows without losing visible source-to-file connections.

## Current preview

The current implementation is a full-screen canvas inside Moth's existing
window, opened from the **Flow** button in the header. The ordinary download
list remains behind it; it is not a separate desktop window.

The canvas has a small floating HUD for aggregate speed and file/active counts,
plus compact add and exit buttons. The **WAN** gateway can be opened to
change the global speed cap without leaving the map. A gently curving vertical
trunk feeds pairs of left/right downloads through smooth branches into compact
220-pixel terminal nodes. Branches leave each split in the trunk's downward
direction, then sweep horizontally into the measured file ports so junctions
avoid sharp elbows and connections stay attached at different window widths. The
trunk and branches share one map-sized SVG coordinate system. Paused/idle
branches are dimmed. The trunk terminates at the last split rather than
continuing below the final downloads.

Moving brand-colored pulses start at the WAN outlet, follow the whole trunk,
and curve to the active file port; each has a visible head and a soft short
trail. Aggregate throughput controls the trunk thickness, pulse launch rate,
and travel speed, so higher traffic reads as a denser, faster flow. Idle
branches do not receive pulses. Reduced-motion preferences stop the moving
pulses while retaining the active branch and speed cues.

Each node shows a file-type icon, truncated filename, circular progress ring,
status, current rate and optional ETA. Pause/resume/retry/cancel, speed-cap,
and **Details** buttons appear on hover or keyboard focus. **Details** opens a
full download dialog with source and destination actions, queue priority,
speed/quota controls, media metadata, transfer diagnostics, and the durable
chunk map. Drag a node by its filename
card to reposition it; positions are saved locally, and new downloads keep
their automatic placement. Drag the empty canvas to pan around the map, or use
the mouse wheel when the map overflows; scrollbars stay hidden. Keyboard users
can focus a filename header and move
its node with Alt+Arrow keys. Connectors and active packet paths follow moved
nodes. The old always-visible shared-cap form and source card are removed.

Flow shows the real download queue; controls always operate on the selected
download and never on presentation-only sample data. Completed and canceled
items are omitted from the live graph; other queue states remain visible so
queued, paused, connecting, and active work can be distinguished.
Torrent downloads use the same connected node and progress path as other real
queue items; their Details view reports connected peers and their per-torrent
download/upload caps. The WAN aggregate cap applies to regular HTTP and
yt-dlp media transfers, but not to torrents, which use Transmission's separate
engine. Flow does not draw individual peer connections.

The stage and its controls use Moth's surface, ink, ambient-glow, and brand
tokens, so Graphite, Amber, and Light themes remain part of the same interface.
The canvas supports keyboard focus, and the mobile layout keeps the diagram
scrollable rather than hiding branches.

## Design discussion goal

The map remains inside the main window as a dedicated overlay. Node controls
appear on hover or keyboard focus, and downloads are grouped in pairs along
one continuous curved trunk.
