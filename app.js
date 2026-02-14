// ═══════════════════════════════════════════════════════════════════
// Room Layout Planner — Main Application
// ═══════════════════════════════════════════════════════════════════
(function () {
  "use strict";

  // ── Constants ──
  const INCHES_PER_FOOT = 12;
  const WALL_THICKNESS = 6; // visual wall thickness in inches
  const ROTATION_STEP = 45; // degrees
  const GRID_SIZE = 6; // inches (6" grid)
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 0.15;
  const OPENING_COLORS = {
    door: "#f39c12",
    window: "#3498db",
    closet: "#9b59b6",
    none: "transparent",
  };
  const DEFAULT_FURNITURE_COLORS = [
    "#e94560","#2ecc71","#3498db","#f39c12","#9b59b6",
    "#1abc9c","#e67e22","#e74c3c","#00cec9","#fd79a8",
  ];

  // ── State ──
  const state = {
    room: { name: "My Room", walls: [], openings: [] },
    furniturePalette: [],   // definitions from CSV/manual
    placedFurniture: [],    // items on canvas with x,y,rotation
    selectedId: null,
    dragging: null,         // { id, offsetX, offsetY }
    pan: { x: 0, y: 0 },
    zoom: 1,
    panning: false,
    panStart: { x: 0, y: 0 },
    gridSnap: true,
    showMeasurements: false,
    nextId: 1,
    roomBounds: null,       // computed { minX, minY, maxX, maxY, width, height }
    wallSegments: [],       // computed line segments [{x1,y1,x2,y2,name,length}]
    openingRects: [],       // computed [{x,y,w,h,type}]
  };

  // ── DOM refs ──
  const $ = (sel) => document.querySelector(sel);
  const canvas = $("#roomCanvas");
  const ctx = canvas.getContext("2d");

  // ── Utility helpers ──
  function uid() { return state.nextId++; }

  function degToRad(d) { return (d * Math.PI) / 180; }

  function snapToGrid(v) {
    return state.gridSnap ? Math.round(v / GRID_SIZE) * GRID_SIZE : v;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function inchesToFeetStr(inches) {
    const ft = Math.floor(inches / 12);
    const rem = Math.round(inches % 12);
    return rem === 0 ? `${ft}'` : `${ft}' ${rem}"`;
  }

  // Parse a simple CSV string into array of objects
  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(",").map((v) => v.trim());
      if (vals.length < headers.length) continue;
      const obj = {};
      headers.forEach((h, idx) => (obj[h] = vals[idx]));
      rows.push(obj);
    }
    return rows;
  }

  // ── Room Geometry Builder ──
  // Converts wall list into a polygon of line segments.
  // Walls are placed in order: north (top), east (right), south (bottom), west (left).
  // For arbitrary wall names, we lay them out as a rectangle using opposite pairs.
  function buildRoomGeometry() {
    const walls = state.room.walls;
    if (walls.length === 0) {
      state.wallSegments = [];
      state.openingRects = [];
      state.roomBounds = null;
      return;
    }

    // Try to find standard walls
    const byName = {};
    walls.forEach((w) => (byName[w.name.toLowerCase()] = w));

    let segments = [];
    let roomW, roomH;

    if (byName.north && byName.south && byName.east && byName.west) {
      // Standard rectangular room
      roomW = Math.max(byName.north.length, byName.south.length);
      roomH = Math.max(byName.east.length, byName.west.length);
      segments = [
        { x1: 0, y1: 0, x2: roomW, y2: 0, wall: byName.north, name: "north" },
        { x1: roomW, y1: 0, x2: roomW, y2: roomH, wall: byName.east, name: "east" },
        { x1: roomW, y1: roomH, x2: 0, y2: roomH, wall: byName.south, name: "south" },
        { x1: 0, y1: roomH, x2: 0, y2: 0, wall: byName.west, name: "west" },
      ];
    } else {
      // Fallback: lay walls end-to-end as a polygon
      let cx = 0, cy = 0;
      const angles = [];
      const n = walls.length;
      const turnAngle = (2 * Math.PI) / n;
      let heading = 0; // start heading right
      // adjust so first wall is along top
      heading = 0;
      for (let i = 0; i < n; i++) {
        const w = walls[i];
        const ex = cx + w.length * Math.cos(heading);
        const ey = cy + w.length * Math.sin(heading);
        segments.push({ x1: cx, y1: cy, x2: ex, y2: ey, wall: w, name: w.name });
        cx = ex;
        cy = ey;
        heading += turnAngle;
      }
      // Normalize so min is 0,0
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      segments.forEach((s) => {
        minX = Math.min(minX, s.x1, s.x2);
        minY = Math.min(minY, s.y1, s.y2);
        maxX = Math.max(maxX, s.x1, s.x2);
        maxY = Math.max(maxY, s.y1, s.y2);
      });
      segments.forEach((s) => {
        s.x1 -= minX; s.y1 -= minY;
        s.x2 -= minX; s.y2 -= minY;
      });
      roomW = maxX - minX;
      roomH = maxY - minY;
    }

    state.wallSegments = segments;
    state.roomBounds = { minX: 0, minY: 0, maxX: roomW, maxY: roomH, width: roomW, height: roomH };

    // Build opening rectangles from wall segments
    state.openingRects = [];
    segments.forEach((seg) => {
      const wall = seg.wall;
      if (!wall || !wall.openings) return;
      wall.openings.forEach((op) => {
        if (op.type === "none") return;
        const dx = seg.x2 - seg.x1;
        const dy = seg.y2 - seg.y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return;
        const ux = dx / len, uy = dy / len; // unit along wall
        const nx = -uy, ny = ux;             // outward normal
        const sx = seg.x1 + ux * op.start;
        const sy = seg.y1 + uy * op.start;
        const halfT = WALL_THICKNESS / 2;
        // Opening rect aligned to wall
        state.openingRects.push({
          cx: sx + ux * op.width / 2,
          cy: sy + uy * op.width / 2,
          alongX: ux, alongY: uy,
          normX: nx, normY: ny,
          width: op.width,
          depth: WALL_THICKNESS + 12, // clearance zone extends 12" from wall
          type: op.type,
          wallName: seg.name,
          // Simple axis-aligned bounding box for collision (approximate)
          aabb: computeOpeningAABB(sx, sy, ux, uy, nx, ny, op.width, WALL_THICKNESS + 24),
        });
      });
    });
  }

  function computeOpeningAABB(sx, sy, ux, uy, nx, ny, width, depth) {
    const hw = width / 2;
    const hd = depth / 2;
    const cx = sx + ux * hw;
    const cy = sy + uy * hw;
    const corners = [
      { x: cx + ux * hw + nx * hd, y: cy + uy * hw + ny * hd },
      { x: cx - ux * hw + nx * hd, y: cy - uy * hw + ny * hd },
      { x: cx + ux * hw - nx * hd, y: cy + uy * hw - ny * hd },
      { x: cx - ux * hw - nx * hd, y: cy - uy * hw - ny * hd },
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    corners.forEach((c) => {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // ── Collision Detection ──
  // Returns the rotated bounding box corners of a placed furniture item
  function getFurnitureCorners(item) {
    const cx = item.x;
    const cy = item.y;
    const hw = item.width / 2;
    const hh = item.height / 2;
    const angle = degToRad(item.rotation || 0);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
      { x: cx + (-hw) * cos - (-hh) * sin, y: cy + (-hw) * sin + (-hh) * cos },
      { x: cx + ( hw) * cos - (-hh) * sin, y: cy + ( hw) * sin + (-hh) * cos },
      { x: cx + ( hw) * cos - ( hh) * sin, y: cy + ( hw) * sin + ( hh) * cos },
      { x: cx + (-hw) * cos - ( hh) * sin, y: cy + (-hw) * sin + ( hh) * cos },
    ];
  }

  function getAABB(corners) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    corners.forEach((c) => {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // Separating Axis Theorem for two convex polygons
  function polygonsOverlap(cornersA, cornersB) {
    function getAxes(corners) {
      const axes = [];
      for (let i = 0; i < corners.length; i++) {
        const j = (i + 1) % corners.length;
        const edge = { x: corners[j].x - corners[i].x, y: corners[j].y - corners[i].y };
        axes.push({ x: -edge.y, y: edge.x }); // perpendicular
      }
      return axes;
    }
    function project(corners, axis) {
      let min = Infinity, max = -Infinity;
      corners.forEach((c) => {
        const p = c.x * axis.x + c.y * axis.y;
        min = Math.min(min, p);
        max = Math.max(max, p);
      });
      return { min, max };
    }
    const axes = [...getAxes(cornersA), ...getAxes(cornersB)];
    for (const axis of axes) {
      const pA = project(cornersA, axis);
      const pB = project(cornersB, axis);
      if (pA.max <= pB.min || pB.max <= pA.min) return false;
    }
    return true;
  }

  function checkCollisions(item) {
    const cornersA = getFurnitureCorners(item);
    const collisions = [];

    // Check against other furniture
    for (const other of state.placedFurniture) {
      if (other.id === item.id) continue;
      const cornersB = getFurnitureCorners(other);
      if (polygonsOverlap(cornersA, cornersB)) {
        collisions.push({ type: "furniture", item: other });
      }
    }

    // Check against room bounds
    if (state.roomBounds) {
      const aabb = getAABB(cornersA);
      const rb = state.roomBounds;
      if (aabb.x < rb.minX || aabb.y < rb.minY ||
          aabb.x + aabb.w > rb.maxX || aabb.y + aabb.h > rb.maxY) {
        collisions.push({ type: "wall" });
      }
    }

    // Check against openings (doors/windows/closets clearance)
    for (const op of state.openingRects) {
      const obb = op.aabb;
      // Quick AABB pre-check
      const aabb = getAABB(cornersA);
      if (aabb.x < obb.x + obb.w && aabb.x + aabb.w > obb.x &&
          aabb.y < obb.y + obb.h && aabb.y + aabb.h > obb.y) {
        collisions.push({ type: "opening", opening: op });
      }
    }
    return collisions;
  }

  // ── Coordinate transforms ──
  function worldToScreen(wx, wy) {
    return {
      x: wx * state.zoom + state.pan.x,
      y: wy * state.zoom + state.pan.y,
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - state.pan.x) / state.zoom,
      y: (sy - state.pan.y) / state.zoom,
    };
  }

  // ── Rendering ──
  function render() {
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.translate(state.pan.x, state.pan.y);
    ctx.scale(state.zoom, state.zoom);

    if (state.roomBounds) {
      drawGrid();
      drawRoom();
      drawOpenings();
      drawFurniture();
      if (state.showMeasurements && state.selectedId !== null) {
        drawMeasurements();
      }
    }

    ctx.restore();
  }

  function drawGrid() {
    const rb = state.roomBounds;
    if (!rb) return;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 0.5;
    // Draw grid extending a bit beyond room
    const pad = 24;
    const startX = -pad;
    const startY = -pad;
    const endX = rb.width + pad;
    const endY = rb.height + pad;
    for (let x = startX; x <= endX; x += GRID_SIZE) {
      ctx.beginPath();
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
      ctx.stroke();
    }
    for (let y = startY; y <= endY; y += GRID_SIZE) {
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
      ctx.stroke();
    }
    // 1-foot grid (heavier)
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 0.8;
    for (let x = startX; x <= endX; x += 12) {
      ctx.beginPath();
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
      ctx.stroke();
    }
    for (let y = startY; y <= endY; y += 12) {
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRoom() {
    ctx.save();
    // Fill interior
    if (state.wallSegments.length > 0) {
      ctx.beginPath();
      ctx.moveTo(state.wallSegments[0].x1, state.wallSegments[0].y1);
      state.wallSegments.forEach((s) => ctx.lineTo(s.x2, s.y2));
      ctx.closePath();
      ctx.fillStyle = "#1a1a2e";
      ctx.fill();
    }

    // Draw walls
    ctx.lineWidth = WALL_THICKNESS;
    ctx.strokeStyle = "#4a4a6a";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    state.wallSegments.forEach((s, i) => {
      if (i === 0) ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
    });
    ctx.closePath();
    ctx.stroke();

    // Wall labels with dimensions
    ctx.font = "bold 5px sans-serif";
    ctx.fillStyle = "#a0a0b0";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    state.wallSegments.forEach((s) => {
      const mx = (s.x1 + s.x2) / 2;
      const my = (s.y1 + s.y2) / 2;
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      const len = Math.sqrt(dx * dx + dy * dy);
      // Offset label outward from wall
      const nx = -dy / len * 10;
      const ny = dx / len * 10;
      ctx.fillText(
        `${s.name.toUpperCase()} ${inchesToFeetStr(len)}`,
        mx + nx,
        my + ny
      );
    });

    ctx.restore();
  }

  function drawOpenings() {
    ctx.save();
    state.openingRects.forEach((op) => {
      // Draw the opening gap on the wall
      const color = OPENING_COLORS[op.type] || "#888";
      ctx.save();
      ctx.translate(op.cx, op.cy);
      const angle = Math.atan2(op.alongY, op.alongX);
      ctx.rotate(angle);

      // Clear the wall line by drawing over it
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(-op.width / 2, -WALL_THICKNESS / 2 - 1, op.width, WALL_THICKNESS + 2);

      // Draw opening indicator
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(-op.width / 2, -WALL_THICKNESS / 2, op.width, WALL_THICKNESS);
      ctx.setLineDash([]);

      // Door swing arc
      if (op.type === "door") {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.arc(-op.width / 2, 0, op.width, -Math.PI / 2, 0);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Window cross-hatch
      if (op.type === "window") {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        const hw = op.width / 2;
        const ht = WALL_THICKNESS / 2;
        ctx.beginPath();
        ctx.moveTo(-hw, -ht); ctx.lineTo(hw, ht);
        ctx.moveTo(hw, -ht); ctx.lineTo(-hw, ht);
        ctx.stroke();
      }

      // Closet double-line
      if (op.type === "closet") {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        const hw = op.width / 2;
        ctx.beginPath();
        ctx.moveTo(0, -WALL_THICKNESS / 2 - 2);
        ctx.lineTo(0, WALL_THICKNESS / 2 + 2);
        ctx.stroke();
      }

      // Label
      ctx.fillStyle = color;
      ctx.font = "bold 4px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(op.type.toUpperCase(), 0, -WALL_THICKNESS / 2 - 3);

      ctx.restore();
    });
    ctx.restore();
  }

  function drawFurniture() {
    state.placedFurniture.forEach((item) => {
      const isSelected = item.id === state.selectedId;
      const collisions = checkCollisions(item);
      const hasCollision = collisions.length > 0;

      ctx.save();
      ctx.translate(item.x, item.y);
      ctx.rotate(degToRad(item.rotation || 0));

      const hw = item.width / 2;
      const hh = item.height / 2;

      // Shadow
      ctx.shadowColor = "rgba(0,0,0,0.3)";
      ctx.shadowBlur = 4;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;

      // Body
      ctx.fillStyle = item.color || "#e94560";
      ctx.globalAlpha = hasCollision ? 0.5 : 0.85;
      ctx.beginPath();
      ctx.roundRect(-hw, -hh, item.width, item.height, 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.shadowColor = "transparent";

      // Border
      ctx.strokeStyle = hasCollision ? "#e74c3c" : isSelected ? "#fff" : "rgba(255,255,255,0.3)";
      ctx.lineWidth = isSelected ? 2 : 1;
      if (hasCollision) {
        ctx.setLineDash([3, 3]);
      }
      ctx.beginPath();
      ctx.roundRect(-hw, -hh, item.width, item.height, 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${Math.min(5, Math.min(item.width, item.height) * 0.3)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const label = item.name.length > 12 ? item.name.slice(0, 11) + "…" : item.name;
      ctx.fillText(label, 0, -2);

      // Size label
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = `${Math.min(4, Math.min(item.width, item.height) * 0.2)}px sans-serif`;
      ctx.fillText(`${inchesToFeetStr(item.width)} × ${inchesToFeetStr(item.height)}`, 0, 3);

      // Direction indicator (small triangle at "front")
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath();
      ctx.moveTo(0, -hh + 1);
      ctx.lineTo(-2, -hh + 4);
      ctx.lineTo(2, -hh + 4);
      ctx.closePath();
      ctx.fill();

      // Collision warning icon
      if (hasCollision) {
        ctx.fillStyle = "#e74c3c";
        ctx.font = "bold 6px sans-serif";
        ctx.fillText("⚠", hw - 4, -hh + 5);
      }

      ctx.restore();
    });
  }

  function drawMeasurements() {
    const sel = state.placedFurniture.find((f) => f.id === state.selectedId);
    if (!sel || !state.roomBounds) return;

    const corners = getFurnitureCorners(sel);
    const aabb = getAABB(corners);
    const rb = state.roomBounds;

    ctx.save();
    ctx.strokeStyle = "#e94560";
    ctx.fillStyle = "#e94560";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.font = "bold 4px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Distance to each wall
    const measurements = [
      { label: inchesToFeetStr(Math.round(aabb.y - rb.minY)), x1: sel.x, y1: rb.minY, x2: sel.x, y2: aabb.y, lx: sel.x - 8, ly: (rb.minY + aabb.y) / 2 },
      { label: inchesToFeetStr(Math.round(rb.maxY - (aabb.y + aabb.h))), x1: sel.x, y1: aabb.y + aabb.h, x2: sel.x, y2: rb.maxY, lx: sel.x - 8, ly: (aabb.y + aabb.h + rb.maxY) / 2 },
      { label: inchesToFeetStr(Math.round(aabb.x - rb.minX)), x1: rb.minX, y1: sel.y, x2: aabb.x, y2: sel.y, lx: (rb.minX + aabb.x) / 2, ly: sel.y - 5 },
      { label: inchesToFeetStr(Math.round(rb.maxX - (aabb.x + aabb.w))), x1: aabb.x + aabb.w, y1: sel.y, x2: rb.maxX, y2: sel.y, lx: (aabb.x + aabb.w + rb.maxX) / 2, ly: sel.y - 5 },
    ];

    measurements.forEach((m) => {
      ctx.beginPath();
      ctx.moveTo(m.x1, m.y1);
      ctx.lineTo(m.x2, m.y2);
      ctx.stroke();
      // Background for label
      const tw = ctx.measureText(m.label).width + 4;
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(m.lx - tw / 2, m.ly - 3, tw, 6);
      ctx.fillStyle = "#e94560";
      ctx.fillText(m.label, m.lx, m.ly);
    });

    // Distance to nearest furniture
    state.placedFurniture.forEach((other) => {
      if (other.id === sel.id) return;
      const aabbB = getAABB(getFurnitureCorners(other));
      // Simple center-to-center distance line
      const dist = Math.round(Math.sqrt((sel.x - other.x) ** 2 + (sel.y - other.y) ** 2));
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.beginPath();
      ctx.moveTo(sel.x, sel.y);
      ctx.lineTo(other.x, other.y);
      ctx.stroke();
      const mx = (sel.x + other.x) / 2;
      const my = (sel.y + other.y) / 2;
      ctx.fillStyle = "#1a1a2e";
      const label = inchesToFeetStr(dist);
      const tw = ctx.measureText(label).width + 4;
      ctx.fillRect(mx - tw / 2, my - 3, tw, 6);
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillText(label, mx, my);
    });

    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── Hit testing ──
  function hitTestFurniture(wx, wy) {
    // Reverse order so topmost item is hit first
    for (let i = state.placedFurniture.length - 1; i >= 0; i--) {
      const item = state.placedFurniture[i];
      const corners = getFurnitureCorners(item);
      if (pointInPolygon(wx, wy, corners)) return item;
    }
    return null;
  }

  function pointInPolygon(px, py, corners) {
    let inside = false;
    for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
      const xi = corners[i].x, yi = corners[i].y;
      const xj = corners[j].x, yj = corners[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // ── Canvas sizing ──
  function resizeCanvas() {
    const container = document.getElementById("canvasContainer");
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    render();
  }

  function fitToView() {
    if (!state.roomBounds) return;
    const container = document.getElementById("canvasContainer");
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const rb = state.roomBounds;
    const padding = 80;
    const scaleX = (cw - padding * 2) / rb.width;
    const scaleY = (ch - padding * 2) / rb.height;
    state.zoom = Math.min(scaleX, scaleY);
    state.zoom = clamp(state.zoom, MIN_ZOOM, MAX_ZOOM);
    state.pan.x = (cw - rb.width * state.zoom) / 2;
    state.pan.y = (ch - rb.height * state.zoom) / 2;
    updateZoomLabel();
    render();
  }

  function updateZoomLabel() {
    $("#zoomLevel").textContent = `${Math.round(state.zoom * 100)}%`;
  }

  // ── Mouse / Touch Events ──
  function setupCanvasEvents() {
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDoubleClick);

    // Touch support
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
  }

  function onMouseDown(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = screenToWorld(sx, sy);

    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      // Middle-click or Alt+click: pan
      state.panning = true;
      state.panStart = { x: e.clientX - state.pan.x, y: e.clientY - state.pan.y };
      canvas.style.cursor = "grabbing";
      return;
    }

    if (e.button === 0) {
      const hit = hitTestFurniture(world.x, world.y);
      if (hit) {
        state.selectedId = hit.id;
        state.dragging = {
          id: hit.id,
          offsetX: world.x - hit.x,
          offsetY: world.y - hit.y,
        };
        canvas.style.cursor = "grabbing";
        updateSelectionInfo();
      } else {
        state.selectedId = null;
        state.dragging = null;
        hideSelectionInfo();
      }
      render();
    }
  }

  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (state.panning) {
      state.pan.x = e.clientX - state.panStart.x;
      state.pan.y = e.clientY - state.panStart.y;
      render();
      return;
    }

    if (state.dragging) {
      const world = screenToWorld(sx, sy);
      const item = state.placedFurniture.find((f) => f.id === state.dragging.id);
      if (item) {
        item.x = snapToGrid(world.x - state.dragging.offsetX);
        item.y = snapToGrid(world.y - state.dragging.offsetY);
        updateSelectionInfo();
        render();
      }
      return;
    }

    // Hover cursor
    const world = screenToWorld(sx, sy);
    const hit = hitTestFurniture(world.x, world.y);
    canvas.style.cursor = hit ? "grab" : "default";
  }

  function onMouseUp(e) {
    if (state.panning) {
      state.panning = false;
      canvas.style.cursor = "default";
      return;
    }
    if (state.dragging) {
      const item = state.placedFurniture.find((f) => f.id === state.dragging.id);
      if (item) {
        const collisions = checkCollisions(item);
        if (collisions.length > 0) {
          setStatus(`⚠ Collision detected: ${collisions.map(c => c.type).join(", ")}`, "warning");
        } else {
          setStatus("Item placed", "ok");
        }
      }
      state.dragging = null;
      canvas.style.cursor = "grab";
      render();
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const worldBefore = screenToWorld(sx, sy);
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    state.zoom = clamp(state.zoom + delta * state.zoom, MIN_ZOOM, MAX_ZOOM);
    // Keep mouse point stable
    state.pan.x = sx - worldBefore.x * state.zoom;
    state.pan.y = sy - worldBefore.y * state.zoom;
    updateZoomLabel();
    render();
  }

  function onDoubleClick(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    const hit = hitTestFurniture(world.x, world.y);
    if (hit) {
      hit.rotation = ((hit.rotation || 0) + ROTATION_STEP) % 360;
      state.selectedId = hit.id;
      updateSelectionInfo();
      render();
    }
  }

  // Touch support
  let lastTouchDist = 0;
  function onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const sx = t.clientX - rect.left;
      const sy = t.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      const hit = hitTestFurniture(world.x, world.y);
      if (hit) {
        state.selectedId = hit.id;
        state.dragging = { id: hit.id, offsetX: world.x - hit.x, offsetY: world.y - hit.y };
        updateSelectionInfo();
      } else {
        state.selectedId = null;
        state.dragging = null;
        state.panning = true;
        state.panStart = { x: t.clientX - state.pan.x, y: t.clientY - state.pan.y };
        hideSelectionInfo();
      }
      render();
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchDist = Math.sqrt(dx * dx + dy * dy);
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const sx = t.clientX - rect.left;
      const sy = t.clientY - rect.top;
      if (state.dragging) {
        const world = screenToWorld(sx, sy);
        const item = state.placedFurniture.find((f) => f.id === state.dragging.id);
        if (item) {
          item.x = snapToGrid(world.x - state.dragging.offsetX);
          item.y = snapToGrid(world.y - state.dragging.offsetY);
          render();
        }
      } else if (state.panning) {
        state.pan.x = t.clientX - state.panStart.x;
        state.pan.y = t.clientY - state.panStart.y;
        render();
      }
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (lastTouchDist > 0) {
        const scale = dist / lastTouchDist;
        state.zoom = clamp(state.zoom * scale, MIN_ZOOM, MAX_ZOOM);
        updateZoomLabel();
        render();
      }
      lastTouchDist = dist;
    }
  }

  function onTouchEnd(e) {
    state.dragging = null;
    state.panning = false;
    lastTouchDist = 0;
  }

  // ── Keyboard ──
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;

    const sel = state.placedFurniture.find((f) => f.id === state.selectedId);
    if (!sel) return;

    const step = e.shiftKey ? 1 : GRID_SIZE;
    switch (e.key) {
      case "ArrowLeft":  e.preventDefault(); sel.x -= step; break;
      case "ArrowRight": e.preventDefault(); sel.x += step; break;
      case "ArrowUp":    e.preventDefault(); sel.y -= step; break;
      case "ArrowDown":  e.preventDefault(); sel.y += step; break;
      case "r": case "R":
        sel.rotation = ((sel.rotation || 0) + (e.shiftKey ? -ROTATION_STEP : ROTATION_STEP)) % 360;
        if (sel.rotation < 0) sel.rotation += 360;
        break;
      case "Delete": case "Backspace":
        e.preventDefault();
        removePlacedItem(sel.id);
        return;
      case "Escape":
        state.selectedId = null;
        hideSelectionInfo();
        break;
    }
    if (state.gridSnap) {
      sel.x = snapToGrid(sel.x);
      sel.y = snapToGrid(sel.y);
    }
    updateSelectionInfo();
    render();
  });

  // ── Selection Info Panel ──
  function updateSelectionInfo() {
    const sel = state.placedFurniture.find((f) => f.id === state.selectedId);
    if (!sel) { hideSelectionInfo(); return; }
    const panel = $("#selectionInfo");
    panel.classList.remove("hidden");
    $("#selectionName").textContent = sel.name;
    $("#selectionSize").textContent =
      `${inchesToFeetStr(sel.width)} × ${inchesToFeetStr(sel.height)} | Rot: ${sel.rotation || 0}°`;
  }

  function hideSelectionInfo() {
    $("#selectionInfo").classList.add("hidden");
  }

  // ── Status Bar ──
  function setStatus(msg, type) {
    const el = $("#statusMsg");
    el.textContent = msg;
    el.style.color = type === "warning" ? "#f39c12" : type === "error" ? "#e74c3c" : "#a0a0b0";
  }

  // ── Sidebar: Walls UI ──
  function renderWallsUI() {
    const container = $("#wallsList");
    container.innerHTML = "";
    state.room.walls.forEach((wall, idx) => {
      const div = document.createElement("div");
      div.className = "wall-item";
      div.innerHTML = `
        <div class="wall-item-header">
          <strong>${wall.name}</strong>
          <button class="btn-icon btn-sm wall-remove" data-idx="${idx}" title="Remove wall">&times;</button>
        </div>
        <div class="mini-grid">
          <div><label>Length (in)</label><input type="number" class="wall-len" data-idx="${idx}" value="${wall.length}" min="1"></div>
          <div><label>Opening</label>
            <select class="wall-open-type" data-idx="${idx}">
              <option value="none" ${(!wall.openings || wall.openings.length === 0 || wall.openings[0].type === "none") ? "selected" : ""}>None</option>
              <option value="door" ${wall.openings && wall.openings[0] && wall.openings[0].type === "door" ? "selected" : ""}>Door</option>
              <option value="window" ${wall.openings && wall.openings[0] && wall.openings[0].type === "window" ? "selected" : ""}>Window</option>
              <option value="closet" ${wall.openings && wall.openings[0] && wall.openings[0].type === "closet" ? "selected" : ""}>Closet</option>
            </select>
          </div>
          <div><label>Open Start (in)</label><input type="number" class="wall-open-start" data-idx="${idx}" value="${wall.openings && wall.openings[0] ? wall.openings[0].start : 0}" min="0"></div>
          <div><label>Open Width (in)</label><input type="number" class="wall-open-width" data-idx="${idx}" value="${wall.openings && wall.openings[0] ? wall.openings[0].width : 36}" min="0"></div>
        </div>
      `;
      container.appendChild(div);
    });

    // Event listeners
    container.querySelectorAll(".wall-len").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const idx = +e.target.dataset.idx;
        state.room.walls[idx].length = +e.target.value;
        rebuildAndRender();
      });
    });
    container.querySelectorAll(".wall-open-type").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const idx = +e.target.dataset.idx;
        const wall = state.room.walls[idx];
        if (!wall.openings) wall.openings = [{ type: "none", start: 0, width: 36 }];
        wall.openings[0].type = e.target.value;
        rebuildAndRender();
      });
    });
    container.querySelectorAll(".wall-open-start").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const idx = +e.target.dataset.idx;
        const wall = state.room.walls[idx];
        if (!wall.openings) wall.openings = [{ type: "none", start: 0, width: 36 }];
        wall.openings[0].start = +e.target.value;
        rebuildAndRender();
      });
    });
    container.querySelectorAll(".wall-open-width").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const idx = +e.target.dataset.idx;
        const wall = state.room.walls[idx];
        if (!wall.openings) wall.openings = [{ type: "none", start: 0, width: 36 }];
        wall.openings[0].width = +e.target.value;
        rebuildAndRender();
      });
    });
    container.querySelectorAll(".wall-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = +e.target.dataset.idx;
        state.room.walls.splice(idx, 1);
        rebuildAndRender();
        renderWallsUI();
      });
    });
  }

  // ── Sidebar: Furniture UI ──
  function renderFurnitureUI() {
    const container = $("#furnitureList");
    container.innerHTML = "";
    state.furniturePalette.forEach((f, idx) => {
      const placed = state.placedFurniture.filter((p) => p.paletteIdx === idx).length;
      const div = document.createElement("div");
      div.className = "furniture-item";
      div.draggable = true;
      div.dataset.idx = idx;
      div.innerHTML = `
        <div class="color-swatch" style="background:${f.color}"></div>
        <div class="fi-info">
          <div class="fi-name">${f.name} <span class="fi-qty">(${placed}/${f.quantity})</span></div>
          <div class="fi-size">${inchesToFeetStr(f.width)} × ${inchesToFeetStr(f.height)}</div>
        </div>
        <div class="fi-actions">
          <button class="place-btn" data-idx="${idx}" title="Place in room">+</button>
          <button class="remove-palette-btn" data-idx="${idx}" title="Remove from palette">&times;</button>
        </div>
      `;
      container.appendChild(div);

      // Drag from palette to place
      div.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", idx.toString());
        e.dataTransfer.effectAllowed = "copy";
      });
    });

    container.querySelectorAll(".place-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = +e.target.dataset.idx;
        placeFurnitureFromPalette(idx);
      });
    });

    container.querySelectorAll(".remove-palette-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = +e.target.dataset.idx;
        // Remove all placed items referencing this palette item
        state.placedFurniture = state.placedFurniture.filter((p) => p.paletteIdx !== idx);
        state.furniturePalette.splice(idx, 1);
        // Re-index placed items
        state.placedFurniture.forEach((p) => {
          if (p.paletteIdx > idx) p.paletteIdx--;
        });
        renderFurnitureUI();
        render();
      });
    });
  }

  function placeFurnitureFromPalette(idx) {
    const def = state.furniturePalette[idx];
    if (!def) return;
    const placed = state.placedFurniture.filter((p) => p.paletteIdx === idx).length;
    if (placed >= def.quantity) {
      setStatus(`All ${def.quantity} ${def.name}(s) already placed`, "warning");
      return;
    }
    const rb = state.roomBounds;
    const cx = rb ? rb.width / 2 : 60;
    const cy = rb ? rb.height / 2 : 60;
    const item = {
      id: uid(),
      paletteIdx: idx,
      name: def.name,
      width: def.width,
      height: def.height,
      color: def.color,
      x: snapToGrid(cx),
      y: snapToGrid(cy),
      rotation: 0,
    };
    state.placedFurniture.push(item);
    state.selectedId = item.id;
    updateSelectionInfo();
    renderFurnitureUI();
    render();
    setStatus(`Placed ${def.name} — drag to position`, "ok");
  }

  // Drop onto canvas
  function setupCanvasDrop() {
    const container = document.getElementById("canvasContainer");
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    container.addEventListener("drop", (e) => {
      e.preventDefault();
      const idx = +e.dataTransfer.getData("text/plain");
      if (isNaN(idx)) return;
      const def = state.furniturePalette[idx];
      if (!def) return;
      const placed = state.placedFurniture.filter((p) => p.paletteIdx === idx).length;
      if (placed >= def.quantity) {
        setStatus(`All ${def.quantity} ${def.name}(s) already placed`, "warning");
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      const item = {
        id: uid(),
        paletteIdx: idx,
        name: def.name,
        width: def.width,
        height: def.height,
        color: def.color,
        x: snapToGrid(world.x),
        y: snapToGrid(world.y),
        rotation: 0,
      };
      state.placedFurniture.push(item);
      state.selectedId = item.id;
      updateSelectionInfo();
      renderFurnitureUI();
      render();
      setStatus(`Placed ${def.name}`, "ok");
    });
  }

  function removePlacedItem(id) {
    state.placedFurniture = state.placedFurniture.filter((f) => f.id !== id);
    state.selectedId = null;
    hideSelectionInfo();
    renderFurnitureUI();
    render();
    setStatus("Item removed", "ok");
  }

  // ── Rebuild helper ──
  function rebuildAndRender() {
    buildRoomGeometry();
    render();
  }

  // ── CSV Import ──
  function importRoomCSV(text) {
    const rows = parseCSV(text);
    if (rows.length === 0) { setStatus("No valid room data in CSV", "error"); return; }
    state.room.walls = rows.map((r) => ({
      name: r.wall_name || "wall",
      length: +(r.length_inches || 120),
      openings: [{
        type: (r.opening_type || "none").toLowerCase(),
        start: +(r.opening_start_inches || 0),
        width: +(r.opening_width_inches || 0),
      }],
    }));
    buildRoomGeometry();
    renderWallsUI();
    fitToView();
    setStatus("Room loaded from CSV", "ok");
  }

  function importFurnitureCSV(text) {
    const rows = parseCSV(text);
    if (rows.length === 0) { setStatus("No valid furniture data in CSV", "error"); return; }
    state.furniturePalette = rows.map((r, i) => ({
      name: r.item_name || `Item ${i + 1}`,
      width: +(r.length_inches || 24),
      height: +(r.width_inches || 24),
      quantity: +(r.quantity || 1),
      color: r.color || DEFAULT_FURNITURE_COLORS[i % DEFAULT_FURNITURE_COLORS.length],
    }));
    state.placedFurniture = [];
    renderFurnitureUI();
    render();
    setStatus("Furniture loaded from CSV", "ok");
  }

  // ── Export ──
  function exportImage() {
    // Render at high res
    const origZoom = state.zoom;
    const origPan = { ...state.pan };
    const rb = state.roomBounds;
    if (!rb) { setStatus("No room to export", "error"); return; }

    const padding = 40;
    const exportScale = 3;
    const w = (rb.width + padding * 2) * exportScale;
    const h = (rb.height + padding * 2) * exportScale;

    const offscreen = document.createElement("canvas");
    offscreen.width = w;
    offscreen.height = h;
    const offCtx = offscreen.getContext("2d");

    // Swap context temporarily
    const origCtx = ctx;
    const origCanvas = canvas;

    // We'll just re-render onto the offscreen canvas
    offCtx.fillStyle = "#1a1a2e";
    offCtx.fillRect(0, 0, w, h);
    offCtx.save();
    offCtx.translate(padding * exportScale, padding * exportScale);
    offCtx.scale(exportScale, exportScale);

    // Re-draw using offscreen context
    state.zoom = 1;
    state.pan = { x: 0, y: 0 };

    // Manually draw to offscreen
    drawToContext(offCtx);

    offCtx.restore();

    // Restore
    state.zoom = origZoom;
    state.pan = origPan;

    // Download
    const link = document.createElement("a");
    link.download = `${state.room.name || "room"}-layout.png`;
    link.href = offscreen.toDataURL("image/png");
    link.click();
    setStatus("Image exported", "ok");
  }

  function drawToContext(c) {
    // Grid
    if (state.roomBounds) {
      const rb = state.roomBounds;
      c.strokeStyle = "rgba(255,255,255,0.04)";
      c.lineWidth = 0.5;
      for (let x = 0; x <= rb.width; x += GRID_SIZE) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, rb.height); c.stroke();
      }
      for (let y = 0; y <= rb.height; y += GRID_SIZE) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(rb.width, y); c.stroke();
      }
      c.strokeStyle = "rgba(255,255,255,0.08)";
      c.lineWidth = 0.8;
      for (let x = 0; x <= rb.width; x += 12) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, rb.height); c.stroke();
      }
      for (let y = 0; y <= rb.height; y += 12) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(rb.width, y); c.stroke();
      }
    }

    // Walls
    if (state.wallSegments.length > 0) {
      c.beginPath();
      c.moveTo(state.wallSegments[0].x1, state.wallSegments[0].y1);
      state.wallSegments.forEach((s) => c.lineTo(s.x2, s.y2));
      c.closePath();
      c.fillStyle = "#1a1a2e";
      c.fill();
      c.lineWidth = WALL_THICKNESS;
      c.strokeStyle = "#4a4a6a";
      c.lineCap = "round";
      c.lineJoin = "round";
      c.beginPath();
      state.wallSegments.forEach((s, i) => {
        if (i === 0) c.moveTo(s.x1, s.y1);
        c.lineTo(s.x2, s.y2);
      });
      c.closePath();
      c.stroke();

      c.font = "bold 5px sans-serif";
      c.fillStyle = "#a0a0b0";
      c.textAlign = "center";
      c.textBaseline = "middle";
      state.wallSegments.forEach((s) => {
        const mx = (s.x1 + s.x2) / 2;
        const my = (s.y1 + s.y2) / 2;
        const dx = s.x2 - s.x1;
        const dy = s.y2 - s.y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        const nx = -dy / len * 10;
        const ny = dx / len * 10;
        c.fillText(`${s.name.toUpperCase()} ${inchesToFeetStr(len)}`, mx + nx, my + ny);
      });
    }

    // Openings
    state.openingRects.forEach((op) => {
      const color = OPENING_COLORS[op.type] || "#888";
      c.save();
      c.translate(op.cx, op.cy);
      const angle = Math.atan2(op.alongY, op.alongX);
      c.rotate(angle);
      c.fillStyle = "#1a1a2e";
      c.fillRect(-op.width / 2, -WALL_THICKNESS / 2 - 1, op.width, WALL_THICKNESS + 2);
      c.strokeStyle = color;
      c.lineWidth = 2;
      c.setLineDash([3, 3]);
      c.strokeRect(-op.width / 2, -WALL_THICKNESS / 2, op.width, WALL_THICKNESS);
      c.setLineDash([]);
      if (op.type === "door") {
        c.beginPath();
        c.strokeStyle = color;
        c.lineWidth = 1;
        c.setLineDash([2, 2]);
        c.arc(-op.width / 2, 0, op.width, -Math.PI / 2, 0);
        c.stroke();
        c.setLineDash([]);
      }
      if (op.type === "window") {
        c.strokeStyle = color;
        c.lineWidth = 1;
        const hw = op.width / 2;
        const ht = WALL_THICKNESS / 2;
        c.beginPath();
        c.moveTo(-hw, -ht); c.lineTo(hw, ht);
        c.moveTo(hw, -ht); c.lineTo(-hw, ht);
        c.stroke();
      }
      c.fillStyle = color;
      c.font = "bold 4px sans-serif";
      c.textAlign = "center";
      c.textBaseline = "bottom";
      c.fillText(op.type.toUpperCase(), 0, -WALL_THICKNESS / 2 - 3);
      c.restore();
    });

    // Furniture
    state.placedFurniture.forEach((item) => {
      c.save();
      c.translate(item.x, item.y);
      c.rotate(degToRad(item.rotation || 0));
      const hw = item.width / 2;
      const hh = item.height / 2;
      c.fillStyle = item.color || "#e94560";
      c.globalAlpha = 0.85;
      c.beginPath();
      c.roundRect(-hw, -hh, item.width, item.height, 2);
      c.fill();
      c.globalAlpha = 1;
      c.strokeStyle = "rgba(255,255,255,0.3)";
      c.lineWidth = 1;
      c.beginPath();
      c.roundRect(-hw, -hh, item.width, item.height, 2);
      c.stroke();
      c.fillStyle = "#fff";
      c.font = `bold ${Math.min(5, Math.min(item.width, item.height) * 0.3)}px sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(item.name.length > 12 ? item.name.slice(0, 11) + "…" : item.name, 0, -2);
      c.fillStyle = "rgba(255,255,255,0.6)";
      c.font = `${Math.min(4, Math.min(item.width, item.height) * 0.2)}px sans-serif`;
      c.fillText(`${inchesToFeetStr(item.width)} × ${inchesToFeetStr(item.height)}`, 0, 3);
      c.fillStyle = "rgba(255,255,255,0.5)";
      c.beginPath();
      c.moveTo(0, -hh + 1); c.lineTo(-2, -hh + 4); c.lineTo(2, -hh + 4); c.closePath();
      c.fill();
      c.restore();
    });
  }

  function exportCSV() {
    if (state.placedFurniture.length === 0) {
      setStatus("No furniture placed to export", "error");
      return;
    }
    let csv = "item_name,x_inches,y_inches,width_inches,height_inches,rotation_degrees,color\n";
    state.placedFurniture.forEach((f) => {
      csv += `${f.name},${Math.round(f.x)},${Math.round(f.y)},${f.width},${f.height},${f.rotation || 0},${f.color}\n`;
    });
    const blob = new Blob([csv], { type: "text/csv" });
    const link = document.createElement("a");
    link.download = `${state.room.name || "room"}-furniture.csv`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setStatus("CSV exported", "ok");
  }

  // ── Save / Load Layout ──
  function saveLayout() {
    const data = {
      version: 1,
      room: state.room,
      furniturePalette: state.furniturePalette,
      placedFurniture: state.placedFurniture,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.download = `${state.room.name || "room"}-layout.json`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setStatus("Layout saved", "ok");
  }

  function loadLayout(text) {
    try {
      const data = JSON.parse(text);
      if (!data.room || !data.furniturePalette) throw new Error("Invalid format");
      state.room = data.room;
      state.furniturePalette = data.furniturePalette;
      state.placedFurniture = data.placedFurniture || [];
      state.nextId = Math.max(1, ...state.placedFurniture.map((f) => f.id + 1));
      buildRoomGeometry();
      renderWallsUI();
      renderFurnitureUI();
      fitToView();
      setStatus("Layout loaded", "ok");
    } catch (e) {
      setStatus("Failed to load layout: " + e.message, "error");
    }
  }

  // ── Sample Data ──
  function loadSampleRoom() {
    state.room = {
      name: "Living Room",
      walls: [
        { name: "north", length: 180, openings: [{ type: "window", start: 48, width: 60 }] },
        { name: "east",  length: 144, openings: [{ type: "none", start: 0, width: 0 }] },
        { name: "south", length: 180, openings: [{ type: "door", start: 72, width: 36 }] },
        { name: "west",  length: 144, openings: [{ type: "closet", start: 24, width: 48 }] },
      ],
    };
    state.furniturePalette = [
      { name: "Sofa",         width: 84, height: 36, quantity: 1, color: "#3498db" },
      { name: "Coffee Table", width: 48, height: 24, quantity: 1, color: "#e67e22" },
      { name: "Armchair",     width: 36, height: 33, quantity: 2, color: "#2ecc71" },
      { name: "TV Stand",     width: 60, height: 18, quantity: 1, color: "#9b59b6" },
      { name: "Bookshelf",    width: 36, height: 12, quantity: 1, color: "#e74c3c" },
      { name: "End Table",    width: 18, height: 18, quantity: 2, color: "#1abc9c" },
      { name: "Floor Lamp",   width: 12, height: 12, quantity: 2, color: "#f39c12" },
      { name: "Rug",          width: 96, height: 60, quantity: 1, color: "#636e72" },
    ];
    state.placedFurniture = [];
    state.selectedId = null;
    $("#roomName").value = state.room.name;
    buildRoomGeometry();
    renderWallsUI();
    renderFurnitureUI();
    fitToView();
    setStatus("Sample living room loaded — click + or drag items to place furniture", "ok");
  }

  // ── Modal helpers ──
  function showModal(title, bodyHTML, onOk) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHTML;
    $("#modal").classList.remove("hidden");
    const handler = () => {
      onOk();
      $("#modal").classList.add("hidden");
      $("#modalOk").removeEventListener("click", handler);
    };
    $("#modalOk").addEventListener("click", handler);
  }

  function hideModal() {
    $("#modal").classList.add("hidden");
  }

  // Add wall modal
  function showAddWallModal() {
    showModal("Add Wall", `
      <div class="input-row"><label>Wall Name</label><input type="text" id="newWallName" value="wall" placeholder="e.g. north"></div>
      <div class="input-row"><label>Length (inches)</label><input type="number" id="newWallLen" value="120" min="1"></div>
    `, () => {
      const name = $("#newWallName").value.trim() || "wall";
      const length = +($("#newWallLen").value) || 120;
      state.room.walls.push({ name, length, openings: [{ type: "none", start: 0, width: 0 }] });
      rebuildAndRender();
      renderWallsUI();
    });
  }

  // Add furniture modal
  function showAddFurnitureModal() {
    showModal("Add Furniture Item", `
      <div class="input-row"><label>Name</label><input type="text" id="newFurnName" value="" placeholder="e.g. Desk"></div>
      <div class="input-row"><label>Width (inches)</label><input type="number" id="newFurnW" value="48" min="1"></div>
      <div class="input-row"><label>Depth (inches)</label><input type="number" id="newFurnH" value="24" min="1"></div>
      <div class="input-row"><label>Quantity</label><input type="number" id="newFurnQty" value="1" min="1" max="20"></div>
      <div class="input-row"><label>Color</label><input type="color" id="newFurnColor" value="${DEFAULT_FURNITURE_COLORS[state.furniturePalette.length % DEFAULT_FURNITURE_COLORS.length]}"></div>
    `, () => {
      const name = $("#newFurnName").value.trim() || "Item";
      const width = +($("#newFurnW").value) || 48;
      const height = +($("#newFurnH").value) || 24;
      const qty = +($("#newFurnQty").value) || 1;
      const color = $("#newFurnColor").value;
      state.furniturePalette.push({ name, width, height, quantity: qty, color });
      renderFurnitureUI();
    });
  }

  // ── Wire up all UI ──
  function initUI() {
    // Toolbar
    $("#gridSnap").addEventListener("change", (e) => {
      state.gridSnap = e.target.checked;
      setStatus(state.gridSnap ? "Grid snap ON (6\" grid)" : "Grid snap OFF", "ok");
    });
    $("#showMeasurements").addEventListener("change", (e) => {
      state.showMeasurements = e.target.checked;
      render();
    });
    $("#zoomIn").addEventListener("click", () => {
      state.zoom = clamp(state.zoom + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
      updateZoomLabel();
      render();
    });
    $("#zoomOut").addEventListener("click", () => {
      state.zoom = clamp(state.zoom - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
      updateZoomLabel();
      render();
    });
    $("#zoomFit").addEventListener("click", fitToView);

    // Room panel
    $("#roomName").addEventListener("change", (e) => { state.room.name = e.target.value; });
    $("#importRoomCSV").addEventListener("click", () => $("#roomFileInput").click());
    $("#roomFileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then(importRoomCSV);
      e.target.value = "";
    });
    $("#importFurnitureCSV").addEventListener("click", () => $("#furnitureFileInput").click());
    $("#furnitureFileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then(importFurnitureCSV);
      e.target.value = "";
    });
    $("#loadSample").addEventListener("click", loadSampleRoom);

    // Walls / Furniture
    $("#addWall").addEventListener("click", showAddWallModal);
    $("#addFurniture").addEventListener("click", showAddFurnitureModal);

    // Selection actions
    $("#rotateCW").addEventListener("click", () => {
      const sel = state.placedFurniture.find((f) => f.id === state.selectedId);
      if (sel) { sel.rotation = ((sel.rotation || 0) + ROTATION_STEP) % 360; updateSelectionInfo(); render(); }
    });
    $("#rotateCCW").addEventListener("click", () => {
      const sel = state.placedFurniture.find((f) => f.id === state.selectedId);
      if (sel) { sel.rotation = ((sel.rotation || 0) - ROTATION_STEP + 360) % 360; updateSelectionInfo(); render(); }
    });
    $("#deleteItem").addEventListener("click", () => {
      if (state.selectedId !== null) removePlacedItem(state.selectedId);
    });

    // Export / Save
    $("#exportImage").addEventListener("click", exportImage);
    $("#exportCSV").addEventListener("click", exportCSV);
    $("#saveLayout").addEventListener("click", saveLayout);
    $("#loadLayout").addEventListener("click", () => $("#layoutFileInput").click());
    $("#layoutFileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then(loadLayout);
      e.target.value = "";
    });

    // Modal
    $("#modalClose").addEventListener("click", hideModal);
    $("#modalCancel").addEventListener("click", hideModal);
  }

  // ── roundRect polyfill ──
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      if (typeof r === "number") r = [r, r, r, r];
      this.moveTo(x + r[0], y);
      this.lineTo(x + w - r[1], y);
      this.quadraticCurveTo(x + w, y, x + w, y + r[1]);
      this.lineTo(x + w, y + h - r[2]);
      this.quadraticCurveTo(x + w, y + h, x + w - r[2], y + h);
      this.lineTo(x + r[3], y + h);
      this.quadraticCurveTo(x, y + h, x, y + h - r[3]);
      this.lineTo(x, y + r[0]);
      this.quadraticCurveTo(x, y, x + r[0], y);
      this.closePath();
    };
  }

  // ── Boot ──
  function init() {
    resizeCanvas();
    setupCanvasEvents();
    setupCanvasDrop();
    initUI();
    window.addEventListener("resize", resizeCanvas);
    setStatus("Load a sample room or import CSV files to begin", "ok");
  }

  init();
})();
